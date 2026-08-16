#!/usr/bin/env node
//
// Extraction harness for PDF menus: runs the extension's real `extractPdfText`
// (from pdf_extract.mjs) over a saved PDF and prints the payload the extension
// would send to the backend. The sibling of tools/extract_content.js, so the
// backend analysis eval can hold PDF cases without re-implementing extraction.
//
// Usage:
//   node tools/extract_pdf.js --pdf <path> --url <url> [--title <title>]
//
// Output (stdout): a single JSON object
//   { url, title, content, timestamp, source, trigger_type, ... }
// or, for a PDF with no usable text layer:
//   { error: "no_text_layer", detail: "..." }
// and exit code 3, which the eval records as a case error.

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const NO_TEXT_LAYER_ERROR = "no_text_layer";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      args[arg.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.pdf || !args.url) {
    process.stderr.write(
      "Usage: node tools/extract_pdf.js --pdf <path> --url <url> [--title <title>]\n"
    );
    process.exit(2);
  }

  // pdf.js ships as ESM only, and this file is CommonJS like its sibling.
  const pdfjsLib = await import(
    path.join(ROOT, "node_modules", "pdfjs-dist", "legacy", "build", "pdf.mjs")
  );
  pdfjsLib.GlobalWorkerOptions.workerSrc = require("node:url").pathToFileURL(
    path.join(
      ROOT,
      "node_modules",
      "pdfjs-dist",
      "legacy",
      "build",
      "pdf.worker.mjs"
    )
  ).href;

  const { extractPdfText } = await import(
    require("node:url").pathToFileURL(path.join(ROOT, "pdf_extract.mjs")).href
  );

  const data = new Uint8Array(fs.readFileSync(path.resolve(args.pdf)));
  const result = await extractPdfText(pdfjsLib, { data, useSystemFonts: true });

  if (!result.readable) {
    process.stdout.write(
      JSON.stringify({
        error: NO_TEXT_LAYER_ERROR,
        detail:
          `only ${result.letterWords} word(s) of text across ${result.pagesRead} ` +
          `page(s) — the menu is an image or outlined type`,
      })
    );
    process.exit(3);
  }

  // The browser has no PDF title of its own, so it falls back to the tab title
  // (the filename); here --title stands in for that.
  process.stdout.write(
    JSON.stringify({
      url: args.url,
      title: result.title || args.title || "",
      timestamp: new Date().toISOString(),
      content: result.content,
      language: null,
      source: "pdf",
      trigger_type: "manual",
      trigger_element_text: null,
      trigger_element_selector: null,
    })
  );
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exit(1);
});
