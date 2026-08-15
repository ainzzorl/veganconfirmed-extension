// Vegan Confirmed — restaurant menu analysis on Google Maps.
//
// Google Maps is a single-page app whose place panel is virtualized and whose
// class names are obfuscated and change often, so this script deliberately does
// as little DOM interpretation as possible. It only:
//   1. recognises that a place page is open and identifies it stably,
//   2. gets the menu actually rendered into the panel (activate the Menu tab,
//      click through the sub-tabs a menu is split across, scroll to force
//      lazy-loaded content in),
//   3. hands the panel's *visible* text to the backend.
// Turning that text into structured dishes is the model's job (see the
// backend's services/menu_prompt.py), which keeps this file resilient to Maps'
// markup changing underneath it.
//
// This file is self-contained rather than reusing content.js's markdown
// helpers: content scripts registered in separate manifest entries share an
// isolated world but have no guaranteed load order, so depending on content.js
// having run first would be a race.
//
// Everything lives inside an IIFE for the same reason. All of this extension's
// content scripts share ONE global scope in a given frame, so a top-level
// `let`/`const` here whose name also appears in content.js (`enableLogging`,
// `isAnalyzing`, ...) is a redeclaration: the whole file dies with
// "Identifier X has already been declared" before a line of it runs. Declaring
// nothing globally makes that impossible rather than a naming convention
// somebody has to remember.

(function () {
  // Global flag to control console logging (mirrors content.js).
  let enableLogging = false;

  function log(...args) {
    if (enableLogging) {
      console.log("Vegan Confirmed (Maps):", ...args);
    }
  }

  // Hosts this script is injected on still include non-place Google Maps URLs
  // (search results, directions), so every entry point re-checks the path.
  const PLACE_PATH_RE = /\/maps\/place\//;

  // The stable place identifier Maps puts in the `data=` blob: either the
  // "feature id" hex pair or a ChIJ-style place id. The rest of a Maps URL (the
  // `@lat,lng,zoom` viewport especially) changes as the user pans, so it is
  // useless as a cache key.
  //
  // A URL frequently carries SEVERAL of these, because Maps retains the
  // previously viewed place as context. Navigating Clara's Junction -> a nearby
  // address yields:
  //   !3m6!1s<clara's id>!2sClara's+Junction!...!3m5!1s<address id>!...
  // The place actually on screen is the LAST one; taking the first served the
  // previous restaurant's cached analysis under the new place's name.
  const FTID_RE = /!1s(0x[0-9a-f]+:0x[0-9a-f]+|ChI[A-Za-z0-9_-]+)/gi;

  // Words that identify the Menu tab across the locales Maps is commonly used in.
  // A miss here is not fatal — we still analyze whatever the panel is showing —
  // so this list favours brevity over completeness.
  const MENU_TAB_WORDS = [
    "menu",
    "menú",
    "menù",
    "carta",
    "carte",
    "speisekarte",
    "cardápio",
    "menukaart",
    "matsedel",
    "ruokalista",
    "jadłospis",
    "меню",
    "メニュー",
    "菜单",
    "菜單",
  ];

  // Keep in step with MENU_CONTENT_CHAR_LIMIT in the backend's menu_prompt.py.
  // Trimming here saves sending text the backend would only discard.
  const MAX_CONTENT_CHARS = 20000;

  // A place's menu is frequently split across several sub-tabs — "Lunch",
  // "Dinner", "Drinks", a separate bar menu — and Maps renders only the
  // selected one. Reading the panel as found therefore judged a restaurant on
  // whichever sub-tab happened to be open, so all of them are swept. These caps
  // stop a place with a dozen menus from turning one click into minutes of
  // clicking and scrolling; a menu that hits them is truncated, not abandoned.
  const MAX_MENU_SECTIONS = 10;
  const MENU_SECTION_BUDGET_MS = 45000;

  // Lines that are pure Maps chrome. Dropped to keep the payload focused; the
  // backend prompt tolerates leftovers, so this is an optimization, not a
  // correctness requirement.
  const NOISE_LINE_RE =
    /^(directions|save|nearby|send to phone|share|suggest an edit|add a (photo|label)|claim this business|write a review|all reviews|see photos|photos|street view|website|call|order online|reserve a table|add your business|report a problem)$/i;

  let isAnalyzing = false;
  let chipEl = null;
  let lastPlaceKey = null;

  // --- place identity ------------------------------------------------------

  function isPlacePage(url = window.location.href) {
    return PLACE_PATH_RE.test(url);
  }

  // A stable per-restaurant key, used for caching. Falls back to the place name
  // slug when the URL has no feature id yet (Maps adds it a moment after
  // navigation), which is still far more stable than the raw URL.
  function getPlaceKey(url = window.location.href) {
    // Last match, not first — see FTID_RE.
    const ftids = [...url.matchAll(FTID_RE)];
    if (ftids.length > 0) {
      return ftids[ftids.length - 1][1].toLowerCase();
    }

    const nameSegment = url.match(/\/maps\/place\/([^/@?]+)/);
    if (nameSegment) {
      return `name:${decodeURIComponent(nameSegment[1]).replace(/\+/g, " ")}`;
    }

    return null;
  }

  function getPlaceName(panel) {
    const heading = panel && panel.querySelector("h1");
    if (heading && heading.textContent.trim()) {
      return heading.textContent.trim();
    }

    const nameSegment = window.location.href.match(/\/maps\/place\/([^/@?]+)/);
    if (nameSegment) {
      return decodeURIComponent(nameSegment[1]).replace(/\+/g, " ");
    }

    return document.title.replace(/\s*[-–]\s*Google Maps\s*$/i, "").trim();
  }

  // --- panel discovery -----------------------------------------------------

  // The place panel is the `role="main"` region labelled with the place name.
  // Anchoring on roles/aria rather than class names is the whole point: Maps'
  // generated class names change, its accessibility tree does not.
  function findPlacePanel() {
    const candidates = Array.from(document.querySelectorAll('div[role="main"]'));
    if (candidates.length === 0) {
      return null;
    }

    const placeName = getPlaceName(null);
    const byLabel = candidates.find((el) => {
      const label = el.getAttribute("aria-label");
      return label && placeName && label.trim() === placeName;
    });
    if (byLabel) {
      return byLabel;
    }

    // Otherwise take the region that actually holds a place heading, preferring
    // the last one (Maps keeps earlier panels around when you drill in).
    const withHeading = candidates.filter((el) => el.querySelector("h1"));
    return withHeading.length ? withHeading[withHeading.length - 1] : candidates[0];
  }

  function findScrollableAncestor(element) {
    let node = element;
    while (node && node !== document.body) {
      const overflowY = window.getComputedStyle(node).overflowY;
      if (
        (overflowY === "auto" || overflowY === "scroll") &&
        node.scrollHeight > node.clientHeight + 1
      ) {
        return node;
      }
      node = node.parentElement;
    }
    return element;
  }

  // --- waiting for the DOM to settle --------------------------------------

  // Maps loads panel content asynchronously with no completion signal, so treat
  // "no mutations for `quietMs`" as done, with a hard ceiling so a page that
  // never stops animating cannot hang the analysis.
  function waitForSettle(target, { quietMs = 500, timeoutMs = 5000 } = {}) {
    return new Promise((resolve) => {
      let quietTimer = null;
      let hardTimer = null;
      let finished = false;

      const observer = new MutationObserver(() => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, quietMs);
      });

      function finish() {
        if (finished) {
          return;
        }
        finished = true;
        clearTimeout(quietTimer);
        clearTimeout(hardTimer);
        observer.disconnect();
        resolve();
      }

      observer.observe(target, {
        childList: true,
        subtree: true,
        characterData: true,
      });

      quietTimer = setTimeout(finish, quietMs);
      hardTimer = setTimeout(finish, timeoutMs);
    });
  }

  // --- getting the menu on screen -----------------------------------------

  function findMenuTab(panel) {
    const tabs = panel.querySelectorAll('[role="tab"]');
    for (const tab of tabs) {
      const label = `${tab.getAttribute("aria-label") || ""} ${
        tab.textContent || ""
      }`.toLowerCase();
      if (MENU_TAB_WORDS.some((word) => label.includes(word))) {
        return tab;
      }
    }
    return null;
  }

  // Returns the Menu tab element (so the sweep below can tell the place's own
  // tab row apart from the menu's), or null when the place has no Menu tab.
  async function activateMenuTab(panel) {
    const tab = findMenuTab(panel);
    if (!tab) {
      log("no menu tab found; analyzing the panel as shown");
      return null;
    }

    if (tab.getAttribute("aria-selected") === "true") {
      log("menu tab already active");
      return tab;
    }

    log("activating menu tab");
    tab.click();
    await waitForSettle(panel, { quietMs: 500, timeoutMs: 6000 });
    return tab;
  }

  // --- menu sub-tabs -------------------------------------------------------

  // Maps builds "show one of these N views" as either a tablist or a chip row
  // of radios — it uses the latter for review topics — and which one a given
  // menu gets is not something to rely on. Accepting both roles means Maps
  // switching from one to the other costs nothing here.
  const SWITCHER_SELECTOR = '[role="tablist"], [role="radiogroup"]';
  const SWITCHER_OPTION_SELECTOR = '[role="tab"], [role="radio"]';

  // Maps keeps the sub-tabs you are not looking at in the DOM, so an option is
  // only worth clicking if it is actually on screen. This walks to the root
  // rather than reading `offsetParent` or `getClientRects` deliberately: those
  // need layout, which jsdom (the Node test harness) does not have, and there
  // they report *every* element as hidden. Only an explicit hide counts, so an
  // unfamiliar way of hiding something costs us a redundant click, never a
  // dropped menu.
  function isRendered(element) {
    let node = element;
    while (node && node.nodeType === Node.ELEMENT_NODE) {
      if (node.getAttribute("aria-hidden") === "true") {
        return false;
      }
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") {
        return false;
      }
      node = node.parentElement;
    }
    return true;
  }

  function isOptionSelected(option) {
    return (
      option.getAttribute("aria-selected") === "true" ||
      option.getAttribute("aria-checked") === "true"
    );
  }

  function optionLabel(option) {
    const text = (option.textContent || "").trim();
    return text || (option.getAttribute("aria-label") || "").trim();
  }

  // The container an option renders into, when Maps wires `aria-controls` up.
  // Reading just that container would keep the place's header, hours and
  // reviews from being repeated once per section — but as of writing Maps uses
  // neither `aria-controls` nor `role="tabpanel"` anywhere in the place panel,
  // so in practice this returns null and the whole panel is read instead (which
  // joinSections is built to cope with). It stays because it costs four lines
  // and is the standard markup for exactly this.
  function findControlledRegion(option) {
    const id = option.getAttribute("aria-controls");
    return (id && document.getElementById(id)) || null;
  }

  // The sub-tabs *within* the menu. Unrelated groups elsewhere in the panel —
  // the review topic chips especially — are kept out by scoping to the region
  // the Menu tab controls and by only ever calling this once that tab is open.
  function findMenuSectionOptions(panel, menuTab) {
    const scope = findControlledRegion(menuTab) || panel;

    for (const switcher of scope.querySelectorAll(SWITCHER_SELECTOR)) {
      // Any group holding the Menu tab itself is the place's own row: clicking
      // through it would walk off the menu into Overview and Reviews.
      if (switcher.contains(menuTab) || !isRendered(switcher)) {
        continue;
      }
      const options = Array.from(
        switcher.querySelectorAll(SWITCHER_OPTION_SELECTOR)
      ).filter(isRendered);
      // One option is not a choice — nothing is hidden behind it.
      if (options.length > 1) {
        return options;
      }
    }

    return [];
  }

  async function activateSection(panel, option) {
    if (isOptionSelected(option)) {
      return;
    }
    option.click();
    await waitForSettle(panel, { quietMs: 400, timeoutMs: 4000 });
  }

  // Menu items are lazy-loaded as the panel scrolls, so page to the bottom until
  // the scroll height stops growing, then restore the user's position.
  async function scrollToLoad(panel) {
    const scroller = findScrollableAncestor(panel);
    const originalTop = scroller.scrollTop;
    let lastHeight = -1;

    for (let step = 0; step < 12; step += 1) {
      if (scroller.scrollHeight === lastHeight) {
        break;
      }
      lastHeight = scroller.scrollHeight;
      scroller.scrollTop = scroller.scrollHeight;
      await waitForSettle(panel, { quietMs: 350, timeoutMs: 2500 });
    }

    scroller.scrollTop = originalTop;
  }

  // --- extraction ----------------------------------------------------------

  // Tags that force a line break in the textContent fallback below, and tags
  // whose contents are never user-visible text.
  const BLOCK_TAGS = new Set([
    "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BR", "BUTTON", "DD", "DIV",
    "DL", "DT", "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2",
    "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P",
    "PRE", "SECTION", "TABLE", "TD", "TH", "TR", "UL",
  ]);
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG"]);

  // Approximate `innerText` for environments that do not implement it (jsdom,
  // used by the Node test/eval harness). Only the line-breaking behaviour is
  // reproduced — a headless DOM has no layout, so visibility cannot be honoured.
  function textWithLineBreaks(node, out) {
    if (node.nodeType === Node.TEXT_NODE) {
      out.push(node.textContent);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE || SKIP_TAGS.has(node.tagName)) {
      return;
    }

    const isBlock = BLOCK_TAGS.has(node.tagName);
    if (isBlock) {
      out.push("\n");
    }
    for (const child of node.childNodes) {
      textWithLineBreaks(child, out);
    }
    if (isBlock) {
      out.push("\n");
    }
  }

  // `innerText` (not textContent) is preferred deliberately: it reflects what is
  // actually rendered, so collapsed panels and off-screen duplicate states are
  // excluded for free — the same noise content.js strips with an
  // `[aria-hidden="true"]` selector.
  function extractPanelText(panel) {
    let raw = panel.innerText;
    if (typeof raw !== "string") {
      const parts = [];
      textWithLineBreaks(panel, parts);
      raw = parts.join("");
    }

    const lines = [];
    let previous = null;

    for (const rawLine of raw.split("\n")) {
      const line = rawLine.trim();
      if (!line || NOISE_LINE_RE.test(line)) {
        continue;
      }
      // Maps repeats labels (icon + text, rating + rating) constantly.
      if (line === previous) {
        continue;
      }
      lines.push(line);
      previous = line;
    }

    return lines.join("\n").slice(0, MAX_CONTENT_CHARS);
  }

  // Unless Maps gave a section a container of its own, each one is read from the
  // whole panel, so every section repeats the place's header and footer verbatim
  // with only the dishes in between differing. The lines that *every* section
  // shares at each end are exactly that chrome, so they are emitted once around
  // the sections instead of once per section.
  //
  // Comparing across all sections rather than trimming each against the first is
  // what makes this safe: two menus that happen to end with the same dish keep
  // it on both, because a third menu that does not end with it stops the match
  // there. Nothing is ever dropped — a line only disappears from a section when
  // it appears in the shared prefix or suffix, which are still emitted.
  function splitSharedEdges(texts) {
    const lists = texts.map((text) => text.split("\n"));
    const shortest = Math.min(...lists.map((lines) => lines.length));

    let prefix = 0;
    while (
      prefix < shortest &&
      lists.every((lines) => lines[prefix] === lists[0][prefix])
    ) {
      prefix += 1;
    }

    // Bounded by what the prefix already claimed, so no line is emitted twice.
    let suffix = 0;
    while (
      suffix < shortest - prefix &&
      lists.every(
        (lines) =>
          lines[lines.length - 1 - suffix] ===
          lists[0][lists[0].length - 1 - suffix]
      )
    ) {
      suffix += 1;
    }

    return {
      prefix: lists[0].slice(0, prefix),
      suffix: suffix > 0 ? lists[0].slice(lists[0].length - suffix) : [],
      middles: lists.map((lines) => lines.slice(prefix, lines.length - suffix)),
    };
  }

  function joinSections(sections) {
    if (sections.length === 0) {
      return "";
    }

    // With one section there is no repetition to collapse, and every line is
    // "shared", so the comparison above would empty it out.
    if (sections.length === 1) {
      const { name, text } = sections[0];
      return (name ? `## ${name}\n${text}` : text).slice(0, MAX_CONTENT_CHARS);
    }

    const { prefix, suffix, middles } = splitSharedEdges(
      sections.map((section) => section.text)
    );

    // A section whose middle is empty changed nothing on screen; its name is
    // still worth emitting, as it tells the model that menu exists.
    const blocks = sections.map(({ name }, index) =>
      (name ? [`## ${name}`] : []).concat(middles[index]).join("\n")
    );

    return [prefix.join("\n"), blocks.join("\n\n"), suffix.join("\n")]
      .filter((part) => part.trim())
      .join("\n\n")
      .slice(0, MAX_CONTENT_CHARS);
  }

  // Activating a tab rebuilds the panel rather than hiding the old one — clicking
  // the place's About tab replaces the whole region, h1 and all — so an element
  // captured before a click can be detached by the time the sweep comes back to
  // it, and clicking a detached node does nothing at all. Everything is
  // therefore re-resolved by position on every pass rather than held across one.
  function resolveSections(panel) {
    const livePanel = panel && panel.isConnected ? panel : findPlacePanel();
    if (!livePanel) {
      return { panel: null, options: [] };
    }

    const menuTab = findMenuTab(livePanel);
    return {
      panel: livePanel,
      options: menuTab ? findMenuSectionOptions(livePanel, menuTab) : [],
    };
  }

  async function extractMenuSections(panel, menuTab, onProgress) {
    const options = menuTab ? findMenuSectionOptions(panel, menuTab) : [];

    if (options.length === 0) {
      await scrollToLoad(panel);
      return { content: extractPanelText(panel), sections: [] };
    }

    log(`menu split across ${options.length} sections`, options.map(optionLabel));

    const total = Math.min(options.length, MAX_MENU_SECTIONS);
    // By position, for the same reason: the element itself will not survive.
    const restoreTo = options.findIndex(isOptionSelected);
    const deadline = Date.now() + MENU_SECTION_BUDGET_MS;
    const sections = [];
    let activePanel = panel;
    let collectedChars = 0;

    for (let index = 0; index < total; index += 1) {
      const live = resolveSections(activePanel);
      const option = live.options[index];
      if (!option) {
        log("the sub-tabs changed under us; keeping what was read so far");
        break;
      }
      activePanel = live.panel;

      if (onProgress) {
        onProgress(index + 1, total);
      }

      await activateSection(activePanel, option);
      await scrollToLoad(activePanel);

      const text = extractPanelText(findControlledRegion(option) || activePanel);
      sections.push({ name: optionLabel(option), text: text });
      collectedChars += text.length;

      if (Date.now() > deadline || collectedChars >= MAX_CONTENT_CHARS) {
        log("stopping the section sweep early: budget reached");
        break;
      }
    }

    // Leave the panel on the sub-tab the user had open, the same way
    // scrollToLoad puts their scroll position back.
    if (restoreTo >= 0) {
      const live = resolveSections(activePanel);
      if (live.options[restoreTo]) {
        await activateSection(live.panel, live.options[restoreTo]);
      }
    }

    return {
      content: joinSections(sections),
      sections: sections.map((section) => section.name),
    };
  }

  async function extractMenu(onProgress) {
    const panel = findPlacePanel();
    if (!panel) {
      throw new Error("Could not find the place panel on this page.");
    }

    const restaurantName = getPlaceName(panel);
    const menuTab = await activateMenuTab(panel);
    const { content, sections } = await extractMenuSections(
      panel,
      menuTab,
      onProgress
    );

    if (!content) {
      throw new Error("Could not read any text from the place panel.");
    }

    return {
      url: window.location.href,
      // `title` is what the backend labels the page with; the place name is the
      // only title a Maps panel has.
      title: restaurantName,
      restaurant_name: restaurantName,
      content: content,
      timestamp: new Date().toISOString(),
      place_id: getPlaceKey(),
      source: menuTab ? "google_maps_menu_tab" : "google_maps_panel",
      menu_sections: sections,
      language: document.documentElement.getAttribute("lang") || null,
    };
  }

  // --- trigger chip --------------------------------------------------------

  function ensureChip() {
    if (chipEl && document.body.contains(chipEl)) {
      return chipEl;
    }

    chipEl = document.createElement("button");
    chipEl.className = "vegan-menu-chip";
    chipEl.type = "button";
    chipEl.addEventListener("click", () => {
      triggerMenuAnalysis();
    });
    document.body.appendChild(chipEl);
    setChipState("idle");
    return chipEl;
  }

  function removeChip() {
    if (chipEl && chipEl.parentNode) {
      chipEl.parentNode.removeChild(chipEl);
    }
    chipEl = null;
  }

  function setChipState(state, text) {
    if (!chipEl) {
      return;
    }
    chipEl.className = `vegan-menu-chip ${state}`;
    chipEl.disabled = state === "loading";

    const labels = {
      idle: "\u{1F331} Check menu",
      loading: "Analyzing menu…",
      error: "\u{26A0}\u{FE0F} Menu check failed",
    };
    chipEl.textContent = text || labels[state] || labels.idle;
  }

  // --- analysis flow -------------------------------------------------------

  async function triggerMenuAnalysis() {
    if (isAnalyzing) {
      log("menu analysis already in progress");
      return { status: "already_running" };
    }
    if (!isPlacePage()) {
      return { status: "not_a_place_page" };
    }

    isAnalyzing = true;
    ensureChip();
    setChipState("loading");

    try {
      // Sweeping a split menu makes the panel visibly flip through its sub-tabs,
      // which looks like a glitch unless the chip says what is going on.
      const payload = await extractMenu((done, total) => {
        setChipState("loading", `Analyzing menu… ${done}/${total}`);
      });
      log("extracted menu payload", payload);
      chrome.runtime.sendMessage({ type: "PAGE_FOR_ANALYSIS", payload: payload });
      return { status: "analysis_triggered", extractor: "google_maps" };
    } catch (error) {
      console.error("Vegan Confirmed: menu extraction failed:", error);
      isAnalyzing = false;
      setChipState("error");
      chrome.runtime.sendMessage({
        type: "PAGE_EXTRACTION_FAILED",
        error: error.message,
      });
      return { status: "extraction_failed", error: error.message };
    }
  }

  // Summarise the result for the chip, which has room for one line.
  //
  // A place panel usually yields a menu, but not always: some listings carry
  // only hours and reviews, and the backend answers with whatever kind of page
  // it actually found rather than forcing a menu verdict.
  function summarizeForChip(analysis) {
    if (!analysis) {
      return "\u{1F937} No menu found here";
    }

    if (analysis.page_kind === "shopping_item") {
      if (analysis.is_vegan === true) {
        return "\u{1F331} Vegan — see details";
      }
      if (analysis.is_vegan === false) {
        return "\u{26A0}\u{FE0F} Not vegan — see details";
      }
      return "\u{2753} Vegan status unclear";
    }

    if (analysis.page_kind !== "restaurant_menu") {
      return "\u{1F937} No menu found here";
    }

    const items = analysis.items || [];
    const vegan = items.filter((item) => item.verdict === "vegan").length;
    const likely = items.filter((item) => item.verdict === "likely_vegan").length;

    if (vegan + likely === 0) {
      return "\u{26A0}\u{FE0F} No vegan dishes found";
    }

    const parts = [];
    if (vegan) {
      parts.push(`${vegan} vegan`);
    }
    if (likely) {
      parts.push(`${likely} likely`);
    }
    return `\u{1F331} ${parts.join(", ")} — see details`;
  }

  // --- SPA navigation ------------------------------------------------------

  // Maps swaps places without a page load, so watch for URL changes rather than
  // relying on load events. `history.pushState` is patched (Maps navigates that
  // way) and a low-frequency poll covers replaceState/back-forward.
  function handleLocationChange() {
    const placeKey = isPlacePage() ? getPlaceKey() : null;
    if (placeKey === lastPlaceKey) {
      return;
    }

    lastPlaceKey = placeKey;
    isAnalyzing = false;

    if (placeKey) {
      log("place page detected:", placeKey);
      ensureChip();
      setChipState("idle");
    } else {
      removeChip();
    }
  }

  function watchNavigation() {
    const originalPushState = history.pushState;
    history.pushState = function (...args) {
      const result = originalPushState.apply(this, args);
      handleLocationChange();
      return result;
    };

    window.addEventListener("popstate", handleLocationChange);
    setInterval(handleLocationChange, 1000);
    handleLocationChange();
  }

  // --- init ----------------------------------------------------------------

  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      // The popup sends one trigger to the tab and both content scripts hear
      // it. This script answers on a place page (where it owns extraction) and
      // stays silent elsewhere, so content.js's reply is the one that lands.
      if (message.type === "TRIGGER_PAGE_ANALYSIS") {
        if (!isPlacePage()) {
          return false;
        }
        triggerMenuAnalysis().then(sendResponse);
        return true; // response is async
      }

      if (message.type === "GET_PLACE_INFO") {
        sendResponse({
          is_place_page: isPlacePage(),
          place_key: getPlaceKey(),
          restaurant_name: isPlacePage() ? getPlaceName(findPlacePanel()) : null,
        });
        return false;
      }

      if (message.type === "PAGE_ANALYSIS_DONE") {
        isAnalyzing = false;
        setChipState("done", summarizeForChip(message.result && message.result.analysis));
        sendResponse({ status: "received" });
        return false;
      }

      if (message.type === "PAGE_ANALYSIS_FAILED") {
        isAnalyzing = false;
        setChipState("error");
        sendResponse({ status: "received" });
        return false;
      }

      return false;
    });

    log("maps content script loaded");
    watchNavigation();
  }

  // Expose helpers to Node-based tooling/tests (no-op in a browser).
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      getPlaceKey,
      isPlacePage,
      extractPanelText,
      findPlacePanel,
      findMenuTab,
      findMenuSectionOptions,
      splitSharedEdges,
      joinSections,
      extractMenuSections,
      summarizeForChip,
    };
  }
})();
