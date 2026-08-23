#!/usr/bin/env node
//
// The feedback controls under an analysis: a thumb, then an optional comment.
//
// Two things this pins down. The thumb is sent the moment it is clicked, not
// held until a comment is written — most people click and close, and that
// click is the signal. And an analysis with no `analysis_id` shows no controls
// at all: there would be nothing to attach a rating to, and a thumb that
// silently did nothing would be worse than none.
//
// Usage: node tools/check_feedback_widget.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const TAB = { id: 7, url: "https://example.com/soap" };
const ANALYSIS_ID = "abc123";

const say = console.log.bind(console);

const dom = new JSDOM(fs.readFileSync(path.join(ROOT, "popup.html"), "utf8"), {
  url: "chrome-extension://veganconfirmed/popup.html",
});
global.window = dom.window;
global.document = dom.window.document;

// --- stub chrome -------------------------------------------------------------

const messageListeners = [];
// Every feedback call the popup made, in order.
const sentFeedback = [];
// What the worker answers with; flipped to a failure in the last check.
let feedbackSucceeds = true;

function answer(message) {
  if (message.type === "GET_CACHE_ENABLED") return { cache_enabled: true };
  if (message.type === "GET_ANALYSIS_STATE") return { record: null };
  if (message.type === "SEND_ANALYSIS_FEEDBACK") {
    sentFeedback.push(message);
    return { ok: feedbackSucceeds };
  }
  return { status: "received" };
}

global.chrome = {
  runtime: {
    lastError: undefined,
    connect: () => ({ onDisconnect: { addListener() {} } }),
    sendMessage: (message, cb) => {
      if (cb) cb(answer(message));
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

require(path.resolve(ROOT, "popup.js"));
document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));

const analyzeButton = document.getElementById("analyzeButton");
const feedback = document.getElementById("feedback");
const commentBox = document.getElementById("feedbackCommentBox");
const comment = document.getElementById("feedbackComment");
const status = document.getElementById("feedbackStatus");

function deliver(message) {
  messageListeners.forEach((fn) => fn(message, {}, () => {}));
}

function analysisResult(analysisId) {
  return {
    type: "PAGE_RESULT_FOR_POPUP",
    result: {
      analysis: { page_kind: "shopping_item", shopping_item: { is_vegan: true } },
      analysis_id: analysisId,
    },
  };
}

// --- 1. no id, no controls ---------------------------------------------------

analyzeButton.click();
deliver(analysisResult(undefined));

assert.strictEqual(
  feedback.style.display,
  "none",
  "an analysis the backend could not store has nothing to rate"
);
say("PASS: an analysis with no id shows no feedback controls");

// --- 2. a thumb is sent on click, before any comment -------------------------

analyzeButton.click();
deliver(analysisResult(ANALYSIS_ID));

assert.strictEqual(feedback.style.display, "block", "controls should be showing");
assert.strictEqual(commentBox.style.display, "none", "comment box starts hidden");

document.getElementById("feedbackDown").click();

assert.deepStrictEqual(
  sentFeedback.map((m) => [m.analysis_id, m.rating, m.comment]),
  [[ANALYSIS_ID, "down", undefined]],
  "the thumb alone should have gone out already"
);
assert.strictEqual(
  commentBox.style.display,
  "block",
  "the comment box should open once a thumb is clicked"
);
assert.strictEqual(status.textContent, "", "a sent rating should report nothing");
say("PASS: a thumb is sent on click, and opens the comment box");

// --- 3. the comment follows, carrying the same rating ------------------------

comment.value = "  It is Dove soap, it has tallow.  ";
document.getElementById("feedbackSend").click();

assert.deepStrictEqual(sentFeedback[1], {
  type: "SEND_ANALYSIS_FEEDBACK",
  analysis_id: ANALYSIS_ID,
  rating: "down",
  comment: "It is Dove soap, it has tallow.",
});
assert.strictEqual(commentBox.style.display, "none", "the box should close");
assert.ok(
  document.getElementById("feedbackPrompt").textContent.includes("Thanks"),
  "the user should be told it went"
);
say("PASS: the comment follows with the rating already given");

// --- 4. a failed send says so and leaves the controls usable -----------------

feedbackSucceeds = false;
document.getElementById("feedbackUp").click();

assert.ok(status.className.includes("error"), "a failure should be styled as one");
assert.ok(status.textContent.length > 0, "a failure should say so");
feedbackSucceeds = true;
say("PASS: a send that fails is reported");

// --- 5. an error clears the controls -----------------------------------------

analyzeButton.click();
deliver(analysisResult(ANALYSIS_ID));
assert.strictEqual(feedback.style.display, "block");

deliver({ type: "PAGE_ERROR_FOR_POPUP", error: "Analysis failed." });

assert.strictEqual(
  feedback.style.display,
  "none",
  "there is nothing to rate once the analysis has failed"
);
say("PASS: a failed analysis leaves no feedback controls behind");

say("All feedback-widget checks passed.");

// The popup arms a two-minute timeout per trigger; leave rather than wait.
process.exit(0);
