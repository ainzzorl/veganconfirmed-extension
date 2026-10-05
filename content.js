// Global flag to prevent multiple simultaneous analyses
let isAnalyzing = false;

// Global flag to control console logging
let enableLogging = false;

// Helper function for conditional logging
function log(...args) {
  if (enableLogging) {
    console.log(...args);
  }
}

// Determine the language of the page from the <html lang> attribute,
// falling back to the content-language meta tag. Returns null if unknown.
function getPageLanguage() {
  const htmlLang = document.documentElement.getAttribute("lang");
  if (htmlLang && htmlLang.trim()) {
    return htmlLang.trim();
  }

  const metaLang = document.querySelector(
    'meta[http-equiv="content-language" i]'
  );
  if (metaLang && metaLang.content && metaLang.content.trim()) {
    return metaLang.content.trim();
  }

  return null;
}

// Strip the whitespace the HTML source leaks into the markdown: indentation,
// tabs and non-breaking spaces are not content and only cost tokens.
function cleanMarkdown(markdown) {
  const lines = markdown
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => collapseWhitespace(line));

  // At most one blank line between blocks.
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// One line of rendered text: `\s`/`trim` cover tabs and non-breaking spaces too.
function collapseWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}

// Heuristic: detect text nodes that are really an embedded JSON/JS data blob
// (e.g. Amazon's `{"desktop_buybox_group_1":[...]}` pricing state that lives in
// a plain <div> rather than a <script>, so element removal alone misses it).
// Such blobs are pure noise for analysis and waste a large number of tokens.
function looksLikeDataBlob(text) {
  const trimmed = text.trim();
  if (trimmed.length < 200) {
    return false;
  }
  if (!/^[\[{]/.test(trimmed)) {
    return false;
  }
  // Many quoted-key/colon pairs is a strong signal of serialized data.
  const structuralPairs = (trimmed.match(/"\s*:/g) || []).length;
  return structuralPairs >= 5;
}

// Function to convert HTML element to markdown
function elementToMarkdown(element) {
  if (element.nodeType === Node.TEXT_NODE) {
    if (looksLikeDataBlob(element.textContent)) {
      return "";
    }
    // Collapse whitespace the way the browser renders it: a pretty-printed page
    // otherwise leaks its own indentation and line breaks into the markdown.
    return element.textContent.replace(/\s+/g, " ");
  }

  if (element.nodeType !== Node.ELEMENT_NODE) {
    return "";
  }

  const tagName = element.tagName.toLowerCase();
  const textContent = collapseWhitespace(element.textContent);

  if (!textContent) {
    return "";
  }

  switch (tagName) {
    case "h1":
      return `# ${textContent}\n\n`;
    case "h2":
      return `## ${textContent}\n\n`;
    case "h3":
      return `### ${textContent}\n\n`;
    case "h4":
      return `#### ${textContent}\n\n`;
    case "h5":
      return `##### ${textContent}\n\n`;
    case "h6":
      return `###### ${textContent}\n\n`;
    case "p":
      return `${textContent}\n\n`;
    case "strong":
    case "b":
      return `**${textContent}**`;
    case "em":
    case "i":
      return `*${textContent}*`;
    case "code":
      return `\`${textContent}\``;
    case "pre":
      return `\`\`\`\n${textContent}\n\`\`\`\n\n`;
    case "blockquote":
      return `> ${textContent}\n\n`;
    case "ul":
      const ulItems = Array.from(element.querySelectorAll("li"))
        .map((li) => `- ${collapseWhitespace(li.textContent)}`)
        .join("\n");
      return `${ulItems}\n\n`;
    case "ol":
      const olItems = Array.from(element.querySelectorAll("li"))
        .map((li, index) => `${index + 1}. ${collapseWhitespace(li.textContent)}`)
        .join("\n");
      return `${olItems}\n\n`;
    case "li":
      return `${textContent}\n`;
    case "a":
      return textContent;
    case "img":
      return "";
    case "br":
      return "\n";
    case "hr":
      return "---\n\n";
    case "div":
    case "section":
    case "article":
    case "main":
    case "span":
      // For container elements, process their children
      let containerMarkdown = "";
      for (const child of element.childNodes) {
        const childMarkdown = elementToMarkdown(child);
        if (childMarkdown) {
          containerMarkdown += childMarkdown + "\n";
        }
      }
      return containerMarkdown;
    default:
      // For other elements, process their children if they exist
      if (element.childNodes.length > 0) {
        let defaultMarkdown = "";
        for (const child of element.childNodes) {
          const childMarkdown = elementToMarkdown(child);
          if (childMarkdown) {
            defaultMarkdown += childMarkdown + "\n";
          }
        }
        return defaultMarkdown;
      }
      // If no children, return the text content
      return textContent;
  }
}

// A page that splits its menu into collapsible sections often renders each
// section's rows only once it is clicked, so at extraction time the DOM holds
// the section headings and nothing else — the dishes exist only in an embedded
// JSON payload (Next.js `__NEXT_DATA__`, a framework's hydration state,
// JSON-LD). The helpers below mine those payloads for name/price/description
// records and append the ones the page is not already showing.
const DATA_PAYLOAD_SELECTOR =
  'script[type="application/json"], script[type="application/ld+json"]';

// Bounds, since a hydration payload can be megabytes of arbitrary structure.
const MAX_PAYLOAD_CHARS = 2000000;
const MAX_PAYLOAD_NODES = 200000;
const MAX_PAYLOAD_DEPTH = 20;
const MAX_DATA_RECORDS = 200;
const MAX_DATA_CHARS = 20000;
const MAX_NAME_CHARS = 120;
const MAX_DESCRIPTION_CHARS = 300;

// Keys that name the group a record belongs to (a menu section, a category).
// `primary` is where slice-based CMSes (Prismic) keep a section's own fields,
// beside the `items` array it labels.
const SECTION_LABEL_KEYS = [
  "page_name",
  "section_name",
  "section_title",
  "group_name",
  "category_name",
  "menu_section",
];

function normalizeForMatch(text) {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function sectionLabelOf(obj) {
  for (const key of SECTION_LABEL_KEYS) {
    if (typeof obj[key] === "string" && obj[key].trim()) {
      return obj[key].trim();
    }
  }
  if (obj["@type"] === "MenuSection" && typeof obj.name === "string") {
    return obj.name.trim();
  }
  if (obj.primary && typeof obj.primary === "object" && !Array.isArray(obj.primary)) {
    return sectionLabelOf(obj.primary);
  }
  return null;
}

// `priceCurrency` and friends sit next to `price` in JSON-LD and are not one.
function priceOf(obj) {
  for (const [key, value] of Object.entries(obj)) {
    if (!/price/i.test(key) || /currency|range/i.test(key)) {
      continue;
    }
    if (typeof value === "number") {
      return String(value);
    }
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

// A record is an object carrying a name plus something that makes it a listed
// item rather than an incidental label: a description, a price, or a section
// the page is showing (plenty of menus list a side dish by name alone).
function recordOf(obj, section) {
  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  if (!name || name.length > MAX_NAME_CHARS || !/[a-z]/i.test(name)) {
    return null;
  }
  if (/^https?:\/\//i.test(name)) {
    return null;
  }
  const description =
    typeof obj.description === "string"
      ? obj.description.trim().slice(0, MAX_DESCRIPTION_CHARS)
      : "";
  const price = priceOf(obj);
  if (!description && !price && !section) {
    return null;
  }
  return { section: section || "", name, description, price };
}

function collectDataRecords() {
  const records = [];
  const seen = new Set();
  let nodes = 0;

  const visit = (value, section, depth) => {
    if (
      nodes >= MAX_PAYLOAD_NODES ||
      records.length >= MAX_DATA_RECORDS ||
      depth > MAX_PAYLOAD_DEPTH
    ) {
      return;
    }
    nodes += 1;

    if (Array.isArray(value)) {
      for (const child of value) {
        visit(child, section, depth + 1);
      }
      return;
    }
    if (!value || typeof value !== "object") {
      return;
    }

    // A label found here applies to everything below it.
    const label = sectionLabelOf(value) || section;
    const record = recordOf(value, label);
    if (record) {
      const key = normalizeForMatch(
        `${record.section}|${record.name}|${record.description}`
      );
      if (!seen.has(key)) {
        seen.add(key);
        records.push(record);
      }
    }
    for (const child of Object.values(value)) {
      visit(child, label, depth + 1);
    }
  };

  for (const script of document.querySelectorAll(DATA_PAYLOAD_SELECTOR)) {
    const raw = script.textContent;
    if (!raw || raw.length > MAX_PAYLOAD_CHARS) {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      continue;
    }
    visit(parsed, null, 0);
  }

  return records;
}

function renderDataRecords(records) {
  const lines = ["## Additional items from page data"];
  let currentSection = null;
  let budget = MAX_DATA_CHARS;

  for (const record of records) {
    const line = `- ${[record.name, record.price, record.description]
      .filter(Boolean)
      .join(" — ")}`;
    const heading =
      record.section !== currentSection && record.section
        ? `\n### ${record.section}`
        : "";
    if (line.length + heading.length > budget) {
      break;
    }
    budget -= line.length + heading.length;
    if (heading) {
      lines.push(heading);
    }
    currentSection = record.section;
    lines.push(line);
  }

  return lines.length > 1 ? lines.join("\n") : "";
}

// Returns the markdown to append to `visibleMarkdown`, or "" if the payloads add
// nothing.
function extractDataPayloadItems(visibleMarkdown) {
  let records = collectDataRecords();
  if (!records.length) {
    return "";
  }
  const visible = normalizeForMatch(visibleMarkdown);

  // The page names the sections it is showing, so a section of the payload that
  // is nowhere on it belongs to another page (the drinks menu this one links
  // to). Only applied when some section is visible — a page that renders no
  // headings at all is not evidence against anything.
  const sections = new Set(
    records.map((record) => record.section).filter(Boolean)
  );
  const visibleSections = new Set(
    [...sections]
      .map(normalizeForMatch)
      .filter((section) => visible.includes(section))
  );
  if (visibleSections.size) {
    records = records.filter(
      (record) =>
        !record.section || visibleSections.has(normalizeForMatch(record.section))
    );
  }

  // Drop what the page already shows: a product page repeats its own item in
  // JSON-LD, and sending it twice only costs tokens.
  records = records.filter((record) => {
    const nameShown = visible.includes(normalizeForMatch(record.name));
    const descriptionShown =
      !record.description ||
      visible.includes(normalizeForMatch(record.description));
    return !(nameShown && descriptionShown);
  });
  if (!records.length) {
    return "";
  }

  return renderDataRecords(records);
}

// What the page declares about its own kind, forwarded to the backend as
// `page_signals`.
//
// Facts only, never a verdict: which og:type the page names, which schema.org
// types its JSON-LD and microdata carry, and which third-party hosts it loads
// from. Every rule written against them lives on the server
// (services/page_scope.py), where it can be changed without shipping an
// extension release — so this side stays a bounded reader that decides
// nothing.
const SIGNAL_LD_SELECTOR = 'script[type="application/ld+json"]';

// A page declaring more than this has a graph describing its whole site rather
// than itself, and the rules read a handful of types at most.
const MAX_SCHEMA_TYPES = 40;
const MAX_SCHEMA_TYPE_CHARS = 60;

// `@type` is a string or an array of them, and may be written as a full
// schema.org URL. The bare name is what the server matches on.
function addSchemaTypes(types, value) {
  for (const entry of Array.isArray(value) ? value : [value]) {
    if (typeof entry !== "string" || types.size >= MAX_SCHEMA_TYPES) {
      continue;
    }
    const name = entry.trim().replace(/\/$/, "").split("/").pop();
    if (name && name.length <= MAX_SCHEMA_TYPE_CHARS) {
      types.add(name);
    }
  }
}

// Every `@type` in the page's JSON-LD, plus the ones its microdata names.
// Bounded the same way the data-payload mining is: a hydration graph is
// arbitrary structure of arbitrary size.
function collectSchemaTypes() {
  const types = new Set();
  let nodes = 0;

  const visit = (value, depth) => {
    if (
      value === null ||
      typeof value !== "object" ||
      depth > MAX_PAYLOAD_DEPTH ||
      nodes >= MAX_PAYLOAD_NODES ||
      types.size >= MAX_SCHEMA_TYPES
    ) {
      return;
    }
    nodes += 1;
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, depth + 1);
      }
      return;
    }
    addSchemaTypes(types, value["@type"]);
    for (const child of Object.values(value)) {
      visit(child, depth + 1);
    }
  };

  for (const script of document.querySelectorAll(SIGNAL_LD_SELECTOR)) {
    const raw = script.textContent;
    if (!raw || raw.length > MAX_PAYLOAD_CHARS) {
      continue;
    }
    try {
      visit(JSON.parse(raw), 0);
    } catch (e) {
      // A malformed block says nothing; the rest of the page still does.
    }
  }

  // Microdata is the older way of declaring the same thing, and plenty of shop
  // templates still use it instead of JSON-LD.
  for (const element of document.querySelectorAll("[itemtype]")) {
    if (types.size >= MAX_SCHEMA_TYPES) {
      break;
    }
    addSchemaTypes(types, element.getAttribute("itemtype"));
  }

  return [...types];
}

// The page's declared og:type, or null.
function declaredOgType() {
  const meta = document.querySelector(
    'meta[property="og:type"], meta[name="og:type"]'
  );
  return meta?.getAttribute("content")?.trim().toLowerCase() || null;
}

// Which third-party hosts the page loads its scripts, stylesheets and frames
// from. A site built on a restaurant platform says so through them even when it
// declares no schema at all, which is the common case on a restaurant's own
// site. Anchors are left out: outbound links are noise, not what the page runs
// on.
const ASSET_HOST_SELECTOR = "script[src], link[href], iframe[src]";
const MAX_ASSET_HOSTS = 40;
const MAX_ASSET_ELEMENTS = 500;

function collectAssetHosts() {
  const own = window.location.hostname.toLowerCase();
  const hosts = new Set();
  let scanned = 0;

  for (const element of document.querySelectorAll(ASSET_HOST_SELECTOR)) {
    if (scanned >= MAX_ASSET_ELEMENTS || hosts.size >= MAX_ASSET_HOSTS) {
      break;
    }
    scanned += 1;
    const raw = element.getAttribute("src") || element.getAttribute("href");
    if (!raw) {
      continue;
    }
    let host;
    try {
      host = new URL(raw, window.location.href).hostname.toLowerCase();
    } catch (e) {
      continue;
    }
    if (host && host !== own) {
      hosts.add(host);
    }
  }

  return [...hosts];
}

// Null when the page declares nothing, so the field is absent rather than empty.
function collectPageSignals() {
  const ogType = declaredOgType();
  const schemaTypes = collectSchemaTypes();
  const assetHosts = collectAssetHosts();
  if (!ogType && !schemaTypes.length && !assetHosts.length) {
    return null;
  }
  return {
    og_type: ogType,
    schema_types: schemaTypes,
    asset_hosts: assetHosts,
  };
}

// Function to extract clean text content from the current page for AI analysis
function extractPageContent(
  triggerType = "manual",
  triggerElementText = null,
  triggerElementSelector = null
) {
  // Clone the body to avoid modifying the original page
  const bodyClone = document.body.cloneNode(true);

  // Remove script, style and other non-textual elements. `select`/`option`
  // dropdowns are removed because they carry only size/variant lists (often many
  // KB of pure noise on store pages); `svg`/`template`/`link` are decorative or
  // non-rendered.
  const scripts = bodyClone.querySelectorAll(
    "script, style, noscript, iframe, embed, object, svg, select, option, template, link"
  );
  scripts.forEach((el) => el.remove());

  // Remove common non-content elements. `[aria-hidden="true"]` covers off-screen
  // duplicate UI states (collapsed panels, feedback-survey alternates) that would
  // otherwise be flattened into the text and bloat/dilute the analysis input.
  //
  // `.menu` is deliberately NOT in this list even though it names a navigation
  // menu on plenty of sites: on a restaurant page it just as often wraps the
  // actual food menu, which is the whole point of analyzing the page. The
  // nav-specific selectors below cover the navigation case without that risk.
  const nonContentElements = bodyClone.querySelectorAll(
    'nav, footer, header, .sidebar, .navigation, .navbar, .nav-menu, .menu-toggle, .ad, .advertisement, .banner, #navFooter, [aria-hidden="true"]'
  );
  nonContentElements.forEach((el) => el.remove());

  // Store-specific elements
  const keysToRemove = [
    // Amazon
    "#rightCol",
    "#leftCol",
    "#averageCustomerReviews",
    // Customer reviews: often over half the page's text, crowding the seller's
    // own description out of the backend's token budget.
    "#reviewsMedley",
    "#customer-reviews_feature_div",
    "#apex_desktop",
    "#pqv-feedback",
    ".offersConsistencyEnabled",
    '[data-feature-name="sims-productBundle"]',
    '[data-feature-name="sims-simsContainer"]',
  ].join(", ");

  const elementsToRemove = bodyClone.querySelectorAll(keysToRemove);
  elementsToRemove.forEach((el) => el.remove());

  // Convert to markdown and clean up duplicate new lines
  const rawMarkdown = elementToMarkdown(bodyClone).trim();

  const markdownContent = cleanMarkdown(rawMarkdown);

  // Appended last so the page's own text stays first if the backend has to
  // truncate to its token budget.
  const dataItems = extractDataPayloadItems(markdownContent);
  const content = dataItems
    ? `${markdownContent}\n\n${dataItems}`
    : markdownContent;

  return {
    url: window.location.href,
    title: document.title,
    timestamp: new Date().toISOString(),
    content,
    language: getPageLanguage(),
    // Read here rather than at page load: a single-page app rewrites its own
    // metadata as it navigates, so the declaration has to be taken in the same
    // pass as the content it describes.
    page_signals: collectPageSignals(),
    source: "page",
    trigger_type: triggerType,
    trigger_element_text: triggerElementText,
    trigger_element_selector: triggerElementSelector,
  };
}

// Shown when a PDF carries no text we can read. Design tools routinely convert
// menu type to vector outlines, which leaves the prices as the only real text
// in the file — enough to look like a menu, nowhere near enough to be one.
const PDF_NO_TEXT_MESSAGE =
  "This PDF has no readable text — it looks like a scanned or image-based menu.";

// Whether the tab is showing a PDF rather than an HTML page.
//
// Chrome serves a PDF as a stream document whose body is a single `<embed>`,
// and content scripts do run there — but `extractPageContent` strips `embed`
// (see the removal list above) and would send an empty page. `contentType` is
// the reliable signal; the `<embed>` check covers a PDF framed inside an
// otherwise-HTML document.
function isPdfDocument() {
  if (document.contentType === "application/pdf") {
    return true;
  }
  return Boolean(document.body?.querySelector('embed[type="application/pdf"]'));
}

// Read the PDF's text layer and build the same payload the HTML path builds.
//
// pdf.js is loaded on demand rather than shipped as a content script: it is
// ~1.8MB, and the overwhelming majority of pages are not PDFs. Both it and
// pdf_extract.mjs are ES modules listed in web_accessible_resources, so a
// dynamic import from this isolated world resolves them.
//
// Throws when the PDF has no usable text layer, which the caller reports rather
// than analyzing — see PDF_NO_TEXT_MESSAGE.
async function extractPdfPageContent(triggerType = "manual") {
  const pdfjsLib = await import(chrome.runtime.getURL("vendor/pdf.min.mjs"));
  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(
    "vendor/pdf.worker.min.mjs"
  );
  const { extractPdfText } = await import(
    chrome.runtime.getURL("pdf_extract.mjs")
  );

  const result = await extractPdfText(pdfjsLib, {
    url: window.location.href,
    // The viewer already fetched this document; go through the same cookies and
    // cache rather than asking the server for it as an anonymous request.
    withCredentials: true,
  });

  if (!result.readable) {
    throw new Error(PDF_NO_TEXT_MESSAGE);
  }

  return {
    url: window.location.href,
    // A PDF has no <title>; the browser shows the filename. The document's own
    // Title is the better label when it is not just the source filename.
    title: result.title || document.title,
    timestamp: new Date().toISOString(),
    content: result.content,
    language: getPageLanguage(),
    source: "pdf",
    trigger_type: triggerType,
    trigger_element_text: null,
    trigger_element_selector: null,
  };
}

// Function to send extracted content to backend for AI analysis
function sendContentForAnalysis(content) {
  chrome.runtime.sendMessage(
    {
      type: "PAGE_FOR_ANALYSIS",
      payload: content,
    },
    (response) => {
      log("Content sent for AI analysis, response:", response);
    }
  );
}

// Tell the popup extraction failed, the way maps.js does when it cannot read a
// place panel. The alternative — sending what little we got — is worse than
// saying nothing: an empty page comes back classified as "other", and a page of
// bare prices comes back as a menu of invented dishes.
function sendExtractionFailure(error) {
  chrome.runtime.sendMessage({
    type: "PAGE_EXTRACTION_FAILED",
    error: error,
  });
}

// Function to trigger analysis manually
function triggerAnalysis() {
  log("Manual analysis triggered");

  if (isPdfDocument()) {
    log("PDF detected - reading its text layer");
    extractPdfPageContent("manual")
      .then(sendContentForAnalysis)
      .catch((error) => {
        log("PDF extraction failed:", error);
        sendExtractionFailure(
          error && error.message ? error.message : String(error)
        );
      });
    return;
  }

  const extractedContent = extractPageContent("manual", null);
  sendContentForAnalysis(extractedContent);
}

// Whether maps.js owns extraction on this page.
//
// Both content scripts receive every tabs.sendMessage, so exactly one of them
// has to answer TRIGGER_PAGE_ANALYSIS. A Maps place panel needs real DOM
// interaction to reveal its menu (clicking the Menu tab, sweeping sub-tabs,
// scrolling to lazy-load), which maps.js does and this generic extractor
// cannot — so on those pages this script stands down.
function isMapsPlacePage() {
  return /\/maps\/place\//.test(window.location.pathname);
}

// Paid placements. An anchor carrying rel="sponsored" is a declared paid link,
// and a real add-to-cart button never lives inside one — but an ad creative
// labelled "Buy Now" is a routine thing to serve into such a slot, on a page
// that sells nothing. Rotating creatives are why the same article page can
// trigger analysis again and again.
const SPONSORED_CONTAINER_SELECTOR = 'a[target="_blank"][rel~="sponsored"]';

function isSponsoredContent(element) {
  return Boolean(element.closest?.(SPONSORED_CONTAINER_SELECTOR));
}

// Page kinds that cannot be a shopping item, taken from the page's own og:type.
//
// A blacklist, not a whitelist: most product pages declare nothing at all
// (Amazon) or "website" (thredUP), so requiring a positive declaration would
// silently drop real ones. Only kinds that rule a purchase out are listed —
// "article" and "book" are deliberately absent, since product reviews and
// bookshops are shopping intents that use them.
const NON_SHOPPING_OG_TYPES = ["video", "music", "profile"];

// The declared og:type when it names one of the kinds above, else null.
function declaredNonShoppingKind() {
  const ogType = declaredOgType();
  if (!ogType) {
    return null;
  }
  // "video.other", "music.song" — the kind is the part before the subtype.
  const kind = ogType.split(".")[0];
  return NON_SHOPPING_OG_TYPES.includes(kind) ? ogType : null;
}

// Function to detect "Add to Cart" buttons
function detectAddToCartButtons() {
  let buttons = [];

  // Use jQuery-like selector matching for text content
  const allButtons = document.querySelectorAll(
    'button, input[type="submit"], input[type="button"], a, [role="button"]'
  );

  allButtons.forEach((button) => {
    const text =
      button.textContent?.toLowerCase() || button.value?.toLowerCase() || "";
    let className = "";
    if (typeof button.className === "string") {
      className = button.className.toLowerCase();
    }
    const id = button.id?.toLowerCase() || "";
    const ariaLabel = button.getAttribute("aria-label")?.toLowerCase() || "";
    const title = button.getAttribute("title")?.toLowerCase() || "";
    const dataTestId = button.getAttribute("data-testid")?.toLowerCase() || "";
    const dataAction = button.getAttribute("data-action")?.toLowerCase() || "";

    // Check for common add to cart patterns - exact matches only
    const cartPatterns = [
      "add to cart",
      "add to bag",
      "add to basket",
      "addtocart",
      "addtobag",
      "addtobasket",
      "add to shopping cart",
      "add to shopping bag",
      "add to wishlist",
      "add to favorites",
      "order now",
      "buy now",
      "purchase now",
    ];

    // Check for common cart-related class patterns
    const cartClassPatterns = [
      "cart",
      "bag",
      "basket",
      "buy",
      "purchase",
      "order",
      "add-to",
      "addto",
      "shopping",
      "checkout",
    ];

    const matchesTextPattern = cartPatterns.some(
      (pattern) =>
        text === pattern ||
        ariaLabel === pattern ||
        title === pattern ||
        dataTestId === pattern ||
        dataAction === pattern
    );

    const matchesClassPattern = cartClassPatterns.some(
      (pattern) => className === pattern || id === pattern
    );

    if (matchesTextPattern || matchesClassPattern) {
      // Filter out buttons that are clearly not add to cart (like remove, delete, etc.)
      const excludePatterns = [
        "remove",
        "delete",
        "clear",
        "empty",
        "checkout",
        "view cart",
        "remove from cart",
        "delete from cart",
        "clear cart",
      ];

      const shouldExclude = excludePatterns.some(
        (pattern) =>
          text === pattern || ariaLabel === pattern || title === pattern
      );

      if (!shouldExclude && !isSponsoredContent(button)) {
        buttons.push(button);
      }
    }
  });

  return buttons;
}

// Bounds for the selector built below: a page can nest a button dozens of
// levels deep and hang twenty utility classes off each one.
const MAX_SELECTOR_DEPTH = 8;
const MAX_SELECTOR_CLASSES = 3;
const MAX_SELECTOR_CHARS = 500;

function escapeSelectorPart(value) {
  if (typeof CSS !== "undefined" && CSS.escape) {
    return CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

function matchesOnly(selector, element) {
  try {
    const matches = document.querySelectorAll(selector);
    return matches.length === 1 && matches[0] === element;
  } catch (e) {
    return false;
  }
}

// Build a CSS selector that identifies `element` on the page it was clicked on.
// Walks up the ancestors adding tag/class/:nth-of-type steps, stopping as soon
// as the path matches this element and nothing else, or at the first id that is
// unique on the page. Attributes are read with getAttribute and classList
// because a <form> whose fields are named `id`/`className` shadows those
// properties.
function buildElementSelector(element) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) {
    return null;
  }

  const steps = [];
  for (
    let current = element;
    current &&
    current.nodeType === Node.ELEMENT_NODE &&
    steps.length < MAX_SELECTOR_DEPTH;
    current = current.parentElement
  ) {
    const id = current.getAttribute("id");
    if (id && matchesOnly(`#${escapeSelectorPart(id)}`, current)) {
      steps.unshift(`#${escapeSelectorPart(id)}`);
      break;
    }

    let step = current.localName;
    for (const className of Array.from(current.classList).slice(
      0,
      MAX_SELECTOR_CLASSES
    )) {
      step += `.${escapeSelectorPart(className)}`;
    }

    const parent = current.parentElement;
    if (parent) {
      const twins = Array.from(parent.children).filter(
        (child) => child.localName === current.localName
      );
      if (twins.length > 1) {
        step += `:nth-of-type(${twins.indexOf(current) + 1})`;
      }
    }

    steps.unshift(step);
    if (matchesOnly(steps.join(" > "), element)) {
      break;
    }
  }

  // Over the budget, drop ancestors rather than characters: a shorter path is
  // still a valid selector, a truncated one is not.
  while (steps.length > 1 && steps.join(" > ").length > MAX_SELECTOR_CHARS) {
    steps.shift();
  }

  return steps.join(" > ") || null;
}

// Function to handle add to cart button clicks
function handleAddToCartClick(event) {
  // Prevent multiple simultaneous analyses
  if (isAnalyzing) {
    log("Analysis already in progress, skipping...");
    return;
  }

  // Read at click time, not at setup: a single-page app swaps its og:type as
  // the user navigates, and this is the only moment the answer has to be right.
  const nonShoppingKind = declaredNonShoppingKind();
  if (nonShoppingKind) {
    log(
      `Vegan Confirmed: page declares og:type="${nonShoppingKind}" - skipping automatic analysis`
    );
    return;
  }

  // The detected button, not event.target: the click usually lands on a child
  // (the <span> holding the label), which carries none of the button's identity.
  const button = event.currentTarget || event.target;
  const triggerElementSelector = buildElementSelector(button);

  // Log detailed information about the button that was clicked
  const buttonInfo = {
    text: button.textContent?.trim() || button.value?.trim() || "No text",
    className: button.className || "No class",
    id: button.id || "No ID",
    tagName: button.tagName,
    ariaLabel: button.getAttribute("aria-label") || "No aria-label",
    title: button.getAttribute("title") || "No title",
    dataTestId: button.getAttribute("data-testid") || "No data-testid",
    dataAction: button.getAttribute("data-action") || "No data-action",
    type: button.type || "No type",
    href: button.href || "No href",
    selector: triggerElementSelector || "No selector",
  };

  log(
    "Vegan Confirmed: Add to cart button clicked - Button details:",
    buttonInfo
  );
  log("Vegan Confirmed: Button element:", button);

  isAnalyzing = true;

  // Get button text for trigger information
  const triggerElementText = button.textContent?.trim() ||
    button.value?.trim() ||
    button.getAttribute("aria-label")?.trim() ||
    button.getAttribute("title")?.trim() ||
    "Unknown button";

  // Trigger analysis
  const extractedContent = extractPageContent(
    "automatic",
    triggerElementText,
    triggerElementSelector
  );
  sendContentForAnalysis(extractedContent);

  // Reset analyzing flag after a reasonable timeout
  setTimeout(() => {
    isAnalyzing = false;
  }, 10000); // 10 seconds should be enough for most analyses
}

// Function to setup cart detection
function setupCartDetection() {
  // Initial detection
  const cartButtons = detectAddToCartButtons();
  log(
    "Vegan Confirmed: Detected",
    cartButtons.length,
    "cart buttons on page"
  );

  // Add click listeners to existing buttons
  cartButtons.forEach((button) => {
    if (!button.hasAttribute("data-vegan-analyzed")) {
      button.setAttribute("data-vegan-analyzed", "true");
      button.addEventListener("click", handleAddToCartClick);
      log(
        "Vegan Confirmed: Added listener to button:",
        button.textContent?.substring(0, 50) || button.className || button.id
      );
    }
  });

  // Watch for dynamically added buttons using MutationObserver
  const observer = new MutationObserver((mutations) => {
    let shouldCheckForButtons = false;

    // First pass: check if any relevant elements were added
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          // Only check if button-like elements were added
          if (node.matches && (
            node.matches('button, input[type="submit"], input[type="button"], a, [role="button"]') ||
            node.querySelector('button, input[type="submit"], input[type="button"], a, [role="button"]')
          )) {
            shouldCheckForButtons = true;
            break;
          }
        }
      }
      if (shouldCheckForButtons) break;
    }

    // Only run expensive detection if relevant elements were added
    if (shouldCheckForButtons) {
      const newCartButtons = detectAddToCartButtons();
      newCartButtons.forEach((button) => {
        if (!button.hasAttribute("data-vegan-analyzed")) {
          button.setAttribute("data-vegan-analyzed", "true");
          button.addEventListener("click", handleAddToCartClick);
          log(
            "Vegan Confirmed: Added listener to dynamically added button:",
            button.textContent?.substring(0, 50) ||
            button.className ||
            button.id
          );
        }
      });
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  log("Vegan Confirmed: Cart detection setup complete");
}

// Initialize content script only inside a real extension/browser context. Under
// Node (e.g. the jsdom-based extraction harness used by the backend analysis
// eval) `chrome` is undefined, so the load-time side effects are skipped and the
// extraction functions can be imported without registering listeners or
// observers.
if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  // Listen for messages from popup
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    log("Content script received message:", message);

    if (message.type === "TRIGGER_PAGE_ANALYSIS") {
      // Leave the reply to maps.js on a place page — see isMapsPlacePage.
      if (isMapsPlacePage()) {
        return;
      }
      triggerAnalysis();
      sendResponse({ status: "analysis_triggered", extractor: "page" });
    }
  });

  // Google Maps is handled by maps.js (menu analysis). Cart detection is not
  // just useless there but actively costly: Maps mutates the DOM continuously
  // while the map pans, and every mutation would re-run a whole-document
  // button scan.
  if (/\/maps\//.test(window.location.pathname)) {
    log("Google Maps detected - skipping cart detection (maps.js handles this page)");
  } else {
    // Initialize content script and setup cart detection
    log("Content script loaded - setting up cart detection");
    setupCartDetection();
  }
}

// Expose the extraction helpers to Node-based tooling/tests (no-op in a browser,
// where `module` is undefined). Keeps content.js the single source of truth for
// the HTML→markdown extraction the backend analysis eval runs against.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    extractPageContent,
    extractDataPayloadItems,
    collectPageSignals,
    elementToMarkdown,
    cleanMarkdown,
    detectAddToCartButtons,
    isSponsoredContent,
    declaredNonShoppingKind,
    buildElementSelector,
    isMapsPlacePage,
    isPdfDocument,
  };
}
