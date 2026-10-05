# Vegan Confirmed Extension

A Chrome and Firefox extension that tells you whether what's on a page is vegan.

## Features

Click "🌱 Analyze this page" on any page:

- **Shopping item**: a vegan verdict for the product, its ingredients with the
  animal-derived ones highlighted, and a cruelty-free verdict where relevant.
  Clicking "add to cart" checks the product automatically and alerts you if
  it isn't vegan.
- **Restaurant menu**: a verdict for each dish and a rating for the restaurant.
  Works on restaurant websites, PDF menus and Google Maps place pages.

Each answer can be rated 👍/👎 with an optional comment.

## Build

```sh
npm install
make package        # build/vegan-confirmed.zip
make lint-firefox   # run the AMO validator
```

## Run

Load the repo directory as an unpacked extension:

- **Chrome**: open `chrome://extensions`, enable Developer mode, click
  "Load unpacked" and pick the repo directory.
- **Firefox**: open `about:debugging#/runtime/this-firefox`, click
  "Load Temporary Add-on…" and pick `manifest.json`.

Two flags at the top of `background.js` help with local testing:
`USE_LOCAL_BACKEND` points at a backend on `localhost:5555`, and
`CACHE_ENABLED = false` disables the 24-hour analysis cache. Set them back
before packaging; `make package` refuses otherwise.

## Release

Bump `version` in `manifest.json`, add a `CHANGELOG.md` entry, commit on a
`release/<version>` branch, then run `make deploy-chrome` and
`make deploy-firefox`. Both need credentials in `.env`; see `.env.example`.
