#!/usr/bin/env node
//
// Extraction harness: runs the extension's real `extractPageContent` (from
// content.js) over a saved HTML file using jsdom, and prints the resulting
// payload as JSON. This is the exact content the extension would send to the
// backend for analysis, so the backend analysis eval can test classification on
// production-faithful input without re-implementing the HTML→markdown logic.
//
// Usage:
//   node tools/extract_content.js --html <path> --url <url> [--title <title>]
//
// Output (stdout): a single JSON object
//   { url, title, content, timestamp, trigger_type, trigger_element_text }
//
// `title` defaults to the page's <title> (via jsdom); pass --title to override.

const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      args[key] = value;
      i += 1;
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.html || !args.url) {
    process.stderr.write(
      "Usage: node tools/extract_content.js --html <path> --url <url> [--title <title>]\n"
    );
    process.exit(2);
  }

  const htmlPath = path.resolve(args.html);
  const html = fs.readFileSync(htmlPath, "utf8");

  // Build a DOM that mirrors what the extension sees: `url` populates
  // window.location.href, and the document's <title> populates document.title.
  const dom = new JSDOM(html, { url: args.url });
  global.window = dom.window;
  global.document = dom.window.document;
  global.Node = dom.window.Node;
  global.MutationObserver = dom.window.MutationObserver;
  // `chrome` is intentionally left undefined so content.js skips its load-time
  // side effects (listeners, cart detection) and only exposes the helpers.

  // Optional title override (a saved snapshot may have a generic/empty <title>).
  if (args.title) {
    dom.window.document.title = args.title;
  }

  // Require AFTER globals are installed: content.js reads document/window at
  // module-eval time only inside functions, but the export shim runs at require.
  const { extractPageContent } = require(path.resolve(
    __dirname,
    "..",
    "content.js"
  ));

  const result = extractPageContent("manual", null);
  process.stdout.write(JSON.stringify(result));
}

main();
