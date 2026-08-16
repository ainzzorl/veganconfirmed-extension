// Text extraction for PDF menus, shared by the extension and the backend's
// analysis eval.
//
// Restaurants publish menus as PDFs at least as often as HTML, and the page
// extractor can do nothing with one: Chrome's viewer is an `<embed>`, which
// `extractPageContent` strips. This turns the PDF's own text layer into the
// same kind of plain text the extension already sends, so it travels in the
// existing `content` field and both analysis providers read it unchanged.
//
// pdf.js is passed in rather than imported: the extension loads it from
// `vendor/` as a web-accessible module, and the Node harness from
// `node_modules`. Keeping the load out of here leaves this file pure logic.
//
// PDFs whose text layer is missing (scans) or decorative (design tools often
// convert menu type to vector outlines, leaving only the prices as real text)
// are reported as unreadable rather than analyzed. Half a menu's prices with no
// dish names is not something a model can decline to answer — it will fill the
// gap with dishes that were never there.

// Menus run to a few pages; anything longer is a wine list or a brochure, and
// the backend's token budget would cut it long before the last page anyway.
export const MAX_PDF_PAGES = 20;

// Words of three or more letters, per page, below which the text layer is
// treated as decorative rather than the menu itself. Real menus clear this by
// a wide margin (a two-page bistro menu runs to several hundred); an outlined
// one leaves only prices, addresses and phone numbers behind.
export const MIN_LETTER_WORDS_PER_PAGE = 40;

const LETTER_WORD = /[A-Za-zÀ-ÖØ-öø-ÿ]{3,}/g;

// A PDF's own Title is often the source document's filename ("MENU.cdr",
// "menu-final-v3.docx"), which is worse than nothing as a restaurant name.
const FILENAME_TITLE = /\.(pdf|cdr|docx?|indd|ai|pages|pub|qxp)$/i;

export function countLetterWords(text) {
  return (text.match(LETTER_WORD) || []).length;
}

// Assemble one page's text items into lines.
//
// pdf.js reports each run of glyphs with its position, in content-stream order
// — which is not reading order. Grouping by baseline and sorting by x
// reconstructs the lines, and that is what keeps a dish next to its price and
// its description: the single most important thing for the per-dish verdicts
// downstream.
//
// Menus are usually laid out in columns, so items from neighbouring columns
// share a baseline and land on the same line. They are separated by a run of
// spaces (the same thing `pdftotext -layout` does) rather than by trying to
// detect the columns, which is guesswork on a design-led layout and fails in
// ways that are hard to see.
export function buildPageText(items) {
  const glyphs = items.filter((item) => item.str && item.str.trim());
  const lines = [];

  for (const item of glyphs) {
    const y = item.transform[5];
    const size = Math.abs(item.transform[3]) || item.height || 10;
    // Tolerance scales with the type size so a heading and its superscript stay
    // on one line without merging two lines of body copy.
    let line = lines.find((l) => Math.abs(l.y - y) <= Math.max(2, size * 0.5));
    if (!line) {
      line = { y, size, items: [] };
      lines.push(line);
    }
    line.items.push(item);
    line.size = Math.max(line.size, size);
  }

  lines.sort((a, b) => b.y - a.y);

  const out = [];
  let previousY = null;

  for (const line of lines) {
    line.items.sort((a, b) => a.transform[4] - b.transform[4]);

    // A vertical gap wider than a line is a section break in every menu ever
    // printed; keeping it tells the model where one section ends.
    if (previousY !== null && previousY - line.y > line.size * 1.8) {
      out.push("");
    }

    let text = "";
    let end = null;
    for (const item of line.items) {
      const x = item.transform[4];
      if (end !== null) {
        const gap = x - end;
        if (gap > line.size * 2) {
          text += "   ";
        } else if (gap > line.size * 0.15) {
          text += " ";
        }
      }
      text += item.str;
      end = x + item.width;
    }

    out.push(text.replace(/\s+$/, ""));
    previousY = line.y;
  }

  return out.join("\n");
}

// The best name this document offers, or null. Callers fall back to the browser
// tab's title, which for a PDF is the filename.
export function documentTitle(metadata) {
  const title = (metadata?.info?.Title || "").trim();
  if (!title || FILENAME_TITLE.test(title)) {
    return null;
  }
  return title;
}

// Read a PDF's text layer.
//
// `source` is passed to pdf.js as-is — `{ url }` in the extension, `{ data }`
// in the Node harness.
//
// Returns `{ readable, content, title, pageCount, pagesRead, truncated,
// letterWords }`. When `readable` is false the text layer was too thin to be
// the menu, and `content` is returned anyway for diagnostics only.
export async function extractPdfText(pdfjsLib, source, options = {}) {
  const maxPages = options.maxPages || MAX_PDF_PAGES;
  const doc = await pdfjsLib.getDocument(source).promise;

  try {
    const pagesRead = Math.min(doc.numPages, maxPages);
    const pages = [];

    for (let number = 1; number <= pagesRead; number += 1) {
      const page = await doc.getPage(number);
      try {
        const content = await page.getTextContent();
        pages.push(buildPageText(content.items));
      } finally {
        page.cleanup();
      }
    }

    const content = pages.join("\n\n").trim();
    const letterWords = countLetterWords(content);

    let title = null;
    try {
      title = documentTitle(await doc.getMetadata());
    } catch (error) {
      // Metadata is a nicety; a PDF without it still has a menu in it.
    }

    return {
      readable: letterWords >= MIN_LETTER_WORDS_PER_PAGE * pagesRead,
      content,
      title,
      pageCount: doc.numPages,
      pagesRead,
      truncated: doc.numPages > pagesRead,
      letterWords,
    };
  } finally {
    await doc.destroy();
  }
}
