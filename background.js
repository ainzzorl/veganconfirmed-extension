// Add logging to verify script loading
console.log('Background script loaded');

// Local testing flags — flip while testing, and back before packaging.
//
// Two independent switches, because the two things they control are wanted at
// different times:
//
//   USE_LOCAL_BACKEND — send requests to LOCAL_BACKEND_URL instead of the
//   production API.
//
//   CACHE_ENABLED — read and write analyses in the cache. Turning it off is
//   what makes a backend or prompt change testable at all: analyses are cached
//   for 24 hours, so with the cache on, the first response for a URL is the
//   only one the extension ever asks for and a change appears to do nothing
//   until the next day. Left on by default, since that is what a normal build
//   wants.
//
// This is the single source of truth for both. popup.js needs CACHE_ENABLED
// too (it reads cached analyses directly) and asks for it over
// GET_CACHE_ENABLED rather than keeping a copy that could drift out of sync.
const USE_LOCAL_BACKEND = false;
const CACHE_ENABLED = true;

// Backend API configuration
const PROD_BACKEND_URL = 'https://api.veganconfirmed.com';
const LOCAL_BACKEND_URL = 'http://localhost:5555';
const BACKEND_URL = USE_LOCAL_BACKEND ? LOCAL_BACKEND_URL : PROD_BACKEND_URL;

// The extension version, sent with every analysis request so the backend can
// record which version a call came from. Read from the manifest rather than
// kept as a second copy here, so bumping the manifest is the only step.
const EXTENSION_VERSION = chrome.runtime.getManifest().version;

// Key under which the installation ID lives in storage.local.
const INSTALLATION_ID_KEY = 'installation_id';

// Cache configuration
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

// How long an analysis record is kept before it is swept. Far longer than any
// analysis: this reclaims records for tabs that were closed, not ones still
// being read.
const ANALYSIS_STATE_TTL = 60 * 60 * 1000;

// The one message the popup shows for an analysis that came back empty.
const ANALYSIS_FAILED_MESSAGE = 'Analysis failed or timed out';

// Popup connection tracking
let popupPort = null;

// Function to clear warning state when popup closes
function clearWarningState() {
    console.log('Popup closed, clearing warning state');

    // Clear the badge
    if (chrome.action) {
        // Manifest V3
        chrome.action.setBadgeText({ text: '' });
    } else if (chrome.browserAction) {
        // Manifest V2
        chrome.browserAction.setBadgeText({ text: '' });
    }

    // Clear the warning analysis data
    chrome.storage.local.remove(['warning_analysis'], function () {
        console.log('Warning analysis data cleared');
    });
}

// Listen for runtime connections (popup open/close detection)
chrome.runtime.onConnect.addListener((port) => {
    if (port.name === 'popup') {
        console.log('Popup opened, connection established');
        popupPort = port;

        // Listen for disconnection (popup close)
        port.onDisconnect.addListener(() => {
            console.log('Popup closed, connection lost');
            popupPort = null;
            clearWarningState();
        });
    }
});


// Function to check if cached analysis is still valid
function isCacheValid(timestamp) {
    return Date.now() - timestamp < CACHE_DURATION;
}

// Function to get cached analysis result
function getCachedAnalysis(url) {
    if (!CACHE_ENABLED) {
        console.log(`Cache BYPASSED (caching disabled) for URL: ${url}`);
        return Promise.resolve(null);
    }

    return new Promise((resolve) => {
        chrome.storage.local.get([`${url}_analysis`, `${url}_cache_timestamp`], (result) => {
            const analysis = result[`${url}_analysis`];
            const timestamp = result[`${url}_cache_timestamp`];

            if (analysis && timestamp && isCacheValid(timestamp)) {
                console.log(`Cache HIT for URL: ${url}`);
                resolve(analysis);
            } else {
                console.log(`Cache MISS for URL: ${url}`);
                resolve(null);
            }
        });
    });
}

// The key an analysis is cached under.
//
// Pages are keyed by URL, but a Google Maps place is keyed by its place id: a
// Maps URL carries the map viewport (`@lat,lng,zoom`) and a `data=` blob that
// both change as the user pans, so the same restaurant is never seen at the
// same URL twice.
function cacheKeyFor(payload) {
    return payload.place_id ? `menu:${payload.place_id}` : payload.url;
}

// --- analysis state ---------------------------------------------------------
//
// One record per tab describing the analysis that tab last started: running,
// done, or failed. The popup is a view of this and keeps nothing of its own
// that has to survive a close.
//
// It has to survive a close because the popup closes the moment the user
// clicks anywhere else, and an analysis can run for two minutes. Without a
// record, a reopened popup looks idle: no spinner for the request still in
// flight, no result for the one that finished while it was shut.
//
// Session storage rather than local, for two reasons. These records are
// worthless once the browser restarts — no analysis outlives it — and keeping
// them out of storage.local leaves cleanupExpiredCache's strict
// `_analysis`/`_cache_timestamp` pairing assumption intact.
function analysisStateKey(tabId) {
    return `analysis:${tabId}`;
}

// Callbacks rather than the promise form the whole way down, matching how
// every other storage call here is written: `chrome.storage` answers a
// callback in both browsers, but only returns a promise in one.
//
// A browser too old to have session storage at all simply keeps no records,
// and the popup falls back to the cache as it did before.
function setAnalysisState(tabId, record) {
    return new Promise((resolve) => {
        if (tabId === undefined || !chrome.storage.session) {
            resolve();
            return;
        }
        chrome.storage.session.set({ [analysisStateKey(tabId)]: record }, resolve);
    });
}

// The record for a tab, but only if it still describes the page that tab is
// showing.
//
// `key` is what the caller believes the tab's analysis would be cached under.
// Comparing it to the record's key is the "did this tab navigate away since
// the analysis started" test — a Maps place panel swaps places without a page
// load, so a tab id alone says nothing about what is on screen.
//
// `name` is checked too where both sides have one, for the same reason
// getCachedPageAnalysis checks it: a Maps URL can carry several place ids, and
// showing one restaurant's menu under another's name is invisible without it.
function getAnalysisState(tabId, key, name) {
    return new Promise((resolve) => {
        if (tabId === undefined || !chrome.storage.session) {
            resolve(null);
            return;
        }

        const stateKey = analysisStateKey(tabId);
        chrome.storage.session.get([stateKey], (stored) => {
            const record = stored[stateKey];

            if (!record || record.key !== key) {
                resolve(null);
                return;
            }

            if (record.name && name && record.name !== name) {
                console.warn(
                    `Analysis record under ${key} is for "${record.name}" but this ` +
                    `page is "${name}". Ignoring it.`
                );
                resolve(null);
                return;
            }

            resolve(record);
        });
    });
}

// Drop records left behind by tabs that have since closed.
//
// Rides along with the cache sweep rather than justifying a tabs.onRemoved
// listener, which would wake the worker on every tab close to reclaim storage
// that dies with the browser anyway.
function cleanupAnalysisState() {
    if (!chrome.storage.session) {
        return;
    }

    chrome.storage.session.get(null, (all) => {
        const now = Date.now();
        const stale = Object.keys(all).filter(key =>
            key.startsWith('analysis:') &&
            now - (all[key].finishedAt || all[key].startedAt || 0) > ANALYSIS_STATE_TTL
        );

        if (stale.length > 0) {
            chrome.storage.session.remove(stale, () => {
                console.log(`Cleaned up ${stale.length} stale analysis records`);
            });
        }
    });
}

// Function to store analysis result in cache
//
// With caching off the cache entry is skipped but history is still written:
// history is a record of what was analyzed, not a source results are served
// from, and it is useful while testing.
//
// For a place-keyed entry the place it was built for is recorded *inside* the
// cached value so a reader can verify the entry really belongs to the place on
// screen. A Maps URL can carry several place ids (see FTID_RE in maps.js), and
// mis-keying one restaurant's menu onto another is both easy to do and
// invisible without this check. Storing it inside the value rather than as a
// sibling key also keeps cleanupExpiredCache's two-key assumption intact.
function storeCachedAnalysis(payload, analysisResult) {
    const timestamp = Date.now();
    const cacheKey = cacheKeyFor(payload);

    if (!CACHE_ENABLED) {
        console.log(`Not caching analysis (caching disabled) for: ${cacheKey}`);
    } else {
        const value = payload.place_id
            ? {
                ...analysisResult,
                cached_place: {
                    key: payload.place_id,
                    name: payload.restaurant_name,
                    url: payload.url
                }
            }
            : analysisResult;

        chrome.storage.local.set({
            [`${cacheKey}_analysis`]: value,
            [`${cacheKey}_cache_timestamp`]: timestamp
        });
        console.log(`Cached analysis result for: ${cacheKey}`);
    }

    // Also save to analysis history
    saveToAnalysisHistory(cacheKey, analysisResult, timestamp, payload);
}

// Truncate a string for storage in the history list, which keeps 50 entries.
function clip(text, limit) {
    if (typeof text !== 'string') {
        return undefined;
    }
    return text.length > limit ? `${text.substring(0, limit)}...` : text;
}

// Function to save an analysis to history
//
// One entry shape for all three page kinds, discriminated by `page_kind`. Menu
// entries carry the per-verdict counts as well, since the history row shows
// "N of M dishes vegan" without reopening the analysis. Entries written before
// the unified flow have no `page_kind` and are read via their old `type` field
// (see resolvePageKind in popup.js).
function saveToAnalysisHistory(cacheKey, analysisResult, timestamp, payload) {
    chrome.storage.local.get(['analysis_history'], function (result) {
        const history = result.analysis_history || [];
        const analysis = analysisResult.analysis || {};
        // The per-kind halves of the response. Only one is ever filled.
        const item = analysis.shopping_item || {};
        const menu = analysis.menu || {};
        const items = menu.items || [];
        const countOf = (verdict) => items.filter(item => item.verdict === verdict).length;

        const historyEntry = {
            id: `${cacheKey}_${timestamp}`,
            page_kind: analysis.page_kind,
            url: payload.url,
            place_key: payload.place_id || undefined,
            timestamp: timestamp,
            date: new Date(timestamp).toLocaleString(),
            title: menu.restaurant_name ||
                payload.restaurant_name ||
                payload.title ||
                getPageTitleFromUrl(payload.url) ||
                'Unknown Page',
            confidence_level: item.confidence_level,
            summary: clip(analysis.summary, 150)
        };

        if (analysis.page_kind === 'restaurant_menu') {
            historyEntry.is_restaurant_menu = true;
            historyEntry.item_count = items.length;
            historyEntry.vegan_count = countOf('vegan');
            historyEntry.likely_vegan_count = countOf('likely_vegan');
            historyEntry.vegan_friendliness = menu.vegan_friendliness;
        } else {
            historyEntry.is_vegan = item.is_vegan;
            historyEntry.is_shopping_item = analysis.page_kind === 'shopping_item';
            historyEntry.is_cruelty_free = item.is_cruelty_free;
        }

        // Add to beginning of history (most recent first)
        history.unshift(historyEntry);

        // Keep only last 50 analyses to prevent storage bloat
        if (history.length > 50) {
            history.splice(50);
        }

        // Save updated history
        chrome.storage.local.set({ 'analysis_history': history }, function () {
            console.log(`Saved analysis to history. Total entries: ${history.length}`);
        });
    });
}

// Function to get page title from URL (fallback)
function getPageTitleFromUrl(url) {
    try {
        const urlObj = new URL(url);
        const hostname = urlObj.hostname;
        const pathname = urlObj.pathname;

        // Extract meaningful title from URL
        if (pathname && pathname !== '/') {
            const pathParts = pathname.split('/').filter(part => part.length > 0);
            if (pathParts.length > 0) {
                const lastPart = pathParts[pathParts.length - 1];
                // Convert kebab-case or snake_case to Title Case
                return lastPart
                    .replace(/[-_]/g, ' ')
                    .replace(/\b\w/g, l => l.toUpperCase());
            }
        }

        return hostname.replace('www.', '');
    } catch (e) {
        return 'Unknown Page';
    }
}

// Return a cached analysis, discarding a place-keyed entry that cannot be
// shown to belong to the place currently on screen.
//
// Entries written before `cached_place` existed are discarded: they came from a
// version that could key one restaurant's analysis under another's id, so they
// cannot be trusted.
async function getCachedPageAnalysis(payload) {
    const cached = await getCachedAnalysis(cacheKeyFor(payload));
    if (!cached) {
        return null;
    }

    // A URL-keyed entry needs no identity check: the key is the identity.
    if (!payload.place_id) {
        return cached;
    }

    const cachedPlace = cached.cached_place;
    if (!cachedPlace) {
        console.warn('Discarding menu cache entry with no place record (written by an older version)');
        return null;
    }

    if (cachedPlace.name && payload.restaurant_name &&
        cachedPlace.name !== payload.restaurant_name) {
        console.warn(
            `Menu cache key collision: entry under ${payload.place_id} is for ` +
            `"${cachedPlace.name}" but this page is "${payload.restaurant_name}". Re-analyzing.`
        );
        return null;
    }

    return cached;
}

// React to a finished analysis: badge the toolbar, and force the popup open
// when a product needs the user's attention before they buy it.
//
// Only the product warning is interruptive. A menu badge is informational — a
// restaurant with no vegan dishes is worth knowing but not worth hijacking the
// screen for — and an "other" page says nothing at all.
function applyAnalysisOutcome(analysis) {
    if (!analysis) {
        return;
    }

    if (analysis.page_kind === 'restaurant_menu') {
        setMenuBadge(analysis);
        return;
    }

    if (analysis.page_kind === 'shopping_item') {
        if (analysis.shopping_item && analysis.shopping_item.is_vegan === false) {
            console.log('Non-vegan shopping item detected, triggering popup');
            triggerWarningPopup(analysis);
        }
        return;
    }

    // Neither a product nor a menu: nothing to flag.
    const action = chrome.action || chrome.browserAction;
    if (action) {
        action.setBadgeText({ text: '' });
    }
}

// Analyses currently in flight, keyed the way the cache is.
//
// This is the only place the backend is called, so one map covers every
// trigger: the popup button, an add-to-cart click. It matters
// most for a popup reopened mid-analysis, which cannot see the request it
// started and would otherwise pay for the same answer a second time.
//
// Per worker generation and deliberately not persisted — a promise from a
// worker that no longer exists cannot be joined. The durable half of the guard
// is the `running` record, which keeps the popup from offering the button.
const inFlight = new Map();

// Send a rating, and any comment with it, for one analysis.
//
// Deliberately carries no installation_id or extension version, unlike an
// analysis request: the analysis being rated already records who asked for it,
// and the rater is that same user.
//
// The rating goes as soon as a thumb is clicked and a comment, if the user
// writes one, follows in a second call; the backend merges them onto the one
// record.
async function sendAnalysisFeedback(analysisId, rating, comment) {
    const response = await fetch(`${BACKEND_URL}/api/feedback`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            analysis_id: analysisId,
            rating: rating,
            comment: comment || undefined
        })
    });

    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }

    console.log(`Sent '${rating}' feedback for ${analysisId}`);
}

// Function to send a page to the backend for analysis
//
// One path for every page. Which extractor produced the payload (the generic
// one in content.js or the Maps panel reader in maps.js) only affects how it
// is keyed and labelled — the analysis itself is the same request.
function sendPageAnalysis(payload) {
    const key = cacheKeyFor(payload);

    const running = inFlight.get(key);
    if (running) {
        console.log(`Joining analysis already in flight for: ${key}`);
        return running;
    }

    const analysis = runPageAnalysis(payload).finally(() => {
        inFlight.delete(key);
    });
    inFlight.set(key, analysis);
    return analysis;
}

// Identifies this installation to the backend, so calls can be grouped without
// leaning on the client IP. Minted on first analysis rather than on install, so
// installations predating this field get one too.
//
// It is not an identity: a reinstall, a new browser profile, or clearing the
// extension's data all produce a fresh ID, and nothing stops a caller sending
// whatever it likes. Fine for grouping and rough counts, not for anything that
// has to be trusted.
let installationIdPromise = null;

function getInstallationId() {
    if (!installationIdPromise) {
        installationIdPromise = new Promise((resolve) => {
            chrome.storage.local.get([INSTALLATION_ID_KEY], (result) => {
                const existing = result[INSTALLATION_ID_KEY];
                if (existing) {
                    resolve(existing);
                    return;
                }

                const id = crypto.randomUUID();
                chrome.storage.local.set({ [INSTALLATION_ID_KEY]: id }, () => resolve(id));
            });
        });
    }
    return installationIdPromise;
}

async function runPageAnalysis(payload) {
    try {
        console.log('Sending page for AI analysis:', payload.url);

        // Check cache first
        const cachedResult = await getCachedPageAnalysis(payload);
        if (cachedResult) {
            console.log('Using cached analysis result');
            applyAnalysisOutcome(cachedResult.analysis);
            return cachedResult;
        }

        const installationId = await getInstallationId();

        const payloadWithSettings = {
            ...payload,
            extension_version: EXTENSION_VERSION,
            installation_id: installationId
        };

        console.log(`Analyzing against ${BACKEND_URL}`);
        const response = await fetch(`${BACKEND_URL}/api/analyze`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payloadWithSettings)
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const analysisResult = await response.json();
        console.log('AI analysis result:', analysisResult);

        // Store the analysis result in cache
        storeCachedAnalysis(payload, analysisResult);
        applyAnalysisOutcome(analysisResult.analysis);

        return analysisResult;
    } catch (error) {
        console.error('Error sending page for analysis:', error);
        return null;
    }
}

// Badge the toolbar icon with the number of vegan dishes found. Unlike the
// non-vegan product warning this is informational, so it does not force the
// popup open or raise a notification.
function setMenuBadge(analysis) {
    const items = (analysis && analysis.menu && analysis.menu.items) || [];
    const veganCount = items.filter(item =>
        item.verdict === 'vegan' || item.verdict === 'likely_vegan'
    ).length;

    const action = chrome.action || chrome.browserAction;
    if (!action) {
        return;
    }

    if (veganCount > 0) {
        action.setBadgeText({ text: String(veganCount) });
        action.setBadgeBackgroundColor({ color: '#4CAF50' });
    } else {
        action.setBadgeText({ text: '0' });
        action.setBadgeBackgroundColor({ color: '#ff9800' });
    }
}

// Function to trigger warning popup for non-vegan items
function triggerWarningPopup(analysis) {
    console.log('Triggering non-vegan popup for analysis:', analysis);

    const badgeColor = '#f44336';

    // Store the analysis data for the popup to access
    chrome.storage.local.set({
        'warning_analysis': analysis
    });

    // Show a notification to alert the user
    chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'Vegan Confirmed Warning',
        message: 'Item requires attention! Click the extension icon for details.'
    });

    // Set badge to indicate warning
    // Support both Manifest V2 and V3
    if (chrome.action) {
        // Manifest V3
        chrome.action.setBadgeText({ text: '!' });
        chrome.action.setBadgeBackgroundColor({ color: badgeColor });
        // Doesn't quite work for Firefox at the moment
        chrome.action.openPopup();
    } else if (chrome.browserAction) {
        // Manifest V2
        chrome.browserAction.setBadgeText({ text: '!' });
        chrome.browserAction.setBadgeBackgroundColor({ color: badgeColor });
        chrome.browserAction.openPopup();
    }
}



// Function to clean up expired cache entries
function cleanupExpiredCache() {
    chrome.storage.local.get(null, (items) => {
        const keysToRemove = [];
        const now = Date.now();

        // Find all cache timestamp keys
        Object.keys(items).forEach(key => {
            if (key.endsWith('_cache_timestamp')) {
                const timestamp = items[key];
                if (!isCacheValid(timestamp)) {
                    const url = key.replace('_cache_timestamp', '');
                    keysToRemove.push(key);
                    keysToRemove.push(`${url}_analysis`);
                    console.log(`Removing expired cache for URL: ${url}`);
                }
            }
        });

        // Remove expired cache entries
        if (keysToRemove.length > 0) {
            chrome.storage.local.remove(keysToRemove, () => {
                console.log(`Cleaned up ${keysToRemove.length / 2} expired cache entries`);
            });
        }
    });
}

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('Message received:', message);

    // The popup asks for CACHE_ENABLED so the flag stays defined in one place.
    if (message.type === 'GET_CACHE_ENABLED') {
        sendResponse({ cache_enabled: CACHE_ENABLED });
        return;
    }

    // The popup's thumbs-up/down, and the comment that may follow it. Routed
    // through here because the popup does not talk to the backend; it also
    // means a popup closed the instant after a click does not cancel the call.
    if (message.type === 'SEND_ANALYSIS_FEEDBACK') {
        sendAnalysisFeedback(message.analysis_id, message.rating, message.comment)
            .then(() => sendResponse({ ok: true }))
            .catch(error => sendResponse({ ok: false, error: String(error) }));
        return true; // response is async
    }

    // A reopened popup asks what its tab is doing. Answered from the record
    // rather than from `inFlight`, so it survives the worker being recycled.
    if (message.type === 'GET_ANALYSIS_STATE') {
        getAnalysisState(message.tabId, message.key, message.name).then(record => {
            sendResponse({ record: record });
        });
        return true; // response is async
    }

    if (message.type === 'PAGE_FOR_ANALYSIS') {
        console.log('Received page for analysis:', message.payload?.url);

        const tabId = sender.tab?.id;
        const key = cacheKeyFor(message.payload);
        const startedAt = Date.now();

        // The place this was built for, carried so a reader can check the
        // record really belongs to the place on screen (see getAnalysisState).
        const name = message.payload?.restaurant_name;

        // Recorded before the request goes out, not after it comes back: the
        // whole point is to be there for a popup that opens while it runs.
        setAnalysisState(tabId, {
            status: 'running',
            key: key,
            name: name,
            startedAt: startedAt
        });

        sendPageAnalysis(message.payload).then(result => {
            setAnalysisState(tabId, result
                ? {
                    status: 'done',
                    key: key,
                    name: name,
                    startedAt: startedAt,
                    finishedAt: Date.now(),
                    result: result
                }
                : {
                    status: 'error',
                    key: key,
                    name: name,
                    startedAt: startedAt,
                    finishedAt: Date.now(),
                    error: ANALYSIS_FAILED_MESSAGE
                });

            // maps.js holds an in-flight flag while it waits for a verdict, so
            // the originating tab is told the outcome as well as the popup.
            // Other pages simply have no listener for it.
            const tabMessage = result
                ? { type: 'PAGE_ANALYSIS_DONE', result: result }
                : { type: 'PAGE_ANALYSIS_FAILED' };

            if (tabId !== undefined) {
                chrome.tabs.sendMessage(tabId, tabMessage).catch(error => {
                    console.log('Could not send result to tab:', error);
                });
            }

            // Best effort: with the popup shut there is nobody listening, and
            // the record above is what the next open reads instead.
            chrome.runtime.sendMessage(
                result
                    ? { type: 'PAGE_RESULT_FOR_POPUP', result: result }
                    : { type: 'PAGE_ERROR_FOR_POPUP', error: ANALYSIS_FAILED_MESSAGE }
            ).catch(error => {
                console.log('Could not send result to popup:', error);
            });
        });
    }

    if (message.type === 'PAGE_EXTRACTION_FAILED') {
        console.log('Page extraction failed:', message.error);

        const error = message.error || 'Could not read the content on this page';

        // Extraction fails within a second of the trigger, so the popup is
        // almost always still open to hear it — but it is recorded like any
        // other outcome so a reopen does not show a blank, idle popup.
        setAnalysisState(sender.tab?.id, {
            status: 'error',
            key: cacheKeyFor({ place_id: message.place_id, url: sender.tab?.url }),
            startedAt: Date.now(),
            finishedAt: Date.now(),
            error: error
        });

        chrome.runtime.sendMessage({
            type: 'PAGE_ERROR_FOR_POPUP',
            error: error
        }).catch(error => {
            console.log('Could not send error to popup:', error);
        });
    }

    // Always send a response to prevent the message port from closing
    sendResponse({ status: 'received' });
});



// Clean up expired cache and stale analysis records on startup and every hour
function runCleanup() {
    cleanupExpiredCache();
    cleanupAnalysisState();
}

runCleanup();
setInterval(runCleanup, 60 * 60 * 1000); // Every hour

// Expose helpers to Node-based tooling/tests (no-op in a browser).
if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        cacheKeyFor,
        analysisStateKey
    };
}
