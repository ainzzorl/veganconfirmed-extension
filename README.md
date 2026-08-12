# Vegan Confirmed Extension

A browser extension that provides AI-powered vegan analysis of webpage content.

## Features

- **Product pages** (`content.js`) — extracts the page as markdown and asks the
  backend whether the item is vegan, either on demand from the popup or
  automatically when an "add to cart" button is clicked.
- **Restaurant menus on Google Maps** (`maps.js`) — on a Maps place page, a
  "🌱 Check menu" chip appears. It activates the Menu tab, scrolls the place
  panel so lazy-loaded dishes render, and sends the panel text to the backend's
  `/api/analyze-menu`, which returns a vegan verdict per dish. Results are shown
  in the popup, grouped as vegan / likely vegan / unclear / not vegan.

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
