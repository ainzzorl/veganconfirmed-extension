# Vegan Confirmed Extension

A browser extension that provides AI-powered vegan analysis of webpage content.

## Features

One button — "🌱 Analyze this page" — works anywhere. The extension sends the
page to the backend's `/api/analyze`, which decides what it is looking at and
answers accordingly:

- **A shopping item** — a vegan verdict for the product, plus a cruelty-free
  verdict for the product types that call for one.
- **A restaurant menu** — one verdict per dish, shown in the popup grouped as
  vegan / likely vegan / unclear / not vegan, with a restaurant-level rating.
  This works on a restaurant's own website as well as on Google Maps.
- **Neither** — the popup says so plainly. Most of the web is neither, so this
  is a normal answer rather than an error.

Two extractors feed that one analysis, and which one runs is the only thing the
page's URL still decides:

- `content.js` (all URLs) extracts the page as markdown. It also triggers
  automatically when an "add to cart" button is clicked, and a non-vegan
  product forces the popup open.
- `maps.js` (Google Maps place pages) puts a "🌱 Check menu" chip on the page
  and reads the place panel instead: it activates the Menu tab and scrolls so
  lazy-loaded dishes render, which the generic extractor cannot do.

Both content scripts receive the popup's trigger and divide the work by URL, so
exactly one of them answers. `tools/check_extractor_ownership.js` enforces that
— if both replied the page would be analyzed twice, and if neither did the
button would appear dead.

## Local testing mode

Set `DEV_MODE = true` at the top of `background.js` to test against a backend
running on this machine (`http://localhost:5555`, the backend's default port),
then reload the extension. Set it back to `false` before packaging — it ships
as `false`, so a normal build always talks to production.

Caching is disabled along with the endpoint on purpose. Analyses are cached per
URL (and per place, for menus) for 24 hours, so without it the first response
for a page would be the only one the extension ever asks for — a prompt or
backend change would appear to do nothing until the next day. In this mode
nothing is read from or written to the cache; History is still recorded, and
cache entries written in normal mode are left untouched.

`background.js` is the only place the flag is defined. `popup.js` needs it too,
because it reads cached analyses out of storage directly to show a result as
soon as it opens, and it asks for the value over a `GET_DEV_MODE` message
rather than keeping a second copy to forget to flip.

### Notes on the Google Maps integration

- Maps' generated class names are unstable, so `maps.js` anchors on the
  accessibility tree (`role="main"`, `role="tab"`) and hands *text* to the
  backend — turning that text into structured dishes is the model's job. This
  keeps the extension resilient to Maps' markup changing.
- Menu results are cached per *place*, not per URL: a Maps URL embeds the map
  viewport, which changes whenever the user pans, so the stable feature id from
  the `data=` blob is used as the cache key instead.
- Not every restaurant has a menu on Maps — many only link out to one or show
  photos. "No menu found on this page" is a normal result, not an error.
- To support an additional Google ccTLD, add it to the `maps.js` entry in
  `manifest.json`.

# veganconfirmed-extension
