// Regression: a Google Maps menu is often split across sub-tabs ("Lunch",
// "Dinner", "Drinks"), and Maps renders only the selected one. Reading the
// panel as found analyzed whichever sub-tab happened to be open and reported
// its verdict as the whole restaurant's — so a place whose only vegan dishes
// live on the dinner menu looked like it had none.
const assert = require("assert");
const path = require("path");
const { JSDOM } = require("jsdom");

const dom = new JSDOM("<body></body>", {
  url: "https://www.google.com/maps/place/Clara's+Junction/data=!1s0x1:0x2",
});
global.window = dom.window;
global.document = dom.window.document;
global.Node = dom.window.Node;
global.MutationObserver = dom.window.MutationObserver;

const maps = require(path.resolve(__dirname, "..", "maps.js"));

// The dishes behind each sub-tab. Only the first is on screen to begin with.
const MENUS = {
  Lunch: ["Smash Burger $16", "Herb Fries $8"],
  Dinner: ["Birria Tacos $19", "Grilled Cauliflower Steak $17", "Herb Fries $8"],
  Drinks: ["House Margarita $14", "Cold Brew $6"],
};

// A panel shaped like Maps': a role="main" region, the place's own tab row, the
// place chrome (repeated in every whole-panel read), and the menu's own tab row
// inside the region the Menu tab controls.
function buildPanel({
  wireAriaControls = true,
  withStalePanel = false,
  // Maps rebuilds the panel on tab activation instead of hiding the old one —
  // clicking the place's About tab replaces the whole role="main" region — so
  // element references taken before a click can be detached afterwards.
  rebuildOnClick = false,
} = {}) {
  document.body.innerHTML = `
    <div role="main" aria-label="Clara's Junction">
      <h1>Clara's Junction</h1>
      <div role="tablist" id="place-tabs">
        <button role="tab" aria-selected="false" aria-label="Overview of Clara's Junction">Overview</button>
        <button role="tab" aria-selected="true" aria-label="Menu of Clara's Junction"
                ${wireAriaControls ? 'aria-controls="menu-panel"' : ""}>Menu</button>
        <button role="tab" aria-selected="false" aria-label="Reviews for Clara's Junction">Reviews</button>
      </div>
      <div id="place-chrome">
        <div>2221 Tasman Dr, Santa Clara, CA 95054</div>
        <div>Closed · Opens 11 AM Wed</div>
      </div>
      ${
        withStalePanel
          ? `<div role="tablist" id="stale-tabs" style="display: none">
               <button role="tab" aria-selected="true">Old Menu</button>
               <button role="tab" aria-selected="false">Old Drinks</button>
             </div>`
          : ""
      }
      <div id="menu-panel" role="tabpanel">
        <div role="tablist" id="menu-tabs"></div>
        <div id="menu-body"></div>
      </div>
      <div id="place-footer">
        <div>Write a review</div>
        <div>About this data</div>
      </div>
    </div>`;

  const body = document.getElementById("menu-body");

  const render = (name) => {
    body.innerHTML = MENUS[name].map((dish) => `<div>${dish}</div>`).join("");
  };

  const menuTabs = document.getElementById("menu-tabs");

  function mountTabs(selected) {
    menuTabs.innerHTML = "";
    Object.keys(MENUS).forEach((name) => {
      const tab = document.createElement("button");
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(name === selected));
      tab.textContent = name;
      menuTabs.appendChild(tab);
    });
  }

  // Handled on the container, not per button — the way a framework does it, and
  // the reason a detached tab is inert: its click event bubbles through a tree
  // that no longer reaches this listener.
  menuTabs.addEventListener("click", (event) => {
    const tab = event.target.closest('[role="tab"]');
    if (!tab) {
      return;
    }
    const name = tab.textContent;
    if (rebuildOnClick) {
      // Every tab node is thrown away and rebuilt, detaching the one just
      // clicked along with any the sweep is holding on to.
      mountTabs(name);
    } else {
      menuTabs.querySelectorAll('[role="tab"]').forEach((other) => {
        other.setAttribute("aria-selected", String(other === tab));
      });
    }
    render(name);
  });

  mountTabs("Lunch");
  render("Lunch");

  return {
    panel: document.querySelector('div[role="main"]'),
    menuTab: document.querySelector('#place-tabs [aria-label^="Menu"]'),
  };
}

async function main() {
  // --- the sweep itself ---------------------------------------------------
  const { panel, menuTab } = buildPanel({ withStalePanel: true });

  const options = maps.findMenuSectionOptions(panel, menuTab);
  assert.deepStrictEqual(
    options.map((option) => option.textContent),
    ["Lunch", "Dinner", "Drinks"],
    "the menu's own sub-tabs were not found"
  );
  assert.ok(
    !options.some((option) => /^Old /.test(option.textContent)),
    "a display:none leftover tab row was swept"
  );
  console.log("sub-tabs found:", options.map((o) => o.textContent).join(", "));

  const { content, sections } = await maps.extractMenuSections(panel, menuTab);
  assert.deepStrictEqual(sections, ["Lunch", "Dinner", "Drinks"]);

  for (const [name, dishes] of Object.entries(MENUS)) {
    for (const dish of dishes) {
      assert.ok(
        content.includes(dish),
        `REGRESSION: "${dish}" (${name}) is missing — only the open sub-tab was analyzed`
      );
    }
    assert.ok(content.includes(`## ${name}`), `section heading for ${name} missing`);
  }
  console.log("every sub-tab's dishes present, each under its own heading");

  // A dish on two menus keeps both listings; the place chrome is not repeated.
  assert.strictEqual(
    content.split("Herb Fries $8").length - 1,
    2,
    "a dish listed on two menus lost one of its listings"
  );
  assert.strictEqual(
    content.split("2221 Tasman Dr").length - 1,
    1,
    "the place header was repeated once per section"
  );
  assert.strictEqual(
    content.split("About this data").length - 1,
    1,
    "the place footer was repeated once per section"
  );
  console.log("shared chrome collapsed, repeated dishes kept");

  // The user's sub-tab is put back, the way their scroll position is.
  assert.strictEqual(
    document.querySelector('#menu-tabs [role="tab"]').getAttribute("aria-selected"),
    "true",
    "the panel was left on a different sub-tab than the user had open"
  );
  console.log("originally selected sub-tab restored");

  // --- Maps rebuilding the tab row mid-sweep ------------------------------
  // Observed on the real place panel: activating a tab replaces the region
  // rather than hiding it. Holding element references across a click would mean
  // clicking detached nodes, which does nothing and silently loses sections.
  const rebuilt = buildPanel({ rebuildOnClick: true });

  // Guard on the fixture itself: unless a stale tab really is inert, this test
  // would pass just as happily for an implementation that holds references.
  const stale = rebuilt.panel.querySelectorAll('#menu-tabs [role="tab"]')[2];
  rebuilt.panel.querySelectorAll('#menu-tabs [role="tab"]')[1].click();
  const bodyAfterRebuild = document.getElementById("menu-body").textContent;
  stale.click();
  assert.strictEqual(
    document.getElementById("menu-body").textContent,
    bodyAfterRebuild,
    "fixture is not faithful: clicking a detached tab still changed the panel"
  );

  const progress = [];
  const swept = await maps.extractMenuSections(
    rebuilt.panel,
    rebuilt.menuTab,
    (done, total) => progress.push(`${done}/${total}`)
  );
  assert.deepStrictEqual(
    swept.sections,
    ["Lunch", "Dinner", "Drinks"],
    "REGRESSION: sections were lost when Maps rebuilt the tab row mid-sweep"
  );
  for (const dishes of Object.values(MENUS)) {
    for (const dish of dishes) {
      assert.ok(swept.content.includes(dish), `"${dish}" lost across a rebuild`);
    }
  }
  assert.deepStrictEqual(progress, ["1/3", "2/3", "3/3"], "progress not reported");
  console.log("survives Maps rebuilding the tab row, progress reported");

  // --- finding the sub-tabs without aria-controls to scope by --------------
  const loose = buildPanel({ wireAriaControls: false });
  assert.deepStrictEqual(
    maps.findMenuSectionOptions(loose.panel, loose.menuTab).map((o) => o.textContent),
    ["Lunch", "Dinner", "Drinks"],
    "the place's own tab row was mistaken for the menu's"
  );
  console.log("place tab row excluded when there is no aria-controls to scope by");

  // --- places whose menu is not split at all ------------------------------
  const plain = buildPanel();
  document.getElementById("menu-tabs").remove();
  assert.deepStrictEqual(maps.findMenuSectionOptions(plain.panel, plain.menuTab), []);
  const single = await maps.extractMenuSections(plain.panel, plain.menuTab);
  assert.deepStrictEqual(single.sections, []);
  assert.ok(single.content.includes("Smash Burger $16"));
  assert.ok(single.content.includes("2221 Tasman Dr"));
  console.log("un-split menus still read in one pass");

  // A place with no Menu tab at all is still analyzed as shown.
  const noTab = await maps.extractMenuSections(plain.panel, null);
  assert.deepStrictEqual(noTab.sections, []);
  assert.ok(noTab.content.includes("Smash Burger $16"));
  console.log("panel with no Menu tab still analyzed as shown");

  // --- edge trimming in isolation -----------------------------------------
  const split = maps.splitSharedEdges([
    "Clara's\nAddress\nSoup\nWrite a review",
    "Clara's\nAddress\nTacos\nWrite a review",
  ]);
  assert.deepStrictEqual(split.prefix, ["Clara's", "Address"]);
  assert.deepStrictEqual(split.suffix, ["Write a review"]);
  assert.deepStrictEqual(split.middles, [["Soup"], ["Tacos"]]);

  // Identical sections collapse entirely into the shared prefix rather than
  // being emitted twice — and the prefix and suffix never claim the same line.
  const identical = maps.splitSharedEdges(["A\nB", "A\nB"]);
  assert.deepStrictEqual(identical.prefix, ["A", "B"]);
  assert.deepStrictEqual(identical.suffix, []);
  assert.deepStrictEqual(identical.middles, [[], []]);

  // Two sections ending on the same dish keep it, because a third does not.
  const shared = maps.splitSharedEdges([
    "Head\nSoup\nFries\nFoot",
    "Head\nTacos\nFries\nFoot",
    "Head\nCola\nFoot",
  ]);
  assert.deepStrictEqual(shared.prefix, ["Head"]);
  assert.deepStrictEqual(shared.suffix, ["Foot"]);
  assert.deepStrictEqual(shared.middles, [
    ["Soup", "Fries"],
    ["Tacos", "Fries"],
    ["Cola"],
  ]);
  console.log("shared-edge splitting OK");

  console.log("\nMENU SUB-TAB REGRESSION TEST PASSED");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
