# Vegan Confirmed Extension

A browser extension that provides AI-powered vegan analysis of webpage content.

## Features

One button — "🌱 Analyze this page" — works anywhere. The extension sends the
page to the backend's `/api/analyze`, which decides what it is looking at and
answers accordingly:

- **A shopping item** — a vegan verdict for the product, plus a cruelty-free
  verdict for the product types that call for one.
- **A restaurant menu** — one verdict per dish, shown in the popup grouped as
  vegan / likely vegan / can be made vegan / unclear / not vegan, with a
  restaurant-level rating. This works on a restaurant's own website as well as
  on Google Maps.
- **Neither** — the popup says so plainly. Most of the web is neither, so this
  is a normal answer rather than an error.

Every answer carries a 👍/👎 under it, with an optional comment box. The thumb
goes to the backend the moment it is clicked, and a comment, if one is written,
follows and merges onto the same record. Both refer to the `analysis_id` the
backend returns alongside the analysis, so an answer it could not store shows
no controls rather than dead ones.

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

### PDF menus

Plenty of restaurants publish their menu as a PDF. `content.js` recognises one
from `document.contentType` and reads its text layer with pdf.js
(`pdf_extract.mjs`) instead of the DOM, which would otherwise yield an empty
page — Chrome's viewer is a single `<embed>`, and the markdown extractor strips
those. The text goes to the backend in the ordinary `content` field, so a PDF
menu is analyzed by exactly the same path as an HTML one.

pdf.js is ~1.8MB and almost no page is a PDF, so it is not a content script:
`vendor/pdf.min.mjs` and `pdf_extract.mjs` are web-accessible ES modules that
`content.js` pulls in with a dynamic `import()` only once it has seen a PDF.

Menus whose type was converted to vector outlines (a common export from design
tools) carry no readable text — often only the prices survive. The extractor
counts letter-words per page and reports "no readable text" below the threshold
rather than sending prices with no dish names, which the model would fill in by
inventing them.

Firefox is a known gap: it renders PDFs in a privileged `resource://` viewer
where content scripts do not run, so the popup falls back to its generic
"Could not analyze this page".

## Local testing flags

Two independent flags at the top of `background.js`, both meant to be flipped
while testing and set back before packaging:

- `USE_LOCAL_BACKEND` — send requests to a backend running on this machine
  (`http://localhost:5555`, the backend's default port) instead of production.
  It ships as `false`, so a normal build always talks to production.
- `CACHE_ENABLED` — read and write the analysis cache. It ships as `true`.

Turn `CACHE_ENABLED` off whenever a prompt or backend change has to be visible.
Analyses are cached per URL (and per place, for menus) for 24 hours, so with it
on, the first response for a page is the only one the extension ever asks for
and a change appears to do nothing until the next day. With it off nothing is
read from or written to the cache; History is still recorded, and cache entries
written earlier are left untouched.

`background.js` is the only place the flags are defined. `popup.js` needs
`CACHE_ENABLED` too, because it reads cached analyses out of storage directly
to show a result as soon as it opens, and it asks for the value over a
`GET_CACHE_ENABLED` message rather than keeping a second copy to forget to flip.

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

## Releasing

Bump `version` in `manifest.json`, add a `CHANGELOG.md` entry, and put both on
a branch named `release/<version>` — `make deploy-firefox` refuses to run
anywhere else, so a submission always traces to one branch. Then:

- **Chrome** — `make package`, and upload `build/vegan-confirmed.zip` by hand.
- **Firefox** — `make deploy-firefox` submits the version to the listed channel
  on addons.mozilla.org and returns without waiting for review. Listing
  metadata (screenshots, categories, description) is edited in the Developer
  Hub, not from here.

Both package from `build/vegan-confirmed`, which holds exactly the files named
in the Makefile's `SOURCES` — the dev tooling and these docs are not shipped.
`make check-flags`, which both depend on, refuses to build unless the two
local-testing flags above are back at their shipping values.

`make deploy-firefox` needs AMO credentials: `cp .env.example .env` and fill in
a key pair from addons.mozilla.org/developers/addon/api/key/. `.env` is
gitignored.

`make lint-firefox` runs the AMO validator locally without uploading anything.

# veganconfirmed-extension
