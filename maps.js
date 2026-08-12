// Vegan Confirmed — restaurant menu analysis on Google Maps.
//
// Google Maps is a single-page app whose place panel is virtualized and whose
// class names are obfuscated and change often, so this script deliberately does
// as little DOM interpretation as possible. It only:
//   1. recognises that a place page is open and identifies it stably,
//   2. gets the menu actually rendered into the panel (activate the Menu tab,
//      scroll to force lazy-loaded content in),
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

  async function activateMenuTab(panel) {
    const tab = findMenuTab(panel);
    if (!tab) {
      log("no menu tab found; analyzing the panel as shown");
      return false;
    }

    if (tab.getAttribute("aria-selected") === "true") {
      log("menu tab already active");
      return true;
    }

    log("activating menu tab");
    tab.click();
    await waitForSettle(panel, { quietMs: 500, timeoutMs: 6000 });
    return true;
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

  async function extractMenu() {
    const panel = findPlacePanel();
    if (!panel) {
      throw new Error("Could not find the place panel on this page.");
    }

    const restaurantName = getPlaceName(panel);
    const sawMenuTab = await activateMenuTab(panel);
    await scrollToLoad(panel);

    const content = extractPanelText(panel);
    if (!content) {
      throw new Error("Could not read any text from the place panel.");
    }

    return {
      url: window.location.href,
      restaurant_name: restaurantName,
      content: content,
      timestamp: new Date().toISOString(),
      place_id: getPlaceKey(),
      source: sawMenuTab ? "google_maps_menu_tab" : "google_maps_panel",
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
      const payload = await extractMenu();
      log("extracted menu payload", payload);
      chrome.runtime.sendMessage({ type: "MENU_FOR_ANALYSIS", payload: payload });
      return { status: "analysis_triggered" };
    } catch (error) {
      console.error("Vegan Confirmed: menu extraction failed:", error);
      isAnalyzing = false;
      setChipState("error");
      chrome.runtime.sendMessage({
        type: "MENU_EXTRACTION_FAILED",
        error: error.message,
      });
      return { status: "extraction_failed", error: error.message };
    }
  }

  // Summarise the verdict counts for the chip, which has room for one line.
  function summarizeForChip(analysis) {
    if (!analysis || analysis.is_restaurant_menu === false) {
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
      if (message.type === "TRIGGER_MENU_ANALYSIS") {
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

      if (message.type === "MENU_ANALYSIS_DONE") {
        isAnalyzing = false;
        setChipState("done", summarizeForChip(message.result && message.result.analysis));
        sendResponse({ status: "received" });
        return false;
      }

      if (message.type === "MENU_ANALYSIS_FAILED") {
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
      summarizeForChip,
    };
  }
})();
