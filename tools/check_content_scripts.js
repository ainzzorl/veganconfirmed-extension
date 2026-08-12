#!/usr/bin/env node
//
// Guard: every content script this extension injects must be able to coexist
// with the others in a single isolated world.
//
// All content scripts for one extension share ONE global scope per frame, so a
// top-level `let`/`const` declared in two of them is a redeclaration — the
// second file dies with "Identifier 'x' has already been declared" before a
// single line of it runs, and the feature silently does nothing. This is easy
// to reintroduce (`enableLogging`, `isAnalyzing`, `log` are natural names in
// any of these files) and invisible until the extension is loaded in a browser.
//
// Each file is injected here as a real classic <script>, which shares the
// global lexical environment exactly as content scripts do. Note that
// `window.eval()` does NOT reproduce the problem — `let` inside eval is scoped
// to the eval — so the <script> element is load-bearing.
//
// Usage: node tools/check_content_scripts.js   (or: npm run check)

const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");

// Files that must not leak these names into the shared scope. maps.js wraps
// itself in an IIFE precisely so it declares nothing globally.
const MUST_NOT_LEAK = {
  "maps.js": [
    "enableLogging",
    "isAnalyzing",
    "chipEl",
    "lastPlaceKey",
    "getPlaceKey",
    "extractPanelText",
    "FTID_RE",
    "MENU_TAB_WORDS",
  ],
};

function contentScriptFiles() {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")
  );
  const files = [];
  for (const entry of manifest.content_scripts || []) {
    for (const file of entry.js || []) {
      if (!files.includes(file)) {
        files.push(file);
      }
    }
  }
  return files;
}

// Load `files` in the given order into one shared scope, returning any errors.
function loadTogether(files) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (e) => errors.push(e));

  const dom = new JSDOM("<body></body>", {
    // A Maps place URL so every script takes its most active code path.
    url: "https://www.google.com/maps/place/Test+Restaurant",
    runScripts: "dangerously",
    virtualConsole,
    beforeParse(w) {
      w.chrome = {
        runtime: { onMessage: { addListener() {} }, sendMessage() {} },
      };
    },
  });

  for (const file of files) {
    const el = dom.window.document.createElement("script");
    el.textContent = fs.readFileSync(path.join(ROOT, file), "utf8");
    dom.window.document.body.appendChild(el);
  }

  return { errors, window: dom.window };
}

function main() {
  const files = contentScriptFiles();
  if (files.length === 0) {
    console.error("No content scripts found in manifest.json");
    process.exit(1);
  }
  console.log(`Content scripts: ${files.join(", ")}`);

  let failed = false;

  // Manifest order is not guaranteed across entries, so check both directions.
  const orders = [files, [...files].reverse()];
  for (const order of orders) {
    const { errors } = loadTogether(order);
    if (errors.length) {
      failed = true;
      console.error(`\nFAIL loading in order: ${order.join(" -> ")}`);
      for (const e of errors) {
        console.error(`  ${e.message}`);
      }
    } else {
      console.log(`  ok: ${order.join(" -> ")}`);
    }
  }

  // Check the no-leak expectations against a clean load.
  const { window } = loadTogether(files);
  for (const [file, names] of Object.entries(MUST_NOT_LEAK)) {
    if (!files.includes(file)) {
      continue;
    }
    for (const name of names) {
      if (window[name] !== undefined) {
        failed = true;
        console.error(
          `\nFAIL: ${file} leaks '${name}' into the shared isolated world`
        );
      }
    }
  }

  if (failed) {
    console.error("\nContent script check failed.");
    process.exit(1);
  }

  console.log("\nAll content scripts coexist cleanly.");
  process.exit(0);
}

main();
