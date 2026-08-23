#!/usr/bin/env node
//
// Regression: the popup renders a menu by walking a fixed list of verdict
// groups and filtering the dishes into them, so a dish whose verdict is not on
// that list matches no group and is simply never drawn — no error, no leftover
// bucket. The backend answers "veganizable" for a dish that the kitchen will
// make vegan on request (fries in the fryer with the wings, pasta without the
// parmesan), and those dishes — the ones a vegan diner most wants to see —
// disappeared from an otherwise complete-looking menu.
//
// Usage: node tools/check_menu_verdict_groups.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const TAB = { id: 7, url: "https://claras-junction.example.com/menu" };

const say = console.log.bind(console);

// One dish per verdict the backend can answer with, so a group dropped from the
// popup's list shows up here as a missing dish.
const MENU = {
  restaurant_name: "Clara's Junction",
  vegan_friendliness: "medium",
  items: [
    { name: "Garden Bowl", verdict: "vegan", reason: "No animal products." },
    { name: "Sourdough Toast", verdict: "likely_vegan", reason: "Bread is likely vegan." },
    // The dish this check exists for, in both shapes the backend sends it:
    // the verdict alone, and the verdict alongside the older boolean flag.
    { name: "Herb Fries", verdict: "veganizable", reason: "Ask for the vegan fryer." },
    { name: "Pesto Pasta", verdict: "veganizable", veganizable: true, reason: "Hold the parmesan." },
    { name: "House Soup", verdict: "unclear", reason: "Stock unknown." },
    { name: "Smash Burger", verdict: "not_vegan", reason: "Beef patty." },
  ],
};

const dom = new JSDOM(fs.readFileSync(path.join(ROOT, "popup.html"), "utf8"), {
  url: "chrome-extension://veganconfirmed/popup.html",
});
global.window = dom.window;
global.document = dom.window.document;

// --- stub chrome -------------------------------------------------------------

const messageListeners = [];

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
    sendMessage: (tabId, message, cb) => {
      if (!cb) return;
      cb(message.type === "GET_PLACE_INFO" ? null : { status: "received" });
    },
    create: () => {},
  },
};

require(path.resolve(ROOT, "popup.js"));
document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));

messageListeners.forEach((fn) =>
  fn(
    {
      type: "PAGE_RESULT_FOR_POPUP",
      result: {
        analysis: {
          page_kind: "restaurant_menu",
          summary: "Some vegan options, more on request.",
          menu: MENU,
        },
      },
    },
    {},
    () => {}
  )
);

const itemsElement = document.getElementById("menuItems");
const rendered = Array.from(itemsElement.querySelectorAll(".menu-item"));

// --- 1. every dish the backend sent is on screen ------------------------------

const renderedNames = rendered.map((row) =>
  row.querySelector(".menu-item-name").textContent.trim()
);

MENU.items.forEach((item) => {
  assert.ok(
    renderedNames.includes(item.name),
    `"${item.name}" (${item.verdict}) was dropped from the menu`
  );
});
assert.strictEqual(
  rendered.length,
  MENU.items.length,
  "no dish should be drawn twice or invented"
);
say("PASS: every verdict the backend can answer with reaches the popup");

// --- 2. veganizable dishes are their own group, not folded into vegan ---------

const titles = Array.from(itemsElement.querySelectorAll(".menu-group-title")).map(
  (node) => node.textContent.trim()
);
assert.ok(
  titles.some((title) => /Can be made vegan \(2\)/.test(title)),
  `expected a group of two veganizable dishes, got: ${titles.join(" | ")}`
);

const fries = rendered[renderedNames.indexOf("Herb Fries")];
assert.ok(
  fries.className.includes("veganizable") && !/\bvegan\b/.test(fries.className),
  `a veganizable dish must not be styled as vegan, got "${fries.className}"`
);
say("PASS: veganizable dishes are grouped on their own");

// --- 3. the per-dish tag does not repeat what the group heading says ----------

const pesto = rendered[renderedNames.indexOf("Pesto Pasta")];
assert.strictEqual(
  pesto.querySelector(".menu-item-tag.veganizable"),
  null,
  "the tag is redundant under the 'Can be made vegan' heading"
);

// It still belongs on a dish that carries the flag under another verdict.
const soup = MENU.items.find((item) => item.name === "House Soup");
soup.veganizable = true;
messageListeners.forEach((fn) =>
  fn(
    {
      type: "PAGE_RESULT_FOR_POPUP",
      result: {
        analysis: { page_kind: "restaurant_menu", summary: "", menu: MENU },
      },
    },
    {},
    () => {}
  )
);
const taggedNames = Array.from(
  document.querySelectorAll("#menuItems .menu-item")
)
  .filter((row) => row.querySelector(".menu-item-tag.veganizable"))
  .map((row) => row.querySelector(".menu-item-name").textContent.trim());
assert.deepStrictEqual(
  taggedNames,
  ["House Soup"],
  "the flag should still tag dishes outside the veganizable group"
);
say("PASS: the 'Can be made vegan' tag lands only where it adds something");

say("All menu verdict-group checks passed.");

// The popup arms a two-minute timeout per trigger; leave rather than wait it out.
process.exit(0);
