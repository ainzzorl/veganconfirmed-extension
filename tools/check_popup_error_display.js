#!/usr/bin/env node
//
// Regression: an analysis that fails while the popup is open says nothing.
//
// The popup shows an error by writing it into the loading element — the same
// element the spinner lives in — and then puts the Analyze button back. The
// button reset used to hide that element, so the message was painted and
// removed in the same tick: an image-based PDF ("This PDF has no readable
// text…") left the popup blank, and the error only appeared on the next open,
// where it is rendered from the recorded state instead.
//
// Usage: node tools/check_popup_error_display.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const TAB = { id: 3, url: "https://cafe.example.com/menu.pdf" };
const PDF_ERROR =
  "This PDF has no readable text — it looks like a scanned or image-based menu.";

const say = console.log.bind(console);

const dom = new JSDOM(fs.readFileSync(path.join(ROOT, "popup.html"), "utf8"), {
  url: "chrome-extension://veganconfirmed/popup.html",
});
global.window = dom.window;
global.document = dom.window.document;

// --- stub chrome -------------------------------------------------------------

const messageListeners = [];

// Whatever the popup asks the worker for. Nothing here is running or cached,
// so the popup opens idle and the user triggers the analysis themselves.
function answer(message) {
  if (message.type === "GET_CACHE_ENABLED") return { cache_enabled: true };
  if (message.type === "GET_ANALYSIS_STATE") return { record: null };
  return { status: "received" };
}

global.chrome = {
  runtime: {
    lastError: undefined,
    connect: () => ({ onDisconnect: { addListener() {} } }),
    sendMessage: (message, cb) => {
      if (cb) cb(answer(message));
    },
    onMessage: {
      addListener: (fn) => messageListeners.push(fn),
    },
  },
  storage: {
    local: {
      get: (keys, cb) => cb({}),
      set: (items, cb) => cb && cb(),
      remove: (keys, cb) => cb && cb(),
    },
  },
  tabs: {
    query: (info, cb) => cb([TAB]),
    // Only maps.js answers GET_PLACE_INFO, and this is not a Maps tab; the
    // trigger is acknowledged the way a content script acknowledges it.
    sendMessage: (tabId, message, cb) => {
      if (!cb) return;
      cb(message.type === "GET_PLACE_INFO" ? null : { status: "received" });
    },
    create: () => {},
  },
};

require(path.resolve(ROOT, "popup.js"));
document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));

const loading = document.getElementById("loading");
const analyzeButton = document.getElementById("analyzeButton");

function deliver(message) {
  messageListeners.forEach((fn) => fn(message, {}, () => {}));
}

// --- 1. a failure that arrives while the popup is open is on screen ----------

analyzeButton.click();
assert.strictEqual(loading.style.display, "block", "spinner should be showing");

deliver({ type: "PAGE_ERROR_FOR_POPUP", error: PDF_ERROR });

assert.strictEqual(
  loading.style.display,
  "block",
  "the error must stay on screen, not be hidden with the spinner"
);
assert.strictEqual(loading.textContent, PDF_ERROR);
assert.ok(loading.className.includes("error"), "error should be styled as one");
assert.strictEqual(analyzeButton.disabled, false, "button should be usable again");
say("PASS: an analysis failure is shown in the open popup");

// --- 2. a result still clears the spinner ------------------------------------

analyzeButton.click();
assert.strictEqual(loading.style.display, "block");

deliver({
  type: "PAGE_RESULT_FOR_POPUP",
  result: { analysis: { page_kind: "other", summary: "Nothing to check." } },
});

assert.strictEqual(
  loading.style.display,
  "none",
  "a rendered analysis should leave no spinner behind"
);
assert.strictEqual(document.getElementById("content").style.display, "block");
say("PASS: a result replaces the spinner with the analysis");

say("All popup error-display checks passed.");

// The popup arms a two-minute timeout per trigger, and those live on Node's
// timer queue here; leave rather than wait them out.
process.exit(0);
