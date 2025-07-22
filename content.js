// Global flag to prevent multiple simultaneous analyses
let isAnalyzing = false;

// Global flag to control console logging
let enableLogging = false;

// Helper function for conditional logging
function log(...args) {
  if (enableLogging) {
    console.log(...args);
  }
}

// Function to clean up duplicate new lines in markdown
function cleanMarkdown(markdown) {
  // Replace multiple consecutive new lines with maximum of 2
  let cleaned = markdown.replace(/\n{3,}/g, "\n\n");

  // Remove new lines that are just whitespace
  cleaned = cleaned.replace(/\n\s*\n/g, "\n\n");

  // Remove leading/trailing new lines
  cleaned = cleaned.replace(/^\n+/, "").replace(/\n+$/, "");

  // Replace multiple spaces with single space
  cleaned = cleaned.replace(/[ ]{2,}/g, " ");

  return cleaned;
}

// Function to convert HTML element to markdown
function elementToMarkdown(element) {
  if (element.nodeType === Node.TEXT_NODE) {
    return element.textContent;
  }

  if (element.nodeType !== Node.ELEMENT_NODE) {
    return "";
  }

  const tagName = element.tagName.toLowerCase();
  const textContent = element.textContent.trim();

  if (!textContent) {
    return "";
  }

  switch (tagName) {
    case "h1":
      return `# ${textContent}\n\n`;
    case "h2":
      return `## ${textContent}\n\n`;
    case "h3":
      return `### ${textContent}\n\n`;
    case "h4":
      return `#### ${textContent}\n\n`;
    case "h5":
      return `##### ${textContent}\n\n`;
    case "h6":
      return `###### ${textContent}\n\n`;
    case "p":
      return `${textContent}\n\n`;
    case "strong":
    case "b":
      return `**${textContent}**`;
    case "em":
    case "i":
      return `*${textContent}*`;
    case "code":
      return `\`${textContent}\``;
    case "pre":
      return `\`\`\`\n${textContent}\n\`\`\`\n\n`;
    case "blockquote":
      return `> ${textContent}\n\n`;
    case "ul":
      const ulItems = Array.from(element.querySelectorAll("li"))
        .map((li) => `- ${li.textContent.trim()}`)
        .join("\n");
      return `${ulItems}\n\n`;
    case "ol":
      const olItems = Array.from(element.querySelectorAll("li"))
        .map((li, index) => `${index + 1}. ${li.textContent.trim()}`)
        .join("\n");
      return `${olItems}\n\n`;
    case "li":
      return `${textContent}\n`;
    case "a":
      return textContent;
    case "img":
      return "";
    case "br":
      return "\n";
    case "hr":
      return "---\n\n";
    case "div":
    case "section":
    case "article":
    case "main":
    case "span":
      // For container elements, process their children
      let containerMarkdown = "";
      for (const child of element.childNodes) {
        const childMarkdown = elementToMarkdown(child);
        if (childMarkdown) {
          containerMarkdown += childMarkdown + "\n";
        }
      }
      return containerMarkdown;
    default:
      // For other elements, process their children if they exist
      if (element.childNodes.length > 0) {
        let defaultMarkdown = "";
        for (const child of element.childNodes) {
          const childMarkdown = elementToMarkdown(child);
          if (childMarkdown) {
            defaultMarkdown += childMarkdown + "\n";
          }
        }
        return defaultMarkdown;
      }
      // If no children, return the text content
      return textContent;
  }
}

// Function to extract clean text content from the current page for AI analysis
function extractPageContent() {
  // Clone the body to avoid modifying the original page
  const bodyClone = document.body.cloneNode(true);

  // Remove script and style elements
  const scripts = bodyClone.querySelectorAll(
    "script, style, noscript, iframe, embed, object"
  );
  scripts.forEach((el) => el.remove());

  // Remove common non-content elements
  const nonContentElements = bodyClone.querySelectorAll(
    "nav, footer, header, .sidebar, .navigation, .menu, .ad, .advertisement, .banner, #navFooter"
  );
  nonContentElements.forEach((el) => el.remove());

  // Store-specific elements
  const keysToRemove = [
    // Amazon
    "#rightCol",
    "#leftCol",
    "#averageCustomerReviews",
    "#apex_desktop",
    ".offersConsistencyEnabled",
    '[data-feature-name="sims-productBundle"]',
    '[data-feature-name="sims-simsContainer"]',
  ].join(", ");

  const elementsToRemove = bodyClone.querySelectorAll(keysToRemove);
  elementsToRemove.forEach((el) => el.remove());

  // Convert to markdown and clean up duplicate new lines
  const rawMarkdown = elementToMarkdown(bodyClone).trim();

  const markdownContent = cleanMarkdown(rawMarkdown);

  return {
    url: window.location.href,
    title: document.title,
    timestamp: new Date().toISOString(),
    content: markdownContent,
  };
}

// Function to send extracted content to backend for AI analysis
function sendContentForAnalysis(content) {
  chrome.runtime.sendMessage(
    {
      type: "CONTENT_FOR_ANALYSIS",
      content: content,
    },
    (response) => {
      log("Content sent for AI analysis, response:", response);
    }
  );
}

// Function to trigger analysis manually
function triggerAnalysis() {
  log("Manual analysis triggered");
  const extractedContent = extractPageContent();
  sendContentForAnalysis(extractedContent);
}

// Function to detect "Add to Cart" buttons
function detectAddToCartButtons() {
  let buttons = [];

  // Use jQuery-like selector matching for text content
  const allButtons = document.querySelectorAll(
    'button, input[type="submit"], input[type="button"], a, [role="button"]'
  );

  allButtons.forEach((button) => {
    const text =
      button.textContent?.toLowerCase() || button.value?.toLowerCase() || "";
    const className = button.className?.toLowerCase() || "";
    const id = button.id?.toLowerCase() || "";
    const ariaLabel = button.getAttribute("aria-label")?.toLowerCase() || "";
    const title = button.getAttribute("title")?.toLowerCase() || "";
    const dataTestId = button.getAttribute("data-testid")?.toLowerCase() || "";
    const dataAction = button.getAttribute("data-action")?.toLowerCase() || "";

    // Check for common add to cart patterns - exact matches only
    const cartPatterns = [
      "add to cart",
      "add to bag",
      "add to basket",
      "addtocart",
      "addtobag",
      "addtobasket",
      "add to shopping cart",
      "add to shopping bag",
      "add to wishlist",
      "add to favorites",
      "order now",
      "buy now",
      "purchase now",
    ];

    // Check for common cart-related class patterns
    const cartClassPatterns = [
      "cart",
      "bag",
      "basket",
      "buy",
      "purchase",
      "order",
      "add-to",
      "addto",
      "shopping",
      "checkout",
    ];

    const matchesTextPattern = cartPatterns.some(
      (pattern) =>
        text === pattern ||
        ariaLabel === pattern ||
        title === pattern ||
        dataTestId === pattern ||
        dataAction === pattern
    );

    const matchesClassPattern = cartClassPatterns.some(
      (pattern) => className === pattern || id === pattern
    );

    if (matchesTextPattern || matchesClassPattern) {
      // Filter out buttons that are clearly not add to cart (like remove, delete, etc.)
      const excludePatterns = [
        "remove",
        "delete",
        "clear",
        "empty",
        "checkout",
        "view cart",
        "remove from cart",
        "delete from cart",
        "clear cart",
      ];

      const shouldExclude = excludePatterns.some(
        (pattern) =>
          text === pattern || ariaLabel === pattern || title === pattern
      );

      if (!shouldExclude) {
        buttons.push(button);
      }
    }
  });

  return buttons;
}

// Function to handle add to cart button clicks
function handleAddToCartClick(event) {
  // Prevent multiple simultaneous analyses
  if (isAnalyzing) {
    log("Analysis already in progress, skipping...");
    return;
  }

  // Log detailed information about the button that was clicked
  const button = event.target;
  const buttonInfo = {
    text: button.textContent?.trim() || button.value?.trim() || "No text",
    className: button.className || "No class",
    id: button.id || "No ID",
    tagName: button.tagName,
    ariaLabel: button.getAttribute("aria-label") || "No aria-label",
    title: button.getAttribute("title") || "No title",
    dataTestId: button.getAttribute("data-testid") || "No data-testid",
    dataAction: button.getAttribute("data-action") || "No data-action",
    type: button.type || "No type",
    href: button.href || "No href",
  };

  log(
    "Vegan Confirmed: Add to cart button clicked - Button details:",
    buttonInfo
  );
  log("Vegan Confirmed: Button element:", button);

  isAnalyzing = true;

  // Trigger analysis
  const extractedContent = extractPageContent();
  sendContentForAnalysis(extractedContent);

  // Reset analyzing flag after a reasonable timeout
  setTimeout(() => {
    isAnalyzing = false;
  }, 10000); // 10 seconds should be enough for most analyses
}

// Function to setup cart detection
function setupCartDetection() {
  // Initial detection
  const cartButtons = detectAddToCartButtons();
  log(
    "Vegan Confirmed: Detected",
    cartButtons.length,
    "cart buttons on page"
  );

  // Add click listeners to existing buttons
  cartButtons.forEach((button) => {
    if (!button.hasAttribute("data-vegan-analyzed")) {
      button.setAttribute("data-vegan-analyzed", "true");
      button.addEventListener("click", handleAddToCartClick);
      log(
        "Vegan Confirmed: Added listener to button:",
        button.textContent?.substring(0, 50) || button.className || button.id
      );
    }
  });

  // Watch for dynamically added buttons using MutationObserver
  const observer = new MutationObserver((mutations) => {
    let shouldCheckForButtons = false;

    // First pass: check if any relevant elements were added
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          // Only check if button-like elements were added
          if (node.matches && (
            node.matches('button, input[type="submit"], input[type="button"], a, [role="button"]') ||
            node.querySelector('button, input[type="submit"], input[type="button"], a, [role="button"]')
          )) {
            shouldCheckForButtons = true;
            break;
          }
        }
      }
      if (shouldCheckForButtons) break;
    }

    // Only run expensive detection if relevant elements were added
    if (shouldCheckForButtons) {
      const newCartButtons = detectAddToCartButtons();
      newCartButtons.forEach((button) => {
        if (!button.hasAttribute("data-vegan-analyzed")) {
          button.setAttribute("data-vegan-analyzed", "true");
          button.addEventListener("click", handleAddToCartClick);
          log(
            "Vegan Confirmed: Added listener to dynamically added button:",
            button.textContent?.substring(0, 50) ||
            button.className ||
            button.id
          );
        }
      });
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  log("Vegan Confirmed: Cart detection setup complete");
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  log("Content script received message:", message);

  if (message.type === "TRIGGER_ANALYSIS") {
    triggerAnalysis();
    sendResponse({ status: "analysis_triggered" });
  } else if (message.type === "TOGGLE_LOGGING") {
    const newState = toggleLogging();
    sendResponse({ status: "logging_toggled", enabled: newState });
  } else if (message.type === "SET_LOGGING") {
    const newState = setLogging(message.enabled);
    sendResponse({ status: "logging_set", enabled: newState });
  } else if (message.type === "GET_LOGGING_STATE") {
    sendResponse({ status: "logging_state", enabled: enableLogging });
  }
});

// Initialize content script and setup cart detection
log("Content script loaded - setting up cart detection");
setupCartDetection();
