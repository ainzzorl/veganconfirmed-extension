# Everything the extension ships, and nothing else. A file not listed here
# never reaches a store.
SOURCES = manifest.json background.js content.js content.css maps.js maps.css \
          popup.html popup.js pdf_extract.mjs icons vendor LICENSE

STAGE = build/vegan-confirmed
ZIP = build/vegan-confirmed.zip
WEB_EXT = node_modules/.bin/web-ext
CWS = node_modules/.bin/chrome-webstore-upload
VERSION = $(shell node -p "require('./manifest.json').version")

# The flags at the top of background.js are meant to be flipped while testing;
# a build with either one wrong talks to the wrong backend or serves stale
# analyses, and nothing else catches it.
check-flags:
	@grep -q '^const USE_LOCAL_BACKEND = false;$$' background.js || { echo "USE_LOCAL_BACKEND is not false"; exit 1; }
	@grep -q '^const CACHE_ENABLED = true;$$' background.js || { echo "CACHE_ENABLED is not true"; exit 1; }

stage: check-flags
	rm -rf $(STAGE) && mkdir -p $(STAGE) && cp -r $(SOURCES) $(STAGE)/

package: stage
	rm -f $(ZIP) && cd $(STAGE) && zip -qr ../../$(ZIP) .

lint-firefox: stage
	$(WEB_EXT) lint --source-dir=$(STAGE)

# A store submission is tied to one version, so it may only go out from that
# version's release branch.
check-branch:
	@branch=$$(git rev-parse --abbrev-ref HEAD); \
	test "$$branch" = "release/$(VERSION)" || { echo "a deploy must run from release/$(VERSION), not $$branch"; exit 1; }

# Submits a new version to the listed channel on addons.mozilla.org. Needs
# WEB_EXT_API_KEY and WEB_EXT_API_SECRET in .env; see README.
deploy-firefox: check-branch lint-firefox
	@test -f .env || { echo "No .env with WEB_EXT_API_KEY / WEB_EXT_API_SECRET; see README"; exit 1; }
	set -a && . ./.env && set +a && \
	$(WEB_EXT) sign --source-dir=$(STAGE) --artifacts-dir=build \
	  --channel=listed --approval-timeout=0

# Uploads a new version to the Chrome Web Store and submits it for review.
# Needs EXTENSION_ID, PUBLISHER_ID, CLIENT_ID, CLIENT_SECRET and REFRESH_TOKEN
# in .env; see README.
deploy-chrome: check-branch package
	@test -f .env || { echo "No .env with EXTENSION_ID / PUBLISHER_ID / CLIENT_ID / CLIENT_SECRET / REFRESH_TOKEN; see README"; exit 1; }
	set -a && . ./.env && set +a && \
	$(CWS) --source $(ZIP)

.PHONY: check-flags check-branch stage package lint-firefox deploy-firefox deploy-chrome
