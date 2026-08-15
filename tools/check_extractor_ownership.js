#!/usr/bin/env node
//
// Guard: exactly one content script answers TRIGGER_PAGE_ANALYSIS per page.
//
// The popup sends one trigger to the tab and does not know (or want to know)
// which extractor should handle it. Both content scripts receive it, and they
// divide the work by URL: maps.js owns Google Maps place pages, where reading
// the menu needs real DOM interaction; content.js owns everything else.
//
// Getting this wrong is silent and browser-only. If both answer, the second
// sendResponse is dropped and the page is extracted twice — two analyses, two
// backend calls, and a race over which result the popup renders. If neither
// answers, the popup sees the port close, reports "Could not analyze this
// page", and the button appears dead.
//
// Both scripts are loaded into ONE shared scope here, exactly as content
// scripts are (see check_content_scripts.js), with a stub `chrome` recording
// who replies and what they send.
//
// Usage: node tools/check_extractor_ownership.js

const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const SCRIPTS = ["content.js", "maps.js"];

// (url, label, expected extractor) — the extractor that must claim the page.
const PAGES = [
  ["https://shop.example.com/item", "an ordinary page", "page"],
  [
    "https://www.google.com/maps/place/Olive+Branch/@1,2,15z/data=!1s0xa:0xb",
    "a Maps place page",
    "google_maps",
  ],
  // Not a place page: there is no panel to read, so the generic extractor
  // takes it like any other page.
  ["https://www.google.com/maps/search/pizza", "a Maps search page", "page"],
  ["https://maps.google.com/", "the Maps root", "page"],
];

function loadScripts(url) {
  const listeners = [];
  const outbound = [];

  const dom = new JSDOM("<body><h1>page</h1></body>", {
    url,
    // Load-bearing: without it the injected <script> elements never run, and
    // every page would report zero responders.
    runScripts: "dangerously",
    virtualConsole: new VirtualConsole(),
    // The stub has to exist before the scripts parse — each one registers its
    // listener at load time, guarded on `chrome.runtime.onMessage`.
    beforeParse(w) {
      w.chrome = {
        runtime: {
          onMessage: { addListener: (fn) => listeners.push(fn) },
          sendMessage: (message) => outbound.push(message),
          lastError: null,
        },
      };
    },
  });

  for (const file of SCRIPTS) {
    const el = dom.window.document.createElement("script");
    el.textContent = fs.readFileSync(path.join(ROOT, file), "utf8");
    dom.window.document.body.appendChild(el);
  }

  return { listeners, outbound };
}

// Deliver the trigger to every listener and collect who replied.
function trigger(url) {
  const { listeners, outbound } = loadScripts(url);
  const replies = [];

  for (const listener of listeners) {
    try {
      listener({ type: "TRIGGER_PAGE_ANALYSIS" }, {}, (r) => replies.push(r));
    } catch (e) {
      // Extraction itself may fail under jsdom (there is no real Maps panel);
      // ownership is what this guard asserts, not extraction success.
    }
  }

  // maps.js replies from a promise, so let the microtask queue drain.
  return new Promise((resolve) =>
    setTimeout(() => resolve({ replies, outbound }), 50)
  );
}

// The Maps extractor reports failure rather than a payload under jsdom, so
// ownership is read from whichever channel the script used.
function claimedBy({ replies, outbound }) {
  if (replies.length !== 1) {
    return null;
  }
  if (replies[0].extractor) {
    return replies[0].extractor;
  }
  const sent = outbound.find(
    (m) => m.type === "PAGE_FOR_ANALYSIS" || m.type === "PAGE_EXTRACTION_FAILED"
  );
  if (!sent) {
    return null;
  }
  return sent.type === "PAGE_EXTRACTION_FAILED" ? "google_maps" : "page";
}

(async () => {
  let failures = 0;

  for (const [url, label, expected] of PAGES) {
    const result = await trigger(url);
    const actual = claimedBy(result);

    if (result.replies.length !== 1) {
      console.error(
        `  FAIL: ${label} got ${result.replies.length} responders, expected 1`
      );
      failures++;
      continue;
    }
    if (actual !== expected) {
      console.error(
        `  FAIL: ${label} was claimed by "${actual}", expected "${expected}"`
      );
      failures++;
      continue;
    }
    console.log(`  ok: ${label} -> ${actual}`);
  }

  if (failures > 0) {
    console.error("\nEXTRACTOR OWNERSHIP TEST FAILED");
    process.exit(1);
  }

  console.log("\nEXTRACTOR OWNERSHIP TEST PASSED");
  // Explicit, as in check_content_scripts.js: maps.js installs a setInterval
  // in watchNavigation(), which would otherwise hold the event loop open and
  // hang the run forever.
  process.exit(0);
})();
