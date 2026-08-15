// Add logging to verify script loading
console.log('Background script loaded');

// Local testing mode — flip to true while testing against a backend running on
// this machine, and back to false before packaging.
//
// It does two things: requests go to LOCAL_BACKEND_URL, and analyses are
// neither read from nor written to the cache. Without the second part a local
// run is nearly untestable — the first response for a URL is the only one the
// extension ever asks for, so a prompt or backend change appears to have no
// effect for the next 24 hours.
//
// This is the single source of truth for the flag. popup.js needs it too (it
// reads cached analyses directly) and asks for it over GET_DEV_MODE rather than
// keeping a copy that could drift out of sync with this one.
const DEV_MODE = false;

// Backend API configuration
const PROD_BACKEND_URL = 'https://api.veganconfirmed.com';
const LOCAL_BACKEND_URL = 'http://localhost:5555';
const BACKEND_URL = DEV_MODE ? LOCAL_BACKEND_URL : PROD_BACKEND_URL;

// Cache configuration
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

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
    if (DEV_MODE) {
        console.log(`Cache BYPASSED (local testing mode) for URL: ${url}`);
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

// Function to store analysis result in cache
//
// In local testing mode the cache entry is skipped but history is still
// written: history is a record of what was analyzed, not a source results are
// served from, and it is useful while testing.
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

    if (DEV_MODE) {
        console.log(`Not caching analysis (local testing mode) for: ${cacheKey}`);
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
        const items = analysis.items || [];
        const countOf = (verdict) => items.filter(item => item.verdict === verdict).length;

        const historyEntry = {
            id: `${cacheKey}_${timestamp}`,
            page_kind: analysis.page_kind,
            url: payload.url,
            place_key: payload.place_id || undefined,
            timestamp: timestamp,
            date: new Date(timestamp).toLocaleString(),
            title: analysis.restaurant_name ||
                payload.restaurant_name ||
                payload.title ||
                getPageTitleFromUrl(payload.url) ||
                'Unknown Page',
            confidence_level: analysis.confidence_level,
            summary: clip(analysis.summary, 150),
            explanation: clip(analysis.explanation, 150),
            user_avoided_ingredients: analysis.user_avoided_ingredients || []
        };

        if (analysis.page_kind === 'restaurant_menu') {
            historyEntry.is_restaurant_menu = analysis.is_restaurant_menu;
            historyEntry.item_count = items.length;
            historyEntry.vegan_count = countOf('vegan');
            historyEntry.likely_vegan_count = countOf('likely_vegan');
            historyEntry.vegan_friendliness = analysis.vegan_friendliness;
        } else {
            historyEntry.is_vegan = analysis.is_vegan;
            historyEntry.is_shopping_item = analysis.is_shopping_item;
            historyEntry.is_cruelty_free = analysis.is_cruelty_free;
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
        if (analysis.is_vegan === false) {
            console.log('Non-vegan shopping item detected, triggering popup');
            triggerWarningPopup(analysis, 'non_vegan');
        }

        if (analysis.user_avoided_ingredients &&
            analysis.user_avoided_ingredients.length > 0) {
            console.log('User avoided ingredients detected, triggering popup');
            triggerWarningPopup(analysis, 'avoided_ingredients');
        }
        return;
    }

    // Neither a product nor a menu: nothing to flag.
    const action = chrome.action || chrome.browserAction;
    if (action) {
        action.setBadgeText({ text: '' });
    }
}

// Function to send a page to the backend for analysis
//
// One path for every page. Which extractor produced the payload (the generic
// one in content.js or the Maps panel reader in maps.js) only affects how it
// is keyed and labelled — the analysis itself is the same request.
async function sendPageAnalysis(payload) {
    try {
        console.log('Sending page for AI analysis:', payload.url);

        // Check cache first
        const cachedResult = await getCachedPageAnalysis(payload);
        if (cachedResult) {
            console.log('Using cached analysis result');
            applyAnalysisOutcome(cachedResult.analysis);
            return cachedResult;
        }

        // Get user's avoided ingredients from storage
        const avoidedIngredients = await new Promise((resolve) => {
            chrome.storage.local.get(['custom_ingredients'], function (result) {
                resolve(result.custom_ingredients || []);
            });
        });

        // Add avoided ingredients to the payload for analysis
        const payloadWithSettings = {
            ...payload,
            user_avoided_ingredients: avoidedIngredients
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
    const items = (analysis && analysis.items) || [];
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

// Function to trigger warning popup for non-vegan items or items with avoided ingredients
function triggerWarningPopup(analysis, type = 'non_vegan') {
    console.log(`Triggering ${type} popup for analysis:`, analysis);

    // Determine badge color based on type
    const badgeColor = type === 'avoided_ingredients' ? '#ff9800' : '#f44336'; // Orange for avoided ingredients, Red for non-vegan

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

    // The popup asks for DEV_MODE so the flag stays defined in one place.
    if (message.type === 'GET_DEV_MODE') {
        sendResponse({ dev_mode: DEV_MODE });
        return;
    }

    if (message.type === 'PAGE_FOR_ANALYSIS') {
        console.log('Received page for analysis:', message.payload?.url);

        const tabId = sender.tab?.id;

        sendPageAnalysis(message.payload).then(result => {
            // The Maps chip lives in the content script, so the originating tab
            // is told the outcome as well as the popup. Pages without a chip
            // simply have no listener for it.
            const tabMessage = result
                ? { type: 'PAGE_ANALYSIS_DONE', result: result }
                : { type: 'PAGE_ANALYSIS_FAILED' };

            if (tabId !== undefined) {
                chrome.tabs.sendMessage(tabId, tabMessage).catch(error => {
                    console.log('Could not send result to tab:', error);
                });
            }

            chrome.runtime.sendMessage(
                result
                    ? { type: 'PAGE_RESULT_FOR_POPUP', result: result }
                    : { type: 'PAGE_ERROR_FOR_POPUP', error: 'Analysis failed or timed out' }
            ).catch(error => {
                console.log('Could not send result to popup:', error);
            });
        });
    }

    if (message.type === 'PAGE_EXTRACTION_FAILED') {
        console.log('Page extraction failed:', message.error);

        chrome.runtime.sendMessage({
            type: 'PAGE_ERROR_FOR_POPUP',
            error: message.error || 'Could not read the content on this page'
        }).catch(error => {
            console.log('Could not send error to popup:', error);
        });
    }

    // Always send a response to prevent the message port from closing
    sendResponse({ status: 'received' });
});



// Clean up expired cache on startup and every hour
cleanupExpiredCache();
setInterval(cleanupExpiredCache, 60 * 60 * 1000); // Every hour
