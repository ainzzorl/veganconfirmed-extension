#!/usr/bin/env node
//
// `page_signals` is what a page declares about its own kind — its og:type and
// the schema.org types of its JSON-LD and microdata. The backend prunes the
// page-kind question with it (services/page_scope.py), so this side has one
// job: report what the page says, faithfully and boundedly, without deciding
// anything.
//
// Usage: node tools/check_page_signals.js

const assert = require("assert");
const path = require("path");
const { JSDOM } = require("jsdom");

function load(html, url = "https://example.com/") {
  const dom = new JSDOM(html, { url });
  global.window = dom.window;
  global.document = dom.window.document;
  global.Node = dom.window.Node;
  global.MutationObserver = dom.window.MutationObserver;
  return require(path.resolve(__dirname, "..", "content.js"));
}

function signals(html, url) {
  return load(html, url).collectPageSignals();
}

function ld(data) {
  return `<script type="application/ld+json">${JSON.stringify(
    data
  )}</script>`;
}

// A real restaurant menu: the dishes are declared, and og:type calls the page
// an article anyway. Both facts are reported; neither is judged here.
const MENU_PAGE = `<html><head>
  <meta property="og:type" content="article" />
  ${ld({
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "Restaurant", name: "Clara Junction" },
      {
        "@type": ["Menu", "WebPage"],
        hasMenuSection: [
          {
            "@type": "MenuSection",
            hasMenuItem: [{ "@type": "MenuItem", name: "Dal Tadka" }],
          },
        ],
      },
    ],
  })}
</head><body><h1>Menu</h1></body></html>`;

// Microdata rather than JSON-LD, as older shop templates still emit.
const MICRODATA_PRODUCT_PAGE = `<html><head></head><body>
  <div itemscope itemtype="http://schema.org/Product/">
    <span itemprop="name">Merino Crewneck</span>
  </div>
</body></html>`;

const PLAIN_PAGE = `<html><head><title>About us</title></head><body>Hello.</body></html>`;

const BROKEN_LD_PAGE = `<html><head>
  <meta property="og:type" content="product" />
  <script type="application/ld+json">{"@type": "Product",</script>
</head><body></body></html>`;

// A framework hydration blob is not a declaration about the page, and is
// routinely megabytes of unrelated structure.
const HYDRATION_PAGE = `<html><head></head><body>
  <script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: { widget: { "@type": "Product" } } },
  })}</script>
</body></html>`;

const MANY_TYPES_PAGE = `<html><head>${ld(
  Array.from({ length: 120 }, (_, i) => ({ "@type": `Type${i}` }))
)}</head><body></body></html>`;

const CHECKS = [
  [
    "the schema types a menu declares, nested and multi-valued",
    () => {
      const { schema_types: types } = signals(MENU_PAGE);
      for (const type of ["Menu", "MenuSection", "MenuItem", "Restaurant"]) {
        assert.ok(types.includes(type), `missing ${type} in ${types}`);
      }
    },
  ],
  [
    "the og:type it declares, even when that contradicts the menu",
    () => {
      assert.strictEqual(signals(MENU_PAGE).og_type, "article");
    },
  ],
  [
    "microdata types, reduced to the bare schema.org name",
    () => {
      const { og_type: ogType, schema_types: types } = signals(
        MICRODATA_PRODUCT_PAGE
      );
      assert.deepStrictEqual(types, ["Product"]);
      assert.strictEqual(ogType, null);
    },
  ],
  [
    "null when the page declares nothing",
    () => {
      assert.strictEqual(signals(PLAIN_PAGE), null);
    },
  ],
  [
    "an unparseable block is ignored, not fatal",
    () => {
      const { og_type: ogType, schema_types: types } = signals(BROKEN_LD_PAGE);
      assert.strictEqual(ogType, "product");
      assert.deepStrictEqual(types, []);
    },
  ],
  [
    "not a hydration payload's types",
    () => {
      assert.strictEqual(signals(HYDRATION_PAGE), null);
    },
  ],
  [
    "a site-wide graph cannot grow the payload without bound",
    () => {
      assert.strictEqual(signals(MANY_TYPES_PAGE).schema_types.length, 40);
    },
  ],
  [
    "the extracted payload carries them",
    () => {
      const { extractPageContent } = load(MENU_PAGE, "https://example.com/menu");
      const payload = extractPageContent("manual", null);
      assert.ok(payload.page_signals.schema_types.includes("MenuItem"));
    },
  ],
];

let failures = 0;
for (const [label, check] of CHECKS) {
  try {
    check();
    console.log(`  ok: ${label}`);
  } catch (e) {
    console.error(`  FAIL: ${label}\n    ${e.message}`);
    failures++;
  }
}

if (failures > 0) {
  console.error("\nPAGE SIGNALS TEST FAILED");
  process.exit(1);
}
console.log("\nPAGE SIGNALS TEST PASSED");
