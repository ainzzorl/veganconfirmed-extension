#!/usr/bin/env node
//
// Regression: the two-minute timeout must belong to the analysis it is
// guarding.
//
// The popup arms a timer per trigger and never cancels one, so a timer left
// over from an earlier analysis — a previous run in the same open popup, or
// the deadline of a run this popup only restored — used to fire on whatever
// analysis happened to be waiting when it went off, and a run of a few
// seconds was declared timed out.
//
// Usage: node tools/check_analysis_timeout.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const POPUP_JS = path.join(ROOT, "popup.js");
const TAB = { id: 7, url: "https://shop.example.com/product/42" };
const TIMED_OUT = "Analysis timed out. Please try again.";

const say = console.log.bind(console);

// --- a clock the test drives ------------------------------------------------
//
// popup.js reaches for the globals, so the fakes go on `global` before it is
// loaded. Real timers stay in hand for flushing promise chains.

const realSetTimeout = global.setTimeout;
const realDateNow = Date.now;

let now = 1700000000000;
let timers = [];

global.setTimeout = function (fn, ms) {
  const timer = { fn: fn, at: now + (ms || 0), cancelled: false };
  timers.push(timer);
  return timer;
};
global.clearTimeout = function (timer) {
  if (timer && typeof timer === "object") {
    timer.cancelled = true;
  }
};
Date.now = () => now;

function advance(ms) {
  const target = now + ms;
  for (;;) {
    const due = timers
      .filter((t) => !t.cancelled && t.at <= target)
      .sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    due.cancelled = true;
    now = due.at;
    due.fn();
  }
  now = target;
}

// Let the popup's promise chains (place info, analysis state) settle.
const settle = () => new Promise((resolve) => realSetTimeout(resolve, 0));

// --- a popup, freshly opened -------------------------------------------------

// Answers the popup's questions. `state` is what the worker reports this tab
// is doing; `holdState` defers that answer so the test can click first, the
// way a user does while the worker is still waking up.
async function openPopup({ state = null, holdState = false } = {}) {
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, "popup.html"), "utf8"), {
    url: "chrome-extension://veganconfirmed/popup.html",
  });
  global.window = dom.window;
  global.document = dom.window.document;

  // jsdom fires its own DOMContentLoaded a tick after it finishes parsing.
  // Let that pass before popup.js is loaded, so the popup starts up exactly
  // once — on the event dispatched below.
  await settle();

  const messageListeners = [];
  let releaseState = null;

  global.chrome = {
    runtime: {
      lastError: undefined,
      connect: () => ({ onDisconnect: { addListener() {} } }),
      sendMessage: (message, cb) => {
        if (!cb) return;
        if (message.type === "GET_DEV_MODE") return cb({ dev_mode: false });
        if (message.type === "GET_ANALYSIS_STATE") {
          if (holdState) {
            releaseState = () => cb({ record: state });
            return;
          }
          return cb({ record: state });
        }
        return cb({ status: "received" });
      },
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
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
      sendMessage: (tabId, message, cb) => {
        if (!cb) return;
        cb(message.type === "GET_PLACE_INFO" ? null : { status: "received" });
      },
      create: () => {},
    },
  };

  delete require.cache[POPUP_JS];
  require(POPUP_JS);
  document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));

  return {
    loading: document.getElementById("loading"),
    button: document.getElementById("analyzeButton"),
    deliver: (message) => messageListeners.forEach((fn) => fn(message, {}, () => {})),
    releaseState: () => releaseState && releaseState(),
  };
}

// --- 1. a finished analysis's timer must not fire on the next one ------------

(async function () {
  const popup = await openPopup();
  await settle();

  popup.button.click();
  advance(20000);
  popup.deliver({
    type: "PAGE_RESULT_FOR_POPUP",
    result: { analysis: { page_kind: "other", explanation: "Nothing to check." } },
  });

  // The user reads the verdict, then asks for another analysis well inside the
  // first one's two-minute window.
  advance(90000);
  popup.button.click();
  assert.strictEqual(popup.loading.textContent, "Analyzing this page...");

  // Ten seconds into the second analysis the first one's deadline passes.
  advance(15000);

  assert.notStrictEqual(
    popup.loading.textContent,
    TIMED_OUT,
    "the first analysis's timer must not time out the second one"
  );
  assert.strictEqual(popup.button.disabled, true, "the second analysis is still running");
  say("PASS: a spent analysis's timer does not cut short the next one");

  // It does still time out on its own deadline.
  advance(120000);
  assert.strictEqual(popup.loading.textContent, TIMED_OUT);
  assert.strictEqual(popup.button.disabled, false);
  say("PASS: an analysis that really hangs still times out");

  // --- 2. a restored deadline must not apply to a fresh trigger --------------

  // This tab has a run recorded from an add-to-cart click 110 seconds ago that
  // died with its worker: nothing will ever answer for it.
  const popup2 = await openPopup({
    state: { status: "running", key: TAB.url, startedAt: now - 110000 },
    holdState: true,
  });
  await settle();

  // The user, seeing an idle popup, clicks Analyze before the worker answers.
  popup2.button.click();
  popup2.releaseState();
  await settle();

  // Ten seconds later the dead run's deadline passes.
  advance(15000);

  assert.notStrictEqual(
    popup2.loading.textContent,
    TIMED_OUT,
    "a restored deadline must not time out the analysis the user just started"
  );
  assert.strictEqual(popup2.button.disabled, true, "the new analysis is still running");
  say("PASS: a restored deadline does not cut short a freshly triggered analysis");

  // The new analysis's own result is still welcome.
  popup2.deliver({
    type: "PAGE_RESULT_FOR_POPUP",
    result: { analysis: { page_kind: "other", explanation: "Nothing to check." } },
  });
  assert.strictEqual(popup2.loading.style.display, "none");
  assert.strictEqual(popup2.button.disabled, false);
  say("PASS: the freshly triggered analysis still reports its result");

  say("All analysis-timeout checks passed.");

  Date.now = realDateNow;
  process.exit(0);
})().catch((error) => {
  say(String(error && error.message ? error.message : error));
  process.exit(1);
});
