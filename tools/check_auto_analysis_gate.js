#!/usr/bin/env node
//
// Guard: the two gates that keep the automatic (add-to-cart) flow off pages
// that sell nothing.
//
// Both are exclusions, never classifications, and both are silent when they
// fire — a regression here shows up as an LLM bill, not as an error. So the
// cases that must NOT be gated are as load-bearing as the ones that must:
// a product page carrying no og:type at all (Amazon) has to stay analyzable.
//
// Usage: node tools/check_auto_analysis_gate.js

const path = require("path");
const { JSDOM } = require("jsdom");

const CASES = [
  {
    name: "sponsored ad creative inside a rel=sponsored anchor",
    html: `<a href="https://ads.example/x" target="_blank" rel="noopener sponsored">
             <button>Buy Now</button>
           </a>`,
    detected: 0,
  },
  {
    name: "add-to-cart button on a normal page",
    html: `<button>Add to cart</button>`,
    detected: 1,
  },
  {
    // Both the anchor and the button match, as they always have — the point
    // here is that an ordinary anchor is not mistaken for a paid placement.
    name: "add-to-cart button inside an ordinary anchor",
    html: `<a href="/product/1"><button>Add to cart</button></a>`,
    detected: 2,
  },
  {
    name: "video page declares og:type",
    head: `<meta property="og:type" content="video.other">`,
    html: `<button>Buy Now</button>`,
    detected: 1,
    nonShoppingKind: "video.other",
  },
  {
    name: "product page declaring nothing (Amazon)",
    html: `<button>Add to cart</button>`,
    detected: 1,
    nonShoppingKind: null,
  },
  {
    name: "product page declaring og:type=website (thredUP)",
    head: `<meta property="og:type" content="website">`,
    html: `<button>Add to cart</button>`,
    detected: 1,
    nonShoppingKind: null,
  },
  {
    name: "product page declaring og:type=product",
    head: `<meta property="og:type" content="product">`,
    html: `<button>Add to cart</button>`,
    detected: 1,
    nonShoppingKind: null,
  },
  {
    name: "review article with a buy button",
    head: `<meta property="og:type" content="article">`,
    html: `<button>Buy Now</button>`,
    detected: 1,
    nonShoppingKind: null,
  },
];

function run() {
  const failures = [];

  for (const testCase of CASES) {
    const dom = new JSDOM(
      `<!doctype html><html><head>${testCase.head || ""}</head>
       <body>${testCase.html}</body></html>`,
      { url: "https://example.com/page" }
    );
    global.window = dom.window;
    global.document = dom.window.document;
    global.Node = dom.window.Node;
    global.MutationObserver = dom.window.MutationObserver;

    // Re-required per case: the module reads the globals installed above.
    delete require.cache[require.resolve(path.resolve(__dirname, "..", "content.js"))];
    const { detectAddToCartButtons, declaredNonShoppingKind } = require(
      path.resolve(__dirname, "..", "content.js")
    );

    const detected = detectAddToCartButtons().length;
    if (detected !== testCase.detected) {
      failures.push(
        `${testCase.name}: detected ${detected} button(s), expected ${testCase.detected}`
      );
    }

    if ("nonShoppingKind" in testCase) {
      const kind = declaredNonShoppingKind();
      if (kind !== testCase.nonShoppingKind) {
        failures.push(
          `${testCase.name}: og:type gate returned ${JSON.stringify(kind)}, ` +
            `expected ${JSON.stringify(testCase.nonShoppingKind)}`
        );
      }
    }
  }

  if (failures.length) {
    for (const failure of failures) {
      process.stderr.write(`FAIL ${failure}\n`);
    }
    process.exit(1);
  }

  process.stdout.write(`OK ${CASES.length} automatic-analysis gate cases\n`);
}

run();
