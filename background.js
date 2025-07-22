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
            } else {
                console.log('Analysis failed or timed out');
            }
        });
    }

    // Always send a response to prevent the message port from closing
    sendResponse({ status: 'received' });
});

// Check backend health on startup
async function checkBackendHealth() {
    try {
        const response = await fetch(`${BACKEND_URL}/health`);
        if (response.ok) {
            console.log('Backend is healthy');
        } else {
            console.warn('Backend health check failed');
        }
    } catch (error) {
        console.error('Backend health check error:', error);
    }
}

// Check backend health when extension loads
checkBackendHealth();

// Clean up expired cache on startup and every hour
cleanupExpiredCache();
setInterval(cleanupExpiredCache, 60 * 60 * 1000); // Every hour
