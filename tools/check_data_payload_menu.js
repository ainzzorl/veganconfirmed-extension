#!/usr/bin/env node
//
// Regression: a menu split into collapsible sections renders each section's
// rows only when it is clicked, so the DOM at extraction time holds the section
// headings and nothing else — the dishes live only in the page's embedded JSON
// payload. Reading the DOM alone reported a menu with zero dishes.
//
// extractPageContent mines those payloads, so this asserts what it takes from
// them (dishes, their sections, dishes listed by name alone) and what it must
// not: a section of the payload the page isn't showing, and items the page
// already spells out.
//
// Usage: node tools/check_data_payload_menu.js

const assert = require("assert");
const path = require("path");
const { JSDOM } = require("jsdom");

function extract(html, url = "https://example.com/menu") {
  const dom = new JSDOM(html, { url });
  global.window = dom.window;
  global.document = dom.window.document;
  global.Node = dom.window.Node;
  global.MutationObserver = dom.window.MutationObserver;
  const { extractPageContent } = require(path.resolve(
    __dirname,
    "..",
    "content.js"
  ));
  return extractPageContent("manual", null).content;
}

function menuItem(data) {
  return { menu_item: { id: data.name, data } };
}

// Shaped like a slice-based CMS (Prismic): a section label beside the array of
// items it labels.
function slice(pageName, items) {
  return { primary: { page_name: pageName }, items: items.map(menuItem) };
}

const PAYLOAD = {
  props: {
    pageProps: {
      food_menu: {
        data: {
          body: [
            slice("Shareables", [
              {
                name: "Lettuce Wraps",
                description: "Chicken or tofu / butter lettuce / cashews",
              },
              { name: "Fried Pickles", happy_hour_price: "7" },
            ]),
            slice("Sides", [
              { name: "Charred Green Beans" },
              { name: "Tater Tots" },
            ]),
          ],
        },
      },
      // A different page of the site: its sections are nowhere on this one.
      drinks_menu: {
        data: {
          body: [
            slice("Whiskey", [
              { name: "Rye Old Fashioned", description: "rye / bitters" },
            ]),
          ],
        },
      },
    },
  },
};

// Section triggers with no panel behind them, as React renders a closed
// accordion.
const MENU_PAGE = `<body>
  <h1>Eureka! Menu</h1>
  <section><button aria-label="Show Shareables"><span>Shareables</span></button></section>
  <section><button aria-label="Show Sides"><span>Sides</span></button></section>
  <script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
    PAYLOAD
  )}</script>
</body>`;

// The product page already shows what its JSON-LD repeats.
const PRODUCT_PAGE = `<body>
  <h1>Merino Crewneck</h1>
  <p>Soft merino wool sweater</p>
  <script type="application/ld+json">${JSON.stringify({
    "@type": "Product",
    name: "Merino Crewneck",
    description: "Soft merino wool sweater",
  })}</script>
</body>`;

const BROKEN_PAYLOAD_PAGE = `<body>
  <h1>Menu</h1>
  <script type="application/json">{"items": [{"name": "Fries",</script>
</body>`;

const CHECKS = [
  [
    "a dish that only exists in the payload",
    () => {
      const content = extract(MENU_PAGE);
      assert.match(content, /Lettuce Wraps/);
      assert.match(content, /butter lettuce \/ cashews/);
      assert.match(content, /Fried Pickles — 7/);
    },
  ],
  [
    "the section each dish belongs to",
    () => {
      const content = extract(MENU_PAGE);
      assert.match(content, /### Shareables\n[\s\S]*Lettuce Wraps/);
      assert.match(content, /### Sides\n[\s\S]*Tater Tots/);
    },
  ],
  [
    "a dish listed by name alone",
    () => {
      assert.match(extract(MENU_PAGE), /Charred Green Beans/);
    },
  ],
  [
    "not a payload section the page isn't showing",
    () => {
      const content = extract(MENU_PAGE);
      assert.doesNotMatch(content, /Rye Old Fashioned/);
      assert.doesNotMatch(content, /Whiskey/);
    },
  ],
  [
    "not an item the page already spells out",
    () => {
      const content = extract(PRODUCT_PAGE, "https://example.com/sweater");
      assert.doesNotMatch(content, /Additional items/);
      assert.strictEqual(content.match(/Merino Crewneck/g).length, 1);
    },
  ],
  [
    "an unparseable payload is ignored, not fatal",
    () => {
      assert.doesNotMatch(extract(BROKEN_PAYLOAD_PAGE), /Additional items/);
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
  console.error("\nDATA PAYLOAD MENU TEST FAILED");
  process.exit(1);
}
console.log("\nDATA PAYLOAD MENU TEST PASSED");
