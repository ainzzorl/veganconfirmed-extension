// Add logging to verify script loading
console.log('Background script loaded');

// Backend API configuration
//const BACKEND_URL = 'http://localhost:5555';
const BACKEND_URL = 'https://api.veganconfirmed.com';

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

// Function to store analysis result in cache
function storeCachedAnalysis(url, analysisResult, contentTitle = null) {
    const timestamp = Date.now();
    chrome.storage.local.set({
        [`${url}_analysis`]: analysisResult,
        [`${url}_cache_timestamp`]: timestamp
    });
    console.log(`Cached analysis result for URL: ${url}`);

    // Also save to analysis history
    saveToAnalysisHistory(url, analysisResult, timestamp, contentTitle);
}

// Function to save analysis to history
function saveToAnalysisHistory(url, analysisResult, timestamp, contentTitle = null) {
    chrome.storage.local.get(['analysis_history'], function (result) {
        const history = result.analysis_history || [];

        // Create history entry
        const historyEntry = {
            id: `${url}_${timestamp}`,
            url: url,
            timestamp: timestamp,
            date: new Date(timestamp).toLocaleString(),
            title: contentTitle || analysisResult.page_title || getPageTitleFromUrl(url) || 'Unknown Page',
            is_vegan: analysisResult.analysis?.is_vegan,
            is_shopping_item: analysisResult.analysis?.is_shopping_item,
            is_cruelty_free: analysisResult.analysis?.is_cruelty_free,
            confidence_level: analysisResult.analysis?.confidence_level,
            summary: analysisResult.analysis?.summary?.substring(0, 100) + (analysisResult.analysis?.summary?.length > 100 ? '...' : ''),
            explanation: analysisResult.analysis?.explanation?.substring(0, 150) + (analysisResult.analysis?.explanation?.length > 150 ? '...' : ''),
            user_avoided_ingredients: analysisResult.analysis?.user_avoided_ingredients || []
        };

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

// Function to save a menu analysis to history
//
// Menu entries share the history list with single-item entries but carry
// `type: 'menu'`; entries written before menu support existed have no `type`
// and are treated as items.
function saveMenuToAnalysisHistory(placeKey, analysisResult, timestamp, payload) {
    chrome.storage.local.get(['analysis_history'], function (result) {
        const history = result.analysis_history || [];
        const analysis = analysisResult.analysis || {};
        const items = analysis.items || [];

        const countOf = (verdict) => items.filter(item => item.verdict === verdict).length;

        const historyEntry = {
            id: `${placeKey}_${timestamp}`,
            type: 'menu',
            url: payload.url,
            place_key: placeKey,
            timestamp: timestamp,
            date: new Date(timestamp).toLocaleString(),
            title: analysis.restaurant_name || payload.restaurant_name || 'Restaurant',
            is_restaurant_menu: analysis.is_restaurant_menu,
            item_count: items.length,
            vegan_count: countOf('vegan'),
            likely_vegan_count: countOf('likely_vegan'),
            vegan_friendliness: analysis.vegan_friendliness,
            confidence_level: analysis.confidence_level,
            summary: analysis.summary?.substring(0, 150) + (analysis.summary?.length > 150 ? '...' : '')
        };

        history.unshift(historyEntry);

        if (history.length > 50) {
            history.splice(50);
        }

        chrome.storage.local.set({ 'analysis_history': history }, function () {
            console.log(`Saved menu analysis to history. Total entries: ${history.length}`);
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

// Function to send content analysis to backend
async function sendContentAnalysis(content) {
    try {
        console.log('Sending content for AI analysis:', content.url);

        // Check cache first
        const cachedResult = await getCachedAnalysis(content.url);
        if (cachedResult) {
            console.log('Using cached analysis result');

            // Check if cached result indicates non-vegan shopping item and trigger popup
            if (cachedResult.analysis &&
                cachedResult.analysis.is_shopping_item === true &&
                cachedResult.analysis.is_vegan === false) {
                console.log('Non-vegan shopping item detected from cache, triggering popup');
                triggerWarningPopup(cachedResult.analysis, 'non_vegan');
            }

            // Check if cached result includes user avoided ingredients and trigger popup
            if (cachedResult.analysis &&
                cachedResult.analysis.user_avoided_ingredients &&
                cachedResult.analysis.user_avoided_ingredients.length > 0) {
                console.log('User avoided ingredients detected from cache, triggering popup');
                triggerWarningPopup(cachedResult.analysis, 'avoided_ingredients');
            }

            return cachedResult;
        }

        // Get user's avoided ingredients from storage
        const avoidedIngredients = await new Promise((resolve) => {
            chrome.storage.local.get(['custom_ingredients'], function (result) {
                resolve(result.custom_ingredients || []);
            });
        });

        // Add avoided ingredients to the content for analysis
        const contentWithSettings = {
            ...content,
            user_avoided_ingredients: avoidedIngredients
        };

        const response = await fetch(`${BACKEND_URL}/api/analyze`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(contentWithSettings)
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const analysisResult = await response.json();
        console.log('AI analysis result:', analysisResult);

        // Store the analysis result in cache
        storeCachedAnalysis(content.url, analysisResult, content.title);

        // Check if result indicates non-vegan shopping item and trigger popup
        if (analysisResult.analysis &&
            analysisResult.analysis.is_shopping_item === true &&
            analysisResult.analysis.is_vegan === false) {
            console.log('Non-vegan shopping item detected, triggering popup');
            triggerWarningPopup(analysisResult.analysis, 'non_vegan');
        }

        // Check if result includes user avoided ingredients and trigger popup
        if (analysisResult.analysis &&
            analysisResult.analysis.user_avoided_ingredients &&
            analysisResult.analysis.user_avoided_ingredients.length > 0) {
            console.log('User avoided ingredients detected, triggering popup');
            triggerWarningPopup(analysisResult.analysis, 'avoided_ingredients');
        }

        return analysisResult;
    } catch (error) {
        console.error('Error sending content for analysis:', error);
        return null;
    }
}

// Menu analyses are cached per *place*, not per URL: a Google Maps URL carries
// the map viewport (`@lat,lng,zoom`) and a `data=` blob that both change as the
// user pans, so the same restaurant is never seen at the same URL twice.
function menuCacheKey(placeKey) {
    return `menu:${placeKey}`;
}

// Function to store a menu analysis in cache (and history)
//
// The place the analysis was built for is recorded *inside* the cached value so
// a reader can verify the entry really belongs to the place on screen. A Maps
// URL can carry several place ids (see FTID_RE in maps.js), and mis-keying one
// restaurant's menu onto another is both easy to do and invisible without this
// check. Storing it inside the value rather than as a sibling key also keeps
// cleanupExpiredCache's two-key assumption intact.
function storeCachedMenuAnalysis(placeKey, analysisResult, payload) {
    const timestamp = Date.now();

    if (placeKey) {
        const cacheKey = menuCacheKey(placeKey);
        chrome.storage.local.set({
            [`${cacheKey}_analysis`]: {
                ...analysisResult,
                cached_place: {
                    key: placeKey,
                    name: payload.restaurant_name,
                    url: payload.url
                }
            },
            [`${cacheKey}_cache_timestamp`]: timestamp
        });
        console.log(`Cached menu analysis for place: ${placeKey} (${payload.restaurant_name})`);
    }

    saveMenuToAnalysisHistory(placeKey, analysisResult, timestamp, payload);
}

// Return a cached menu analysis only if it demonstrably belongs to this place.
//
// Entries written before `cached_place` existed are discarded: they came from a
// version that could key one restaurant's analysis under another's id, so they
// cannot be trusted.
function getCachedMenuAnalysis(payload) {
    return new Promise(async (resolve) => {
        if (!payload.place_id) {
            resolve(null);
            return;
        }

        const cached = await getCachedAnalysis(menuCacheKey(payload.place_id));
        if (!cached) {
            resolve(null);
            return;
        }

        const cachedPlace = cached.cached_place;
        if (!cachedPlace) {
            console.warn('Discarding menu cache entry with no place record (written by an older version)');
            resolve(null);
            return;
        }

        if (cachedPlace.name && payload.restaurant_name &&
            cachedPlace.name !== payload.restaurant_name) {
            console.warn(
                `Menu cache key collision: entry under ${payload.place_id} is for ` +
                `"${cachedPlace.name}" but this page is "${payload.restaurant_name}". Re-analyzing.`
            );
            resolve(null);
            return;
        }

        resolve(cached);
    });
}

// Function to send a restaurant menu to the backend for analysis
async function sendMenuAnalysis(payload) {
    try {
        console.log('Sending menu for AI analysis:', payload.restaurant_name, payload.url);

        // Check cache first (only possible when we resolved a stable place key)
        const cachedResult = await getCachedMenuAnalysis(payload);
        if (cachedResult) {
            console.log(
                `Using cached menu analysis for "${cachedResult.cached_place.name}" ` +
                `(${cachedResult.analysis?.items?.length || 0} dishes)`
            );
            setMenuBadge(cachedResult.analysis);
            return cachedResult;
        }

        // Get user's avoided ingredients from storage
        const avoidedIngredients = await new Promise((resolve) => {
            chrome.storage.local.get(['custom_ingredients'], function (result) {
                resolve(result.custom_ingredients || []);
            });
        });

        const payloadWithSettings = {
            ...payload,
            user_avoided_ingredients: avoidedIngredients
        };

        const response = await fetch(`${BACKEND_URL}/api/analyze-menu`, {
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
        console.log('Menu analysis result:', analysisResult);

        storeCachedMenuAnalysis(payload.place_id, analysisResult, payload);
        setMenuBadge(analysisResult.analysis);

        return analysisResult;
    } catch (error) {
        console.error('Error sending menu for analysis:', error);
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

    if (message.type === 'CONTENT_FOR_ANALYSIS') {
        console.log('Received content for analysis:', message.content);

        // Send content analysis to backend (will check cache first)
        sendContentAnalysis(message.content).then(result => {
            if (result) {
                console.log('Analysis completed successfully');

                // Send the result directly to the popup
                chrome.runtime.sendMessage({
                    type: 'ANALYSIS_RESULT_FOR_POPUP',
                    result: result
                }).catch(error => {
                    console.log('Could not send result to popup:', error);
                });
            } else {
                console.log('Analysis failed or timed out');

                // Send error message directly to popup
                chrome.runtime.sendMessage({
                    type: 'ANALYSIS_ERROR_FOR_POPUP',
                    error: 'Analysis failed or timed out'
                }).catch(error => {
                    console.log('Could not send error to popup:', error);
                });
            }
        });
    }

    if (message.type === 'MENU_FOR_ANALYSIS') {
        console.log('Received menu for analysis:', message.payload?.restaurant_name);

        const tabId = sender.tab?.id;

        sendMenuAnalysis(message.payload).then(result => {
            // The chip lives in the content script, so the originating tab is
            // told the outcome as well as the popup.
            const tabMessage = result
                ? { type: 'MENU_ANALYSIS_DONE', result: result }
                : { type: 'MENU_ANALYSIS_FAILED' };

            if (tabId !== undefined) {
                chrome.tabs.sendMessage(tabId, tabMessage).catch(error => {
                    console.log('Could not send menu result to tab:', error);
                });
            }

            chrome.runtime.sendMessage(
                result
                    ? { type: 'MENU_RESULT_FOR_POPUP', result: result }
                    : { type: 'MENU_ERROR_FOR_POPUP', error: 'Menu analysis failed or timed out' }
            ).catch(error => {
                console.log('Could not send menu result to popup:', error);
            });
        });
    }

    if (message.type === 'MENU_EXTRACTION_FAILED') {
        console.log('Menu extraction failed:', message.error);

        chrome.runtime.sendMessage({
            type: 'MENU_ERROR_FOR_POPUP',
            error: message.error || 'Could not read the menu on this page'
        }).catch(error => {
            console.log('Could not send menu error to popup:', error);
        });
    }

    // Always send a response to prevent the message port from closing
    sendResponse({ status: 'received' });
});



// Clean up expired cache on startup and every hour
cleanupExpiredCache();
setInterval(cleanupExpiredCache, 60 * 60 * 1000); // Every hour
