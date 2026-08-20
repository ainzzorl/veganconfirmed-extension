// Simple HTML sanitization function
function sanitizeHTML(text) {
    if (typeof text !== 'string') return '';

    // Create a temporary div to escape HTML
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Local testing mode, defined by DEV_MODE in background.js and asked for here
// rather than duplicated. The popup reads cached analyses straight out of
// storage to show a result the moment it opens, so it has to honour the same
// cache bypass — otherwise a stale result would appear while testing even
// though the background never serves one.
function isDevMode() {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'GET_DEV_MODE' }, function (response) {
            // On error (worker not up yet) assume normal mode: showing a cached
            // result is the harmless direction to fail in.
            resolve(!chrome.runtime.lastError && response && response.dev_mode === true);
        });
    });
}

// What kind of page an analysis describes. Written by the backend as
// `page_kind`; entries cached or recorded before the unified flow have none, so
// they are read from the fields those versions did write.
function resolvePageKind(analysis) {
    if (!analysis) {
        return 'other';
    }
    if (analysis.page_kind) {
        return analysis.page_kind;
    }
    if (analysis.is_restaurant_menu !== undefined || analysis.type === 'menu') {
        return 'restaurant_menu';
    }
    return analysis.is_shopping_item === true ? 'shopping_item' : 'other';
}

// Initialize popup
document.addEventListener('DOMContentLoaded', function () {
    const analyzeButton = document.getElementById('analyzeButton');
    const loadingDiv = document.getElementById('loading');
    const contentDiv = document.getElementById('content');

    const BUTTON_LABEL = '\u{1F331} Analyze this page';

    // One ceiling for every page. The popup can no longer know in advance
    // whether it is waiting on a one-line product verdict or sixty per-dish
    // ones, and a restaurant page off Maps is just as slow as one on it. Real
    // failures still arrive early via PAGE_ERROR_FOR_POPUP, so the long
    // timeout only bites on a genuine hang.
    const ANALYSIS_TIMEOUT_MS = 120000;

    // Establish connection to background script for popup close detection
    const port = chrome.runtime.connect({ name: 'popup' });

    // Whether a live message has already put something on screen.
    //
    // Restoring state on open is asynchronous, so an analysis that lands in
    // the moment between the popup opening and that answer coming back would
    // be rendered and then covered over by the spinner for an analysis that
    // has, by then, already finished. The listener sets this; the restore
    // path stands down when it is set.
    let liveUpdateShown = false;

    // Whether an analysis is still waiting on an outcome. The timeout reads
    // this rather than the loading element, which stays on screen after a
    // failure to carry the error message.
    let analysisPending = false;

    // Setup tab functionality
    setupTabs();

    // Load history on startup
    loadAnalysisHistory();

    // First check if we have warning analysis data (from forced popup opening)
    chrome.storage.local.get(['warning_analysis'], function (result) {
        if (result.warning_analysis) {
            // Display the warning analysis immediately
            displayPageAnalysis(result.warning_analysis, true);
            // Clear the stored data to prevent showing it again
            chrome.storage.local.remove(['warning_analysis']);
            // Note: Badge will be cleared when popup closes via background script
            return;
        }

        // If no warning analysis, pick up whatever this tab was left doing
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
            restoreAnalysisState(tabs[0]);
        });

        // Note: Badge will be cleared when popup closes via background script
    });

    // Add click event listener to analyze button
    analyzeButton.addEventListener('click', function () {
        triggerAnalysis();
    });

    // Add click event listener to clear history button
    document.getElementById('clearHistoryBtn').addEventListener('click', function () {
        if (confirm('Are you sure you want to clear all analysis history? This cannot be undone.')) {
            clearAnalysisHistory();
        }
    });

    // Add click event listener to add custom ingredient button
    document.getElementById('addCustomIngredient').addEventListener('click', function () {
        addCustomIngredient();
    });

    // Add enter key listener for custom ingredient input
    document.getElementById('customIngredient').addEventListener('keypress', function (e) {
        if (e.key === 'Enter') {
            addCustomIngredient();
        }
    });

    function setupTabs() {
        const tabButtons = document.querySelectorAll('.tab-button');
        const tabContents = document.querySelectorAll('.tab-content');

        tabButtons.forEach(button => {
            button.addEventListener('click', function () {
                const targetTab = this.getAttribute('data-tab');

                // Update active tab button
                tabButtons.forEach(btn => btn.classList.remove('active'));
                this.classList.add('active');

                // Update active tab content
                tabContents.forEach(content => content.classList.remove('active'));
                document.getElementById(`${targetTab}-tab`).classList.add('active');

                // Reload history if switching to history tab
                if (targetTab === 'history') {
                    loadAnalysisHistory();
                }

                // Load settings if switching to settings tab
                if (targetTab === 'settings') {
                    loadSettings();
                }
            });
        });
    }

    function loadAnalysisHistory() {
        chrome.storage.local.get(['analysis_history'], function (result) {
            const history = result.analysis_history || [];
            const historyContent = document.getElementById('history-content');
            const clearHistoryBtn = document.getElementById('clearHistoryBtn');

            if (history.length === 0) {
                historyContent.innerHTML = '<div class="history-empty">No analysis history yet. Start analyzing pages to see your history here!</div>';
                clearHistoryBtn.style.display = 'none';
                return;
            }

            clearHistoryBtn.style.display = 'block';

            const historyHTML = history.map(item => {
                let statusText = 'Unknown';
                let statusClass = 'unknown';

                // Menu entries summarise a whole restaurant. Entries written
                // before the unified flow carry `type: 'menu'` instead of a
                // `page_kind`; resolvePageKind reads both.
                const pageKind = resolvePageKind(item);

                if (pageKind === 'restaurant_menu') {
                    const veganTotal = (item.vegan_count || 0) + (item.likely_vegan_count || 0);
                    statusClass = 'menu';
                    statusText = item.is_restaurant_menu === false
                        ? '\u{1F374} No menu found'
                        : `\u{1F374} ${veganTotal} of ${item.item_count || 0} dishes vegan`;

                    return `
                        <div class="history-item" data-url="${sanitizeHTML(item.url)}">
                            <div class="history-title">${sanitizeHTML(item.title)}</div>
                            <div class="history-date">${sanitizeHTML(item.date)}</div>
                            <div class="history-status ${statusClass}">${sanitizeHTML(statusText)}</div>
                            ${item.confidence_level ? `<div class="history-confidence">Confidence: ${sanitizeHTML(item.confidence_level.toUpperCase())}</div>` : ''}
                            ${item.summary ? `<div class="history-summary">${sanitizeHTML(item.summary)}</div>` : ''}
                        </div>
                    `;
                }

                if (pageKind !== 'shopping_item') {
                    statusText = 'Not a product or a menu';
                    statusClass = 'not-shopping';
                } else if (item.is_vegan === true) {
                    statusText = 'Vegan';
                    statusClass = 'vegan';
                } else if (item.is_vegan === false) {
                    statusText = 'Not Vegan';
                    statusClass = 'not-vegan';

                    // Add confidence-based styling for non-vegan items in history
                    if (item.confidence_level) {
                        const confidence = item.confidence_level.toLowerCase();
                        statusClass += ` ${confidence}-confidence`;
                    }
                }

                // Build cruelty-free status HTML (only for applicable products)
                let crueltyFreeHTML = '';
                if (item.is_cruelty_free !== null && item.is_cruelty_free !== undefined) {
                    if (item.is_cruelty_free === true) {
                        crueltyFreeHTML = '<span class="history-cruelty-status cruelty-free">🐰 Cruelty-Free</span>';
                    } else if (item.is_cruelty_free === false) {
                        crueltyFreeHTML = '<span class="history-cruelty-status not-cruelty-free">⚠️ Not Cruelty-Free</span>';
                    }
                }

                return `
                    <div class="history-item" data-url="${sanitizeHTML(item.url)}">
                        <div class="history-title">${sanitizeHTML(item.title)}</div>
                        <div class="history-url">${sanitizeHTML(item.url)}</div>
                        <div class="history-date">${sanitizeHTML(item.date)}</div>
                        <div class="history-status ${statusClass}">${sanitizeHTML(statusText)}${crueltyFreeHTML}</div>
                        ${item.confidence_level ? `<div class="history-confidence">Confidence: ${sanitizeHTML(item.confidence_level.toUpperCase())}</div>` : ''}
                        ${item.summary ? `<div class="history-summary">${sanitizeHTML(item.summary)}</div>` : ''}
                        ${item.user_avoided_ingredients && item.user_avoided_ingredients.length > 0 ?
                        `<div class="history-avoided-ingredients">⚠️ Contains avoided ingredients: ${sanitizeHTML(item.user_avoided_ingredients.join(', '))}</div>` : ''}
                    </div>
                `;
            }).join('');

            historyContent.innerHTML = historyHTML;

            // Add click listeners to history items to open the URL
            const historyItems = document.querySelectorAll('.history-item');
            historyItems.forEach(item => {
                item.addEventListener('click', function () {
                    const url = this.getAttribute('data-url');
                    chrome.tabs.create({ url: url });
                });
            });
        });
    }

    function clearAnalysisHistory() {
        chrome.storage.local.remove(['analysis_history'], function () {
            loadAnalysisHistory();
        });
    }

    // Ask the tab for the Google Maps place it is showing.
    //
    // Only maps.js answers this, and only on a place page, so a null reply is
    // the ordinary answer for the rest of the web rather than an error.
    function getPlaceInfo(tab) {
        return new Promise((resolve) => {
            chrome.tabs.sendMessage(tab.id, { type: 'GET_PLACE_INFO' }, function (info) {
                if (chrome.runtime.lastError || !info || !info.place_key) {
                    resolve(null);
                    return;
                }
                resolve(info);
            });
        });
    }

    // Ask the background what this tab's analysis is doing, passing the key we
    // believe the page would be analyzed under so it can tell us apart from an
    // analysis the tab started before navigating somewhere else.
    function getAnalysisState(tabId, key, name) {
        return new Promise((resolve) => {
            chrome.runtime.sendMessage(
                { type: 'GET_ANALYSIS_STATE', tabId: tabId, key: key, name: name },
                function (response) {
                    if (chrome.runtime.lastError || !response) {
                        resolve(null);
                        return;
                    }
                    resolve(response.record || null);
                }
            );
        });
    }

    // Put the popup back where the tab left it.
    //
    // The popup closes the instant the user clicks anywhere else, and an
    // analysis runs for up to two minutes, so this is an ordinary path rather
    // than an edge case: reopening mid-analysis restores the spinner and waits
    // for the same result, and reopening afterwards shows it.
    //
    // A finished record is preferred over the cache because it is the one
    // source that is right in every mode — in DEV_MODE nothing is cached at
    // all, and a reopened popup would otherwise show nothing.
    async function restoreAnalysisState(tab) {
        if (!tab) {
            return;
        }

        const placeInfo = await getPlaceInfo(tab);
        // Must match the key background.js works in (see cacheKeyFor).
        const key = placeInfo ? `menu:${placeInfo.place_key}` : tab.url;
        const record = await getAnalysisState(
            tab.id, key, placeInfo && placeInfo.restaurant_name
        );

        if (liveUpdateShown) {
            return;
        }

        if (!record) {
            showCachedAnalysis(tab, placeInfo);
            return;
        }

        if (record.status === 'done' && record.result && record.result.analysis) {
            displayPageAnalysis(record.result.analysis, false);
            return;
        }

        if (record.status === 'error') {
            displayError(record.error || 'Analysis failed. Please try again.');
            return;
        }

        // Still running. The deadline is measured from when the analysis
        // started, not from now — otherwise every reopen would grant it
        // another two minutes, and a spinner restored for an analysis that
        // died with its worker would hang forever.
        const remaining = record.startedAt + ANALYSIS_TIMEOUT_MS - Date.now();
        if (remaining <= 0) {
            displayError('Analysis timed out. Please try again.');
            return;
        }

        showLoading();
        armAnalysisTimeout(remaining);
    }

    // Show the cached analysis for the active tab, if there is a usable one.
    //
    // `placeInfo` comes from the caller, which has already asked for it.
    async function showCachedAnalysis(tab, placeInfo) {
        if (await isDevMode()) {
            return;
        }

        // Must match the key background.js caches under (see cacheKeyFor).
        const cacheKey = placeInfo
            ? `menu:${placeInfo.place_key}_analysis`
            : `${tab.url}_analysis`;

        chrome.storage.local.get([cacheKey], function (result) {
            const cached = result[cacheKey];
            if (!cached || !cached.analysis) {
                return;
            }

            // For a place, only show it if the entry demonstrably belongs to
            // this one — the same check background.js makes. A Maps URL can
            // carry several place ids, so a key alone is not proof of identity.
            if (placeInfo) {
                const cachedPlace = cached.cached_place;
                if (!cachedPlace ||
                    (cachedPlace.name && placeInfo.restaurant_name &&
                        cachedPlace.name !== placeInfo.restaurant_name)) {
                    console.log('Ignoring menu cache entry that does not match this place');
                    return;
                }
            }

            displayPageAnalysis(cached.analysis, false);
        });
    }

    // The waiting state, shared by a freshly triggered analysis and one
    // restored on open so the two are indistinguishable to the user.
    function showLoading() {
        analysisPending = true;
        analyzeButton.disabled = true;
        analyzeButton.textContent = 'Analyzing...';
        loadingDiv.style.display = 'block';
        loadingDiv.className = 'loading';
        loadingDiv.textContent = 'Analyzing this page...';
        contentDiv.style.display = 'none';
        document.getElementById('menu-content').style.display = 'none';
    }

    function armAnalysisTimeout(ms) {
        setTimeout(function () {
            if (analysisPending) {
                displayError('Analysis timed out. Please try again.');
                resetButton();
            }
        }, ms);
    }

    function triggerAnalysis() {
        showLoading();

        // Get current tab and trigger content extraction
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
            const currentTab = tabs[0];

            // Send message to the content scripts to extract and analyze the
            // page. Both hear it; whichever owns extraction here replies.
            chrome.tabs.sendMessage(currentTab.id, {
                type: 'TRIGGER_PAGE_ANALYSIS'
            }, function (response) {
                if (chrome.runtime.lastError) {
                    console.error('Error sending message to content script:', chrome.runtime.lastError);
                    displayError('Could not analyze this page. Please refresh and try again.');
                    resetButton();
                    return;
                }

                // Analysis is now triggered, results will come via message
                console.log('Analysis triggered successfully', response);

                // Set a timeout in case the analysis takes too long.
                armAnalysisTimeout(ANALYSIS_TIMEOUT_MS);
            });
        });
    }

    // Listen for analysis results from content script
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'PAGE_RESULT_FOR_POPUP') {
            console.log('Received analysis result:', message.result);
            if (message.result && message.result.analysis) {
                liveUpdateShown = true;
                displayPageAnalysis(message.result.analysis, false);
                resetButton();
                // Reload history to show the new analysis
                loadAnalysisHistory();
            }
        } else if (message.type === 'PAGE_ERROR_FOR_POPUP') {
            console.log('Received analysis error:', message.error);
            liveUpdateShown = true;
            displayError(message.error || 'Analysis failed. Please try again.');
            resetButton();
        }
    });

    // Puts the button back; deliberately leaves the loading element alone. It
    // is where an error is shown, and the display functions hide it themselves
    // when there is a result to show instead.
    function resetButton() {
        analysisPending = false;
        analyzeButton.disabled = false;
        analyzeButton.textContent = BUTTON_LABEL;
    }

    function displayError(message) {
        loadingDiv.textContent = message;
        loadingDiv.className = 'loading error';
        loadingDiv.style.display = 'block';
        contentDiv.style.display = 'none';
        document.getElementById('menu-content').style.display = 'none';
    }
});

// Render an analysis of any page, dispatching on what the page turned out to be.
function displayPageAnalysis(analysis, isWarningAnalysis = false) {
    switch (resolvePageKind(analysis)) {
        case 'restaurant_menu':
            displayMenuAnalysis(analysis);
            break;
        case 'shopping_item':
            displayItemAnalysis(analysis, isWarningAnalysis);
            break;
        default:
            displayOtherAnalysis(analysis);
    }
}

// A page that is neither a product nor a menu. Not an error — most of the web
// is neither — so it gets the same panel as a product, stated plainly and
// without the product-specific sections.
function displayOtherAnalysis(analysis) {
    document.getElementById('loading').style.display = 'none';
    document.getElementById('menu-content').style.display = 'none';
    document.getElementById('content').style.display = 'block';

    const statusElement = document.getElementById('veganStatus');
    statusElement.textContent = '\u{1F4D6} Not a product or a menu';
    statusElement.className = 'vegan-status not-shopping';

    document.getElementById('confidence').textContent = '';

    const explanationElement = document.getElementById('explanation');
    explanationElement.className = 'explanation';
    explanationElement.textContent = analysis.explanation ||
        analysis.summary ||
        'There is nothing on this page to check.';

    document.getElementById('avoided-ingredients').style.display = 'none';
    document.getElementById('crueltyFreeSection').style.display = 'none';
}

function displayItemAnalysis(analysis, isWarningAnalysis = false) {
    // Hide loading, show content
    document.getElementById('loading').style.display = 'none';
    document.getElementById('menu-content').style.display = 'none';
    document.getElementById('content').style.display = 'block';

    // Display vegan status
    const statusElement = document.getElementById('veganStatus');

    // Determine the item text based on whether this is a warning analysis
    const itemText = isWarningAnalysis ? 'The last added item' : 'This item';

    if (analysis.is_vegan === true) {
        let statusText = `\u{1F331} ${itemText} is VEGAN`;

        // Update text based on confidence level
        if (analysis.confidence_level) {
            const confidence = analysis.confidence_level.toLowerCase();
            if (confidence === 'low') {
                statusText = `\u{1F331} ${itemText} MAY be vegan`;
            } else if (confidence === 'medium') {
                statusText = `\u{1F331} ${itemText} is LIKELY vegan`;
            } else if (confidence === 'high') {
                statusText = `\u{1F331} ${itemText} is VEGAN`;
            }
        }

        statusElement.textContent = statusText;
        statusElement.className = 'vegan-status vegan';
    } else if (analysis.is_vegan === false) {
        let statusText = `\u{26A0}\u{FE0F} ${itemText} is NOT VEGAN`;
        let statusClass = 'vegan-status not-vegan';

        // Update text based on confidence level
        if (analysis.confidence_level) {
            const confidence = analysis.confidence_level.toLowerCase();
            if (confidence === 'low') {
                statusText = `\u{2753} ${itemText} MAY NOT be vegan`;
            } else if (confidence === 'medium') {
                statusText = `\u{26A0}\u{FE0F} ${itemText} is LIKELY NOT vegan`;
            } else if (confidence === 'high') {
                statusText = `\u{26A0}\u{FE0F} ${itemText} is NOT VEGAN`;
            }
        }

        statusElement.textContent = statusText;

        // Add confidence-based styling for non-vegan items
        if (analysis.confidence_level) {
            const confidence = analysis.confidence_level.toLowerCase();
            statusClass += ` ${confidence}-confidence`;
        }

        statusElement.className = statusClass;
    } else {
        statusElement.textContent = '\u{2753} Unable to determine vegan status';
        statusElement.className = 'vegan-status unknown';
    }

    // Display confidence level
    const confidenceElement = document.getElementById('confidence');
    confidenceElement.textContent = analysis.confidence_level
        ? `Confidence: ${analysis.confidence_level.toUpperCase()}`
        : '';

    // Display explanation
    const explanationElement = document.getElementById('explanation');
    if (analysis.explanation) {
        explanationElement.textContent = analysis.explanation;
        explanationElement.className = 'explanation';
    } else {
        explanationElement.textContent = 'No explanation available';
        explanationElement.className = 'explanation error';
    }

    // Display avoided ingredients if present
    const avoidedIngredientsElement = document.getElementById('avoided-ingredients');
    if (analysis.user_avoided_ingredients && analysis.user_avoided_ingredients.length > 0) {
        const ingredientsList = analysis.user_avoided_ingredients.join(', ');
        avoidedIngredientsElement.innerHTML = `
            <div class="avoided-ingredients-warning">
                <span class="warning-icon">⚠️</span>
                <strong>Contains ingredients you want to avoid:</strong>
                <div class="ingredients-list">${sanitizeHTML(ingredientsList)}</div>
            </div>
        `;
        avoidedIngredientsElement.style.display = 'block';
    } else {
        avoidedIngredientsElement.style.display = 'none';
    }

    // Display cruelty-free status (only for applicable product types)
    const crueltyFreeSection = document.getElementById('crueltyFreeSection');
    const crueltyFreeStatus = document.getElementById('crueltyFreeStatus');
    const crueltyFreeExplanation = document.getElementById('crueltyFreeExplanation');

    // Only show cruelty-free section if is_cruelty_free is not null (applicable product type)
    if (analysis.is_cruelty_free !== null && analysis.is_cruelty_free !== undefined) {
        crueltyFreeSection.style.display = 'block';

        if (analysis.is_cruelty_free === true) {
            crueltyFreeStatus.textContent = '\u{1F430} Cruelty-Free';
            crueltyFreeStatus.className = 'cruelty-status cruelty-free';
        } else if (analysis.is_cruelty_free === false) {
            crueltyFreeStatus.textContent = '\u{26A0}\u{FE0F} Not Cruelty-Free';
            crueltyFreeStatus.className = 'cruelty-status not-cruelty-free';
        }

        // Display cruelty-free explanation if available
        if (analysis.cruelty_free_explanation) {
            crueltyFreeExplanation.textContent = analysis.cruelty_free_explanation;
            crueltyFreeExplanation.style.display = 'block';
        } else {
            crueltyFreeExplanation.style.display = 'none';
        }
    } else if (analysis.cruelty_free_explanation && analysis.is_cruelty_free === null) {
        // Show section with unknown status if there's an explanation but no determination
        crueltyFreeSection.style.display = 'block';
        crueltyFreeStatus.textContent = '\u{2753} Cruelty-Free Status Unknown';
        crueltyFreeStatus.className = 'cruelty-status cruelty-unknown';
        crueltyFreeExplanation.textContent = analysis.cruelty_free_explanation;
        crueltyFreeExplanation.style.display = 'block';
    } else {
        crueltyFreeSection.style.display = 'none';
    }
}

// Dish groups, in the order a vegan diner cares about them.
const MENU_VERDICT_GROUPS = [
    { verdict: 'vegan', label: '\u{1F331} Vegan' },
    { verdict: 'likely_vegan', label: '\u{1F33F} Likely vegan' },
    { verdict: 'unclear', label: '\u{2753} Unclear — ask the staff' },
    { verdict: 'not_vegan', label: '\u{26A0}\u{FE0F} Not vegan' }
];

const FRIENDLINESS_TEXT = {
    high: '\u{1F331} Plenty of vegan options',
    medium: '\u{1F33F} Some vegan options',
    low: '\u{26A0}\u{FE0F} Very limited vegan options',
    none: '\u{26D4} No vegan options found'
};

function displayMenuAnalysis(analysis) {
    document.getElementById('loading').style.display = 'none';
    document.getElementById('content').style.display = 'none';

    const menuContent = document.getElementById('menu-content');
    menuContent.style.display = 'block';

    document.getElementById('menuRestaurant').textContent =
        analysis.restaurant_name || 'This restaurant';

    const friendlinessElement = document.getElementById('menuFriendliness');
    const confidenceElement = document.getElementById('menuConfidence');
    const summaryElement = document.getElementById('menuSummary');
    const itemsElement = document.getElementById('menuItems');

    // No menu on the page is a normal outcome on Maps, not an error: many
    // restaurants only link out to a menu or show photos of one.
    if (analysis.is_restaurant_menu === false) {
        friendlinessElement.textContent = '\u{1F937} No menu found on this page';
        friendlinessElement.className = 'vegan-status unknown';
        confidenceElement.textContent = '';
        summaryElement.textContent = analysis.summary ||
            'Google Maps does not show a menu for this restaurant.';
        itemsElement.innerHTML = '';
        return;
    }

    const friendliness = analysis.vegan_friendliness || 'none';
    friendlinessElement.textContent =
        FRIENDLINESS_TEXT[friendliness] || FRIENDLINESS_TEXT.none;
    friendlinessElement.className = `vegan-status friendliness-${friendliness}`;

    confidenceElement.textContent = analysis.confidence_level
        ? `Confidence: ${analysis.confidence_level.toUpperCase()}`
        : '';

    summaryElement.textContent = analysis.summary || 'No summary available';

    const items = analysis.items || [];
    if (items.length === 0) {
        itemsElement.innerHTML =
            '<div class="menu-empty">No dishes could be read from this menu.</div>';
        return;
    }

    itemsElement.innerHTML = MENU_VERDICT_GROUPS.map(group => {
        const groupItems = items.filter(item => item.verdict === group.verdict);
        if (groupItems.length === 0) {
            return '';
        }

        const rows = groupItems.map(item => {
            const section = item.section
                ? `<span class="menu-item-section">${sanitizeHTML(item.section)}</span>`
                : '';

            // Only worth surfacing on dishes that are not already vegan.
            const veganizable = (item.veganizable === true && item.verdict !== 'vegan')
                ? '<span class="menu-item-tag veganizable">Can be made vegan</span>'
                : '';

            const avoided = (item.user_avoided_ingredients && item.user_avoided_ingredients.length > 0)
                ? `<span class="menu-item-tag avoided">\u{26A0}\u{FE0F} ${sanitizeHTML(item.user_avoided_ingredients.join(', '))}</span>`
                : '';

            const reason = item.reason
                ? `<div class="menu-item-reason">${sanitizeHTML(item.reason)}</div>`
                : '';

            return `
                <div class="menu-item ${group.verdict}">
                    <div class="menu-item-name">${sanitizeHTML(item.name)}${section}</div>
                    ${reason}
                    ${veganizable}${avoided}
                </div>
            `;
        }).join('');

        return `
            <div class="menu-group">
                <div class="menu-group-title">${group.label} (${groupItems.length})</div>
                ${rows}
            </div>
        `;
    }).join('');
}

// Settings management functions
function loadSettings() {
    chrome.storage.local.get(['custom_ingredients'], function (result) {
        const customIngredients = result.custom_ingredients || [];

        // Load custom ingredients
        loadCustomIngredients(customIngredients);
    });
}

function loadCustomIngredients(customIngredients) {
    const customIngredientsList = document.getElementById('custom-ingredients-list');
    customIngredientsList.innerHTML = '';

    customIngredients.forEach(ingredient => {
        const ingredientItem = document.createElement('div');
        ingredientItem.className = 'ingredient-item';
        ingredientItem.innerHTML = `
            <span class="ingredient-label">${sanitizeHTML(ingredient)}</span>
            <button class="ingredient-remove" data-ingredient="${sanitizeHTML(ingredient)}">×</button>
        `;
        customIngredientsList.appendChild(ingredientItem);
    });

    // Add event listeners to remove buttons
    const removeButtons = customIngredientsList.querySelectorAll('.ingredient-remove');
    removeButtons.forEach(button => {
        button.addEventListener('click', function () {
            const ingredient = this.getAttribute('data-ingredient');
            removeCustomIngredient(ingredient);
        });
    });
}

function addCustomIngredient() {
    const input = document.getElementById('customIngredient');
    const ingredient = input.value.trim();

    if (ingredient) {
        chrome.storage.local.get(['custom_ingredients'], function (result) {
            const customIngredients = result.custom_ingredients || [];

            if (!customIngredients.includes(ingredient)) {
                customIngredients.push(ingredient);

                chrome.storage.local.set({ custom_ingredients: customIngredients }, function () {
                    loadCustomIngredients(customIngredients);
                    input.value = '';
                    saveAllIngredients(); // Save all ingredients when custom ingredient is added
                });
            } else {
                alert('This ingredient is already in your custom list.');
            }
        });
    }
}

function removeCustomIngredient(ingredient) {
    chrome.storage.local.get(['custom_ingredients'], function (result) {
        const customIngredients = result.custom_ingredients || [];
        const updatedIngredients = customIngredients.filter(item => item !== ingredient);

        chrome.storage.local.set({ custom_ingredients: updatedIngredients }, function () {
            loadCustomIngredients(updatedIngredients);
            saveAllIngredients(); // Save all ingredients when custom ingredient is removed
        });
    });
}

function saveAllIngredients() {
    // Get custom ingredients
    chrome.storage.local.get(['custom_ingredients'], function (result) {
        const customIngredients = result.custom_ingredients || [];

        chrome.storage.local.set({
            custom_ingredients: customIngredients
        });
    });
}

