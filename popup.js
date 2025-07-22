// Simple HTML sanitization function
function sanitizeHTML(text) {
    if (typeof text !== 'string') return '';

    // Create a temporary div to escape HTML
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Initialize popup
document.addEventListener('DOMContentLoaded', function () {
    const analyzeButton = document.getElementById('analyzeButton');
    const loadingDiv = document.getElementById('loading');
    const contentDiv = document.getElementById('content');

    // Establish connection to background script for popup close detection
    const port = chrome.runtime.connect({ name: 'popup' });

    // Setup tab functionality
    setupTabs();

    // Load history on startup
    loadAnalysisHistory();

    // First check if we have warning analysis data (from forced popup opening)
    chrome.storage.local.get(['warning_analysis'], function (result) {
        if (result.warning_analysis) {
            // Display the warning analysis immediately
            displayAnalysis(result.warning_analysis, true);
            // Clear the stored data to prevent showing it again
            chrome.storage.local.remove(['warning_analysis']);
            // Note: Badge will be cleared when popup closes via background script
            return;
        }

        // If no non-vegan analysis, check for regular analysis results for this page
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
            const currentUrl = tabs[0].url;
            const analysisKey = `${currentUrl}_analysis`;

            chrome.storage.local.get([analysisKey], function (result) {
                const analysisData = result[analysisKey];

                if (analysisData && analysisData.analysis) {
                    displayAnalysis(analysisData.analysis, false);
                }
            });
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

                if (item.is_shopping_item === false) {
                    statusText = 'Not Shopping Item';
                    statusClass = 'not-shopping';
                } else if (item.is_shopping_item === true) {
                    if (item.is_vegan === true) {
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
                }

                return `
                    <div class="history-item" data-url="${sanitizeHTML(item.url)}">
                        <div class="history-title">${sanitizeHTML(item.title)}</div>
                        <div class="history-url">${sanitizeHTML(item.url)}</div>
                        <div class="history-date">${sanitizeHTML(item.date)}</div>
                        <div class="history-status ${statusClass}">${sanitizeHTML(statusText)}</div>
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

    function triggerAnalysis() {
        // Disable button and show loading
        analyzeButton.disabled = true;
        analyzeButton.textContent = 'Analyzing...';
        loadingDiv.style.display = 'block';
        contentDiv.style.display = 'none';

        // Get current tab and trigger content extraction
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
            const currentTab = tabs[0];

            // Send message to content script to extract and analyze content
            chrome.tabs.sendMessage(currentTab.id, {
                type: 'TRIGGER_ANALYSIS'
            }, function (response) {
                if (chrome.runtime.lastError) {
                    console.error('Error sending message to content script:', chrome.runtime.lastError);
                    displayError('Could not analyze this page. Please refresh and try again.');
                    return;
                }

                // Start polling for analysis results
                pollForResults();
            });
        });
    }

    function pollForResults() {
        const pollInterval = setInterval(function () {
            chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
                const currentUrl = tabs[0].url;
                const analysisKey = `${currentUrl}_analysis`;

                chrome.storage.local.get([analysisKey], function (result) {
                    const analysisData = result[analysisKey];

                    if (analysisData && analysisData.analysis) {
                        clearInterval(pollInterval);
                        displayAnalysis(analysisData.analysis, false);
                        resetButton();
                        // Reload history to show the new analysis
                        loadAnalysisHistory();
                    }
                });
            });
        }, 1000); // Poll every second

        // Stop polling after 30 seconds
        setTimeout(function () {
            clearInterval(pollInterval);
            if (loadingDiv.style.display !== 'none') {
                displayError('Analysis timed out. Please try again.');
                resetButton();
            }
        }, 30000);
    }

    function resetButton() {
        analyzeButton.disabled = false;
        analyzeButton.textContent = '\u{1F331} Check if the product is vegan';
        loadingDiv.style.display = 'none';
    }

    function displayError(message) {
        loadingDiv.textContent = message;
        loadingDiv.className = 'loading error';
        contentDiv.style.display = 'none';
    }
});

function displayAnalysis(analysis, isWarningAnalysis = false) {
    // Hide loading, show content
    document.getElementById('loading').style.display = 'none';
    document.getElementById('content').style.display = 'block';

    // Display vegan status
    const statusElement = document.getElementById('veganStatus');

    // Determine the item text based on whether this is a warning analysis
    const itemText = isWarningAnalysis ? 'The last added item' : 'This item';

    // First check if this is a shopping item
    if (analysis.is_shopping_item === false) {
        statusElement.textContent = '\u{1F4D6} Not a Shopping Item';
        statusElement.className = 'vegan-status not-shopping';
    } else if (analysis.is_shopping_item === true) {
        // It's a shopping item, now check vegan status
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
    } else {
        // is_shopping_item is null/undefined, treat as unknown
        statusElement.textContent = '\u{2753} Unable to determine content type';
        statusElement.className = 'vegan-status unknown';
    }

    // Display confidence level
    const confidenceElement = document.getElementById('confidence');
    if (analysis.confidence_level) {
        confidenceElement.textContent = `Confidence: ${analysis.confidence_level.toUpperCase()}`;
    }

    // Display explanation
    const explanationElement = document.getElementById('explanation');
    if (analysis.explanation) {
        explanationElement.textContent = analysis.explanation;
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

