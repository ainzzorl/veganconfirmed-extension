#!/usr/bin/env node
//
// Guard: an analysis survives the popup being closed.
//
// The popup closes the moment the user clicks anywhere else, and an analysis
// runs for up to two minutes, so this is the ordinary case rather than an edge
// one. The fetch lives in the service worker and keeps going, but everything
// the user can see used to be lost with the popup: the result was broadcast to
// nobody, and a reopened popup showed no spinner, no result, and a live button
// that would start the whole thing again at the backend's expense.
//
// So the worker records, per tab, what that tab's analysis is doing, and the
// popup restores itself from that record instead of holding the state itself.
// The checks below pin the three things that has to get right:
//
//   1. a `running` record exists from before the request goes out,
//   2. the outcome is recorded even when the broadcast to the popup fails —
//      which is exactly what a closed popup looks like from here,
//   3. a second trigger for the same page joins the first instead of paying
//      for the same answer twice.
//
// background.js is loaded in Node against a stub `chrome`, the way the content
// scripts are in the other guards. Usage: node tools/check_analysis_state.js

const assert = require("assert");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const TAB = 7;
const URL = "https://shop.example.com/oat-milk";

const say = console.log.bind(console);

// --- stub chrome -------------------------------------------------------------

const listeners = [];
const broadcasts = [];
const tabMessages = [];

// Both stores speak callbacks, which is the form that works in both browsers
// and the only form background.js uses. `set` lands synchronously, as the real
// storage does from the caller's point of view, so a record is readable the
// moment the worker says it wrote one.
function store() {
  const data = new Map();
  return {
    data,
    get(keys, cb) {
      const out = {};
      const wanted = keys === null ? [...data.keys()] : keys;
      wanted.forEach((k) => {
        if (data.has(k)) out[k] = data.get(k);
      });
      cb(out);
    },
    set(items, cb) {
      Object.entries(items).forEach(([k, v]) => data.set(k, v));
      if (cb) cb();
    },
    remove(keys, cb) {
      [].concat(keys).forEach((k) => data.delete(k));
      if (cb) cb();
    },
  };
}

const session = store();
const local = store();

global.chrome = {
  runtime: {
    getManifest: () => ({ version: "0.0.0-test" }),
    onMessage: { addListener: (fn) => listeners.push(fn) },
    onConnect: { addListener: () => {} },
    // The popup is closed for the whole of this run, so every broadcast fails
    // the way it does in a browser. Nothing downstream may depend on it.
    sendMessage: (message) => {
      broadcasts.push(message);
      return Promise.reject(new Error("Could not establish connection"));
    },
    lastError: null,
  },
  tabs: {
    sendMessage: (tabId, message) => {
      tabMessages.push({ tabId, message });
      return Promise.resolve();
    },
  },
  storage: { local, session },
  action: {
    setBadgeText: () => {},
    setBadgeBackgroundColor: () => {},
    openPopup: () => {},
  },
  notifications: { create: () => {} },
};

// One deferred backend response, so the test can inspect the world while the
// analysis is still in flight.
let fetchCalls = 0;
let releaseFetch;
const backendResponse = new Promise((resolve) => {
  releaseFetch = resolve;
});
global.fetch = () => {
  fetchCalls += 1;
  return backendResponse;
};

// The worker narrates every step, and two of the checks below deliberately
// provoke a warning; `say` keeps the real console for this guard's own output.
console.log = () => {};
console.warn = () => {};
const background = require(path.resolve(ROOT, "background.js"));

// --- helpers -----------------------------------------------------------------

// Deliver a message to the worker's listener and resolve with its reply.
function send(message, sender = { tab: { id: TAB, url: URL } }) {
  return new Promise((resolve) => {
    listeners.forEach((fn) => fn(message, sender, resolve));
  });
}

// Let queued promise jobs run. The analysis threads several storage reads
// before it reaches the network, so one tick is not enough.
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function record() {
  return session.data.get(background.analysisStateKey(TAB));
}

const payload = { url: URL, title: "Oat milk", content: "oats, water" };
const analysisResult = {
  analysis: { page_kind: "shopping_item", is_vegan: true, summary: "Vegan." },
};

async function main() {
  // --- 1. a running record exists before the request goes out ----------------

  send({ type: "PAGE_FOR_ANALYSIS", payload });

  assert.strictEqual(record().status, "running");
  assert.strictEqual(record().key, URL, "recorded under the cache key");
  assert.ok(record().startedAt > 0, "carries the start time the popup counts from");
  say("running record written before the fetch ->", JSON.stringify(record()));

  // --- 2. a second trigger joins the first -----------------------------------

  await flush();
  assert.strictEqual(fetchCalls, 1, "the first analysis reached the backend");

  await send({ type: "PAGE_FOR_ANALYSIS", payload });
  await flush();
  assert.strictEqual(
    fetchCalls,
    1,
    "a second trigger for the same page must join the analysis in flight, not start another"
  );
  say("second trigger joined the first ->", fetchCalls, "backend call");

  // --- 3. the outcome is recorded even though the popup is closed ------------

  releaseFetch({ ok: true, status: 200, json: async () => analysisResult });
  await flush();

  assert.strictEqual(record().status, "done");
  assert.deepStrictEqual(record().result, analysisResult, "the record carries the result itself");
  assert.ok(record().finishedAt >= record().startedAt);
  assert.ok(
    broadcasts.some((m) => m.type === "PAGE_RESULT_FOR_POPUP"),
    "the live broadcast is still attempted"
  );
  say("done record survived the failed broadcast ->", record().status);

  // The Maps chip is told directly, independently of the popup.
  assert.ok(
    tabMessages.some((m) => m.tabId === TAB && m.message.type === "PAGE_ANALYSIS_DONE"),
    "the originating tab is told the outcome"
  );

  // --- 4. the record is only handed back for the page it describes -----------

  const mine = await send({ type: "GET_ANALYSIS_STATE", tabId: TAB, key: URL });
  assert.strictEqual(mine.record.status, "done", "the tab's own analysis comes back");

  const elsewhere = await send({
    type: "GET_ANALYSIS_STATE",
    tabId: TAB,
    key: "https://shop.example.com/something-else",
  });
  assert.strictEqual(
    elsewhere.record,
    null,
    "a record for a page the tab has since left must not be shown"
  );
  say("state answered for the right page only");

  // --- 4b. a menu record has to prove it is this restaurant's ----------------
  //
  // A Maps URL can carry several place ids (see check_place_key.js), so the
  // key alone is not proof of identity — the same reason the cache stores a
  // `cached_place` and checks it.

  const PLACE = "menu:0xff:0xee";
  await send({
    type: "PAGE_FOR_ANALYSIS",
    payload: {
      url: "https://www.google.com/maps/place/Olive+Branch",
      place_id: "0xff:0xee",
      restaurant_name: "Olive Branch",
    },
  });
  await flush();

  const sameName = await send({
    type: "GET_ANALYSIS_STATE",
    tabId: TAB,
    key: PLACE,
    name: "Olive Branch",
  });
  assert.ok(sameName.record, "the restaurant that was analyzed gets its record");

  const otherName = await send({
    type: "GET_ANALYSIS_STATE",
    tabId: TAB,
    key: PLACE,
    name: "Clara's Junction",
  });
  assert.strictEqual(
    otherName.record,
    null,
    "another restaurant sharing the key must not be shown this menu"
  );
  say("menu record checked against the place on screen");

  // --- 5. extraction failure is recorded too ---------------------------------

  await send({
    type: "PAGE_EXTRACTION_FAILED",
    error: "Menu tab never opened",
    place_id: "0xa:0xb",
  });
  await flush();

  assert.strictEqual(record().status, "error");
  assert.strictEqual(
    record().key,
    "menu:0xa:0xb",
    "filed under the place, as a menu analysis would be"
  );
  assert.strictEqual(record().error, "Menu tab never opened");
  say("extraction failure recorded ->", record().error);

  say("\nanalysis state OK");

  // The worker's hourly sweep would otherwise hold Node open.
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
