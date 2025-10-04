// Content script for detecting and handling image translations

// Global variables
let settings = {};
let selectedImage = null;
let imageObserver = null;
let autoTranslateEnabled = false;
let currentSelector = '[name="image-item"] img';
let translationQueue = new Set();
let isProcessing = false;
let pageChangeObserver = null;
let cacheProcessingQueue = [];
let isCacheProcessing = false;
let settingsLoaded = false;

// Load settings with retry mechanism
async function loadSettingsWithRetry(retries = 5, delay = 200) {
  for (let i = 0; i < retries; i++) {
    try {
      // Try to load directly from storage first
      const result = await browser.storage.local.get('settings');
      if (result.settings && result.settings.backendUrl) {
        console.log('Settings loaded from storage:', result.settings);
        settings = result.settings;
        settingsLoaded = true;
        setupFeatures();
        return;
      }
      
      // If not in storage, try to get from background
      const response = await browser.runtime.sendMessage({ action: 'getSettings' });
      if (response && response.settings) {
        console.log('Settings loaded from background:', response.settings);
        settings = response.settings;
        settingsLoaded = true;
        setupFeatures();
        return;
      }
    } catch (error) {
      console.log(`Attempt ${i + 1} to load settings failed:`, error.message);
      if (i < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  // If all retries failed, use default settings
  console.warn('Failed to load settings after retries, using defaults');
  settings = {
    backendUrl: 'http://127.0.0.1:8000',
    translator: 'sugoi',
    targetLang: 'ENG',
    detector: 'default',
    inpainter: 'lama_large',
    renderer: 'manga2eng',
    displayMode: 'overlay',
    enableBatchMode: true,
    overlayMode: 'colored',
    overlayOpacity: 90,
    overlayTextColor: 'auto',
    customTextColor: '#ffffff',
    draggableOverlay: true,
    enableCache: true,
    skipProcessed: true,
    observeDynamicImages: true,
    autoTranslate: true
  };
  settingsLoaded = true;
  setupFeatures();
}

// Load settings on page load
loadSettingsWithRetry();

// Setup all features based on current settings
function setupFeatures() {
  if (!settingsLoaded) {
    console.log('Settings not loaded yet, skipping setup');
    return;
  }
  
  console.log('Setting up features with settings:', settings);
  
  if (imageObserver) {
    imageObserver.disconnect();
    imageObserver = null;
  }
  
  if (pageChangeObserver) {
    pageChangeObserver.disconnect();
    pageChangeObserver = null;
  }
  
  currentSelector = getActiveSelectors();
  
  if (settings.enableCache && currentSelector) {
    preloadCacheForExistingImages();
  }
  
  if (settings.enableBatchMode && currentSelector) {
    startAutoTranslation();
  } else {
    startAutoTranslation();
  }
  
  if (settings.observeDynamicImages) {
    setupEnhancedImageObserver();
    setupPageChangeObserver();
  }
  
  initializeHoverButtons();
}

function matchesDomain(currentDomain, ruleDomainsString) {
  const ruleDomains = ruleDomainsString.split(',').map(d => d.trim()).filter(d => d);
  
  for (const ruleDomain of ruleDomains) {
    const pattern = ruleDomain.replace(/\*/g, '.*').replace(/\./g, '\\.');
    const regex = new RegExp(`^${pattern}$`, 'i');
    
    if (regex.test(currentDomain)) {
      return true;
    }
  }
  
  return false;
}

function getActiveSelectors() {
  const currentDomain = window.location.hostname;
  
  if (!settings.selectorRules || !Array.isArray(settings.selectorRules)) {
    return null;
  }
  
  // Check if there's a specific domain rule first
  const specificRules = settings.selectorRules
    .filter(rule => rule.enabled && !rule.isGeneral && matchesDomain(currentDomain, rule.domains))
    .map(rule => rule.selector)
    .filter(s => s);
  
  // If specific rule exists, use only specific rules (ignore general)
  if (specificRules.length > 0) {
    return specificRules.join(', ');
  }
  
  // If no specific rule, use general rules
  const generalRules = settings.selectorRules
    .filter(rule => rule.enabled && rule.isGeneral)
    .map(rule => rule.selector)
    .filter(s => s);
  
  return generalRules.length > 0 ? generalRules.join(', ') : null;
}

// New function to preload cache
function preloadCacheForExistingImages() {
  if (!currentSelector) {
    currentSelector = settings.customSelector || '[name="image-item"] img';
  }
  
  try {
    const images = document.querySelectorAll(currentSelector);
    if (images.length === 0) return;
    
    const imageArray = Array.from(images)
      .filter(img => img.src && img.src.startsWith('http'))
      .filter(img => img.naturalWidth > 100 && img.naturalHeight > 100)
      .filter(img => img.dataset.miProcessed !== 'true');
    
    if (imageArray.length > 0) {
      console.log(`Found ${imageArray.length} images for cache application`);
      
      // Apply cache in background, don't wait
      imageArray.forEach(img => {
        const elementInfo = getElementInfo(img);
        browser.runtime.sendMessage({
          action: 'applyCacheOnly',
          imageUrl: img.src,
          imageElement: elementInfo
        }).catch(() => {});
      });
    }
  } catch (error) {
    console.error('Error preloading cache:', error);
  }
}

// Enhanced image observer for manga sites - REWRITTEN without setTimeout
function setupEnhancedImageObserver() {
  console.log('Setting up enhanced image observer');
  
  imageObserver = new MutationObserver((mutations) => {
    let newImages = [];
    
    mutations.forEach((mutation) => {
      if (mutation.addedNodes && mutation.addedNodes.length > 0) {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.tagName === 'IMG') {
              if (shouldProcessImage(node)) {
                newImages.push(node);
              }
            }
            
            const images = node.getElementsByTagName('img');
            if (images && images.length > 0) {
              Array.from(images).forEach(img => {
                if (shouldProcessImage(img)) {
                  newImages.push(img);
                }
              });
            }
            
            const lazyImages = node.querySelectorAll('img[data-src], img[data-lazy-src]');
            if (lazyImages && lazyImages.length > 0) {
              lazyImages.forEach(img => {
                if (shouldProcessImage(img)) {
                  setupLazyLoadingObserver(img);
                }
              });
            }
          }
        });
      }
      
      if (mutation.type === 'attributes') {
        const target = mutation.target;
        if (target.tagName === 'IMG') {
          if (mutation.attributeName === 'src' || mutation.attributeName === 'data-src') {
            if (shouldProcessImage(target)) {
              newImages.push(target);
            }
          }
        }
      }
    });
    
    if (newImages.length > 0) {
      console.log('New images detected by observer', newImages.length);
      
      const matchingImages = newImages.filter(img => img.matches(currentSelector));
      
      if (matchingImages.length > 0) {
        // Apply cache in background (non-blocking)
        matchingImages.forEach(img => {
          const elementInfo = getElementInfo(img);
          browser.runtime.sendMessage({
            action: 'applyCacheOnly',
            imageUrl: img.src,
            imageElement: elementInfo
          }).catch(() => {});
        });
        
        // Queue for translation if auto-translate enabled
        if (autoTranslateEnabled) {
          matchingImages.forEach(img => {
            queueImageForTranslation(img);
          });
        }
      }
    }
  });
  
  imageObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'data-src', 'data-lazy-src'],
    characterData: false,
    attributeOldValue: false
  });
  
  console.log('Enhanced image observer started');
}

// Setup page change observer for SPA sites
function setupPageChangeObserver() {
  console.log('Setting up page change observer');
  
  // Observe URL changes
  let lastUrl = location.href;
  
  pageChangeObserver = new MutationObserver(() => {
    const url = location.href;
    if (url !== lastUrl) {
      lastUrl = url;
      console.log('Page URL changed:', url);
      
      // Scan for existing images immediately (no setTimeout)
      if (autoTranslateEnabled) {
        scanExistingImages();
      }
    }
  });
  
  // Observe title changes as well (often indicates page change in SPAs)
  const titleElement = document.querySelector('title');
  if (titleElement) {
    pageChangeObserver.observe(titleElement, {
      childList: true,
      subtree: true
    });
  }
  
  // Also listen to popstate events (browser navigation)
  window.addEventListener('popstate', () => {
    console.log('Popstate event detected');
    if (autoTranslateEnabled) {
      scanExistingImages();
    }
  });
  
  console.log('Page change observer started');
}

// Setup lazy loading observer for individual images
function setupLazyLoadingObserver(img) {
  if (img.dataset.lazyObserverSetup) return;
  img.dataset.lazyObserverSetup = 'true';
  
  // Create IntersectionObserver for lazy loading
  const lazyObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const img = entry.target;
        
        // Check if image has data-src
        if (img.dataset.src && !img.src) {
          img.src = img.dataset.src;
        }
        
        if (img.dataset.lazySrc && !img.src) {
          img.src = img.dataset.lazySrc;
        }
        
        // Check if image should be translated
        if (shouldProcessImage(img) && autoTranslateEnabled && img.matches(currentSelector)) {
          queueImageForTranslation(img);
        }
        
        // Stop observing this image
        observer.unobserve(img);
      }
    });
  });
  
  lazyObserver.observe(img);
}

// Scan existing images immediately (no setTimeout)
function scanExistingImages() {
  if (!currentSelector) return;
  
  console.log('Scanning for existing images with selector:', currentSelector);
  translateImagesWithSelector(currentSelector);
}

// Start auto-translation
function startAutoTranslation(selector = null) {
  if (selector) {
    currentSelector = selector;
  } else {
    currentSelector = getActiveSelectors();
  }
  
  if (!currentSelector) {
    console.log('No active selector for current domain');
    currentSelector = '';
    autoTranslateEnabled = false;
    return;
  }
  
  autoTranslateEnabled = true;
  
  console.log('Starting auto-translation with selector:', currentSelector);
  
  scanExistingImages();
}

// Stop auto-translation
function stopAutoTranslation() {
  autoTranslateEnabled = false;
  currentSelector = '';
  console.log('Auto-translation stopped');
}

// Translate images matching selector
function translateImagesWithSelector(selector) {
  try {
    const images = document.querySelectorAll(selector);
    
    if (images.length === 0) {
      console.log('No images found with selector:', selector);
      return;
    }
    
    console.log(`Found ${images.length} images with selector: ${selector}`);
    
    images.forEach(img => {
      if (shouldProcessImage(img)) {
        queueImageForTranslation(img);
      }
    });
  } catch (error) {
    console.error('Error translating images with selector:', selector, error);
  }
}

// Check if image should be processed
function shouldProcessImage(img) {
  // Check if already processed using new attribute system
  if (img.dataset.miProcessed === 'true') {
    return false;
  }
  
  // Check if image has valid source
  if (!img.src || !img.src.startsWith('http')) {
    // Check for data-src (lazy loading)
    if (!img.dataset.src || !img.dataset.src.startsWith('http')) {
      return false;
    }
  }
  
  // Check image size
  if (img.naturalWidth > 0 && img.naturalHeight > 0) {
    if (img.naturalWidth < 100 || img.naturalHeight < 100) {
      return false;
    }
  }
  
  // Check if already in queue
  if (translationQueue.has(img)) {
    return false;
  }
  
  return true;
}

// Queue image for translation
function queueImageForTranslation(img) {
  translationQueue.add(img);
  
  // Add visual indicator only for manual translations
  if (!autoTranslateEnabled) {
    img.style.outline = '2px solid #4A90E2';
  }
  
  // Process queue if not already processing
  if (!isProcessing) {
    processTranslationQueue();
  }
}

// Process translation queue
async function processTranslationQueue() {
  if (translationQueue.size === 0) {
    isProcessing = false;
    return;
  }
  
  isProcessing = true;
  
  // Process images one by one with delay
  for (const img of translationQueue) {
    try {
      await translateSingleImage(img);
      translationQueue.delete(img);
      
      // Small delay between translations to avoid overwhelming the backend
      await new Promise(resolve => setTimeout(resolve, 300));
    } catch (error) {
      console.error('Error translating image:', error);
      // Mark as processed even if failed
      markImageAsProcessed(img, 'error', error.message);
      translationQueue.delete(img);
    }
  }
  
  isProcessing = false;
  
  // Check if there are new images in queue
  if (translationQueue.size > 0) {
    processTranslationQueue();
  }
}

// Translate single image with improved error handling
async function translateSingleImage(img) {
  console.log('Translating image:', img.src);
  
  const elementInfo = getElementInfo(img);
  
  return new Promise((resolve, reject) => {
    // Set a timeout to prevent hanging
    const timeoutId = setTimeout(() => {
      markImageAsProcessed(img, 'error', 'Translation timeout');
      reject(new Error('Translation timeout'));
    }, 60000); // 60 seconds timeout
    
    browser.runtime.sendMessage({
      action: 'translateImage',
      imageUrl: img.src,
      imageElement: elementInfo
    }).then(response => {
      clearTimeout(timeoutId);
      // Remove visual indicator
      img.style.outline = '';
      // Mark as successfully processed
      markImageAsProcessed(img, 'ok');
      resolve(response);
    }).catch(error => {
      clearTimeout(timeoutId);
      // Remove visual indicator
      img.style.outline = '';
      // Mark as processed with error
      markImageAsProcessed(img, 'error', error.message);
      // Log error but don't throw
      console.warn('Translation failed for image:', img.src, 'Error:', error.message);
      resolve(null); // Resolve with null instead of rejecting
    });
  });
}

// Mark image as processed with status
function markImageAsProcessed(img, status, errorMessage = '') {
  img.dataset.miProcessed = 'true';
  img.dataset.miStatus = status;
  
  if (status === 'error' && errorMessage) {
    img.dataset.miError = errorMessage.substring(0, 100); // Limit error message length
    console.warn(`Image marked as processed with error: ${img.src} - ${errorMessage}`);
  } else if (status === 'ok') {
    console.log(`Image successfully processed: ${img.src}`);
  }
}

// Listen for messages from background script
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'replaceImage') {
    replaceImageElement(message.imageUrl, message.imageElement, message.originalImageUrl);
  } else if (message.action === 'overlayText') {
    overlayTextBoxes(message.textRegions, message.imageElement, message.originalImageUrl, message.cleanedImageUrl);
  } else if (message.action === 'showBatchSelectorDialog') {
    showBatchSelectorDialog();
  } else if (message.action === 'reloadSettings') {
    // Reload settings and re-setup features
    if (message.settings) {
      settings = message.settings;
    } else {
      browser.runtime.sendMessage({ action: 'getSettings' }).then(response => {
        settings = response.settings;
        setupFeatures();
      });
    }
  } else if (message.action === 'updateSelector') {
    currentSelector = message.selector;
    if (autoTranslateEnabled) {
      startAutoTranslation();
    }
  } else if (message.action === 'startAutoTranslate') {
    startAutoTranslation(message.selector);
  } else if (message.action === 'stopAutoTranslate') {
    stopAutoTranslation();
  } else if (message.action === 'markImageProcessed') {
    // Handle mark image processed message from background script
    const element = findElementByUrl(message.originalImageUrl);
    if (element) {
      markImageAsProcessed(element, message.status, message.error);
    }
  }
  
  return true; // Keep message channel open for async response
});

// Add visual feedback for images that can be translated
document.addEventListener('contextmenu', (e) => {
  if (e.target.tagName === 'IMG') {
    e.target.style.outline = '2px solid #4A90E2';
    setTimeout(() => {
      e.target.style.outline = '';
    }, 500);
  }
});

// Track selected image for keyboard shortcut
document.addEventListener('mouseenter', (e) => {
  if (e.target.tagName === 'IMG') {
    selectedImage = e.target;
  }
}, true);

// Keyboard shortcut handler (Alt+T)
document.addEventListener('keydown', (e) => {
  if (e.altKey && e.key.toLowerCase() === 't') {
    if (selectedImage) {
      e.preventDefault();
      translateSelectedImage();
    }
  }
  
  // Shift+Alt+T for batch translation
  if (e.shiftKey && e.altKey && e.key.toLowerCase() === 't') {
    e.preventDefault();
    translateBatchImages();
  }
});

// Show batch selector dialog
function showBatchSelectorDialog() {
  // Remove existing dialog
  const existingDialog = document.getElementById('manga-translator-batch-dialog');
  if (existingDialog) {
    existingDialog.remove();
  }
  
  // Create dialog container
  const dialog = document.createElement('div');
  dialog.id = 'manga-translator-batch-dialog';
  dialog.style.cssText = `
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: white;
    padding: 20px;
    border-radius: 8px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    z-index: 100000;
    min-width: 400px;
    max-width: 600px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  `;
  
  dialog.innerHTML = `
    <h3 style="margin: 0 0 15px 0; color: #333;">Batch Translate Images</h3>
    <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #555;">
      CSS Selector (one per line):
    </label>
    <textarea 
      id="batch-selector-textarea" 
      style="width: 100%; height: 120px; padding: 8px; border: 1px solid #ddd; border-radius: 4px; resize: vertical; font-family: monospace; font-size: 12px;"
      placeholder="img.manga-image&#10;.comic-panel img&#10;[name="image-item"] img&#10;.chapter img"
    >[name="image-item"] img</textarea>
    <div style="margin-top: 10px; font-size: 11px; color: #777;">
      Enter CSS selectors to target images for translation. One selector per line.<br>
      Images matching these selectors will be translated immediately.
    </div>
    <div style="margin-top: 15px; display: flex; gap: 10px;">
      <button 
        id="batch-translate-btn" 
        style="flex: 1; padding: 10px; background: #4A90E2; color: white; border: none; border-radius: 4px; font-weight: 600; cursor: pointer;"
      >
        Translate Now
      </button>
      <button 
        id="batch-cancel-btn" 
        style="flex: 1; padding: 10px; background: #f0f0f0; color: #333; border: none; border-radius: 4px; font-weight: 600; cursor: pointer;"
      >
        Cancel
      </button>
    </div>
  `;
  
  // Add backdrop
  const backdrop = document.createElement('div');
  backdrop.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0,0,0,0.5);
    z-index: 99999;
  `;
  
  document.body.appendChild(backdrop);
  document.body.appendChild(dialog);
  
  // Focus on textarea
  setTimeout(() => {
    document.getElementById('batch-selector-textarea').focus();
  }, 100);
  
  // Handle translate button
  document.getElementById('batch-translate-btn').addEventListener('click', () => {
    const selectors = document.getElementById('batch-selector-textarea').value
      .split('\n')
      .map(s => s.trim())
      .filter(s => s.length > 0);
    
    if (selectors.length === 0) {
      alert('Please enter at least one CSS selector');
      return;
    }
    
    // Close dialog
    dialog.remove();
    backdrop.remove();
    
    // Translate images with each selector
    selectors.forEach(selector => {
      console.log('Translating images with selector:', selector);
      translateImagesWithSelector(selector);
    });
  });
  
  // Handle cancel button and backdrop click
  const cancelDialog = () => {
    dialog.remove();
    backdrop.remove();
  };
  
  document.getElementById('batch-cancel-btn').addEventListener('click', cancelDialog);
  backdrop.addEventListener('click', cancelDialog);
  
  // Prevent dialog close when clicking inside dialog
  dialog.addEventListener('click', (e) => {
    e.stopPropagation();
  });
}

// Add hover button to image
function addHoverButton(img) {
  // Check if hover button already exists
  if (img.dataset.hasHoverButton) return;
  img.dataset.hasHoverButton = 'true';
  
  const hoverButton = document.createElement('div');
  hoverButton.innerHTML = '🌐';
  hoverButton.className = 'manga-translator-hover-btn';
  hoverButton.style.cssText = `
    position: absolute;
    background: #4A90E2;
    color: white;
    border: none;
    border-radius: 50%;
    width: 32px;
    height: 32px;
    display: none;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    font-size: 16px;
    z-index: 10000;
    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
    transition: transform 0.2s;
    pointer-events: auto;
  `;
  
  hoverButton.addEventListener('mouseenter', () => {
    hoverButton.style.transform = 'scale(1.1)';
  });
  
  hoverButton.addEventListener('mouseleave', () => {
    hoverButton.style.transform = 'scale(1)';
  });
  
  hoverButton.addEventListener('click', (e) => {
    e.stopPropagation();
    selectedImage = img;
    translateSelectedImage();
    hoverButton.style.display = 'none';
  });
  
  // Add hover events to image
  img.addEventListener('mouseenter', () => {
    if (autoTranslateEnabled && currentSelector && img.matches(currentSelector)) {
      // Don't show hover button for auto-translated images
      return;
    }
    
    if (img.naturalWidth > 200 && img.naturalHeight > 100) {
      const rect = img.getBoundingClientRect();
      hoverButton.style.display = 'flex';
      hoverButton.style.left = `${rect.right - 40 + window.scrollX}px`;
      hoverButton.style.top = `${rect.top + 8 + window.scrollY}px`;
    }
  });
  
  img.addEventListener('mouseleave', () => {
    setTimeout(() => {
      hoverButton.style.display = 'none';
    }, 100);
  });
  
  document.body.appendChild(hoverButton);
}

function translateSelectedImage() {
  if (!selectedImage) return;
  
  const imageUrl = selectedImage.src;
  
  if (imageUrl && imageUrl.startsWith('http')) {
    // Skip if already processed
    if (selectedImage.dataset.miProcessed === 'true') {
      console.log('Skipping already processed image');
      return;
    }
    
    const elementInfo = getElementInfo(selectedImage);
    
    browser.runtime.sendMessage({
      action: 'translateImage',
      imageUrl: imageUrl,
      imageElement: elementInfo
    });
  }
}

// Get serializable element info
function getElementInfo(element) {
  const rect = element.getBoundingClientRect();
  return {
    src: element.src,
    alt: element.alt,
    id: element.id,
    className: element.className,
    rect: {
      left: rect.left + window.scrollX,
      top: rect.top + window.scrollY,
      width: rect.width,
      height: rect.height
    },
    uid: generateElementUID(element)
  };
}

function generateElementUID(element) {
  return `img_${element.src.slice(-20)}_${element.offsetTop}_${element.offsetLeft}`;
}

// Find element by UID
function findElementByUID(uid) {
  const images = document.querySelectorAll('img');
  for (const img of images) {
    if (generateElementUID(img) === uid) {
      return img;
    }
  }
  return null;
}

// Find element by image URL
function findElementByUrl(url) {
  const images = document.querySelectorAll('img');
  for (const img of images) {
    if (img.src === url) {
      return img;
    }
  }
  return null;
}

// Replace image in page
function replaceImageElement(newImageUrl, elementInfo, originalImageUrl) {
  let element;
  
  if (elementInfo && elementInfo.uid) {
    element = findElementByUID(elementInfo.uid);
  }
  
  if (!element && originalImageUrl) {
    element = findElementByUrl(originalImageUrl);
  }
  
  if (!element) {
    console.error('Could not find element to replace');
    return;
  }
  
  element.style.transition = 'opacity 0.3s ease';
  element.style.opacity = '0';
  
  setTimeout(() => {
    element.src = newImageUrl;
    element.style.opacity = '1';
    
    // Mark as processed
    markImageAsProcessed(element, 'ok');
    element.style.border = '2px solid #4A90E2';
    
    setTimeout(() => {
      element.style.border = '';
    }, 2000);
  }, 300);
}

// Overlay text boxes on image
function overlayTextBoxes(textRegions, elementInfo, originalImageUrl, cleanedImageUrl = null) {
  let element;
  
  if (elementInfo && elementInfo.uid) {
    element = findElementByUID(elementInfo.uid);
  }
  
  if (!element && originalImageUrl) {
    element = findElementByUrl(originalImageUrl);
  }
  
  if (!element) {
    console.error('Could not find element for overlay');
    return;
  }
  
  // Wait for image to be fully loaded and visible
  waitForImageReady(element).then(() => {
    createOverlayForImage(element, textRegions, elementInfo, originalImageUrl, cleanedImageUrl);
  }).catch(error => {
    console.error('Error waiting for image ready:', error);
  });
}

// New function to wait for image to be ready
function waitForImageReady(img) {
  return new Promise((resolve, reject) => {
    // Check if image is already loaded and has dimensions
    if (img.complete && img.naturalWidth > 0 && img.naturalHeight > 0) {
      // Check if element has rendered dimensions
      const rect = img.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        resolve();
        return;
      }
    }
    
    // Wait for load event
    const handleLoad = () => {
      cleanup();
      // Double check dimensions after load
      checkDimensions();
    };
    
    const handleError = () => {
      cleanup();
      reject(new Error('Image failed to load'));
    };
    
    const checkDimensions = () => {
      const rect = img.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        resolve();
      } else {
        // Use IntersectionObserver if dimensions still not available
        observeVisibility();
      }
    };
    
    const observeVisibility = () => {
      const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting && entry.boundingClientRect.width > 0) {
            observer.disconnect();
            resolve();
          }
        });
      }, { threshold: 0.01 });
      
      observer.observe(img);
      
      // Fallback timeout
      setTimeout(() => {
        observer.disconnect();
        resolve(); // Resolve anyway after timeout
      }, 5000);
    };
    
    const cleanup = () => {
      img.removeEventListener('load', handleLoad);
      img.removeEventListener('error', handleError);
    };
    
    img.addEventListener('load', handleLoad);
    img.addEventListener('error', handleError);
    
    // If image is already complete but failed earlier checks, try intersection observer
    if (img.complete) {
      cleanup();
      checkDimensions();
    }
  });
}

function createOverlayForImage(element, textRegions, elementInfo, originalImageUrl, cleanedImageUrl) {
  // Remove existing overlays
  const existingOverlay = document.querySelector(`[data-overlay-for="${elementInfo ? elementInfo.uid : originalImageUrl}"]`);
  if (existingOverlay) {
    existingOverlay.remove();
  }
  
  const rect = element.getBoundingClientRect();
  
  // Final check for valid dimensions
  if (rect.width === 0 || rect.height === 0) {
    console.warn('Image still has no dimensions, retrying...', originalImageUrl);
    // Retry after a short delay
    setTimeout(() => {
      const newRect = element.getBoundingClientRect();
      if (newRect.width > 0 && newRect.height > 0) {
        createOverlayForImage(element, textRegions, elementInfo, originalImageUrl, cleanedImageUrl);
      }
    }, 500);
    return;
  }
  
  const overlayContainer = document.createElement('div');
  overlayContainer.dataset.overlayFor = elementInfo ? elementInfo.uid : originalImageUrl;
  overlayContainer.style.cssText = `
    position: absolute;
    left: ${rect.left + window.scrollX}px;
    top: ${rect.top + window.scrollY}px;
    width: ${rect.width}px;
    height: ${rect.height}px;
    pointer-events: none;
    z-index: 9999;
  `;
  
  if (settings.overlayMode === 'cleaned' && cleanedImageUrl) {
    const cleanedImg = document.createElement('img');
    cleanedImg.src = cleanedImageUrl;
    cleanedImg.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      object-fit: contain;
      pointer-events: none;
    `;
    overlayContainer.appendChild(cleanedImg);
  }
  
  if (textRegions && textRegions.length > 0) {
    textRegions.forEach(region => {
      const textBox = createTextBox(region, rect, element);
      overlayContainer.appendChild(textBox);
    });
  } else {
    const msg = document.createElement('div');
    msg.style.cssText = `
      position: absolute;
      top: 10px;
      left: 10px;
      background: rgba(74, 144, 226, 0.9);
      color: white;
      padding: 8px 12px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: bold;
    `;
    msg.textContent = 'No text regions found';
    overlayContainer.appendChild(msg);
    
    setTimeout(() => overlayContainer.remove(), 3000);
  }
  
  document.body.appendChild(overlayContainer);
  
  // Update position on scroll/resize
  const updatePosition = () => {
    const newRect = element.getBoundingClientRect();
    if (newRect.width > 0 && newRect.height > 0) {
      overlayContainer.style.left = `${newRect.left + window.scrollX}px`;
      overlayContainer.style.top = `${newRect.top + window.scrollY}px`;
      overlayContainer.style.width = `${newRect.width}px`;
      overlayContainer.style.height = `${newRect.height}px`;
    }
  };
  
  window.addEventListener('scroll', updatePosition);
  window.addEventListener('resize', updatePosition);
  
  markImageAsProcessed(element, 'ok');
  element.style.outline = '2px solid #4A90E2';
  setTimeout(() => {
    element.style.outline = '';
  }, 2000);
}

// Create individual text box
function createTextBox(region, imgRect, imgElement) {
  const box = document.createElement('div');
  
  // Get natural image dimensions for accurate scaling
  const naturalWidth = imgElement.naturalWidth;
  const naturalHeight = imgElement.naturalHeight;
  
  // Calculate position and size relative to image
  const x = (region.x / naturalWidth) * imgRect.width;
  const y = (region.y / naturalHeight) * imgRect.height;
  const width = (region.width / naturalWidth) * imgRect.width;
  const height = (region.height / naturalHeight) * imgRect.height;
  
  // Apply rotation if needed
  const transform = region.angle && region.angle !== 0 ? `rotate(${region.angle}deg)` : 'none';
  
  // Determine text and background colors
  let textColor;
  let backgroundColor;
  
  // Helper function to calculate brightness
  const getBrightness = (rgbString) => {
    const rgb = rgbString.match(/\d+/g);
    if (rgb && rgb.length >= 3) {
      const r = parseInt(rgb[0]);
      const g = parseInt(rgb[1]);
      const b = parseInt(rgb[2]);
      return (r * 299 + g * 587 + b * 114) / 1000;
    }
    return 128;
  };
  
  // Get original colors from backend
  const originalFgColor = region.fg_color || 'rgb(0,0,0)';
  const originalBgColor = region.bg_color || 'rgb(255,255,255)';
  const fgBrightness = getBrightness(originalFgColor);
  const bgBrightness = getBrightness(originalBgColor);
  
  // Determine colors based on settings
  if (settings.overlayTextColor === 'auto') {
    // Use original colors from backend detection
    textColor = originalFgColor;
    
    // For colored mode, use inverted background for contrast
    if (settings.overlayMode === 'colored') {
      // If original text was dark on light background, use light background
      // If original text was light on dark background, use dark background
      if (fgBrightness < 128) {
        // Dark text -> use light background
        backgroundColor = `rgba(255, 255, 255, ${settings.overlayOpacity / 100})`;
      } else {
        // Light text -> use dark background
        backgroundColor = `rgba(0, 0, 0, ${settings.overlayOpacity / 100})`;
      }
    }
  } else if (settings.overlayTextColor === 'white') {
    textColor = '#ffffff';
    if (settings.overlayMode === 'colored') {
      backgroundColor = `rgba(0, 0, 0, ${settings.overlayOpacity / 100})`;
    }
  } else if (settings.overlayTextColor === 'black') {
    textColor = '#000000';
    if (settings.overlayMode === 'colored') {
      backgroundColor = `rgba(255, 255, 255, ${settings.overlayOpacity / 100})`;
    }
  } else if (settings.overlayTextColor === 'custom') {
    textColor = settings.customTextColor;
    // Determine background based on custom text color brightness
    const customBrightness = getBrightness(textColor);
    if (settings.overlayMode === 'colored') {
      if (customBrightness < 128) {
        backgroundColor = `rgba(255, 255, 255, ${settings.overlayOpacity / 100})`;
      } else {
        backgroundColor = `rgba(0, 0, 0, ${settings.overlayOpacity / 100})`;
      }
    }
  }
  
  // Build background style
  let backgroundStyle = '';
  if (settings.overlayMode === 'colored' && backgroundColor) {
    backgroundStyle = `background-color: ${backgroundColor}; border-radius: 4px; padding: 4px;`;
  }
  
  box.style.cssText = `
    position: absolute;
    left: ${x}px;
    top: ${y}px;
    width: ${width}px;
    height: ${height}px;
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
    word-wrap: break-word;
    font-family: Arial, sans-serif;
    color: ${textColor};
    font-size: ${Math.max(12, Math.min(24, height / 2))}px;
    font-weight: ${region.bold ? 'bold' : 'normal'};
    line-height: 1.2;
    ${backgroundStyle}
    transform: ${transform};
    transform-origin: center;
    box-sizing: border-box;
  `;
  
  // Add text shadow for better readability (except in cleaned mode)
  if (settings.overlayMode !== 'cleaned') {
    // Use contrasting shadow based on text brightness
    const textBrightness = getBrightness(textColor);
    const shadowColor = textBrightness < 128 ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.8)';
    box.style.textShadow = `
      -1px -1px 0 ${shadowColor},
      1px -1px 0 ${shadowColor},
      -1px 1px 0 ${shadowColor},
      1px 1px 0 ${shadowColor},
      0 0 3px ${shadowColor}
    `;
  }
  
  box.textContent = region.translated_text || region.text || '';
  
  // Make draggable if enabled
  if (settings.draggableOverlay) {
    makeElementDraggable(box);
  }
  
  return box;
}

// Make an element draggable
function makeElementDraggable(element) {
  let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
  
  element.style.pointerEvents = 'auto';
  element.style.cursor = 'move';
  
  element.onmousedown = dragMouseDown;
  
  function dragMouseDown(e) {
    e = e || window.event;
    e.preventDefault();
    e.stopPropagation();
    
    pos3 = e.clientX;
    pos4 = e.clientY;
    
    document.onmouseup = closeDragElement;
    document.onmousemove = elementDrag;
  }
  
  function elementDrag(e) {
    e = e || window.event;
    e.preventDefault();
    
    pos1 = pos3 - e.clientX;
    pos2 = pos4 - e.clientY;
    pos3 = e.clientX;
    pos4 = e.clientY;
    
    element.style.top = (element.offsetTop - pos2) + "px";
    element.style.left = (element.offsetLeft - pos1) + "px";
  }
  
  function closeDragElement() {
    document.onmouseup = null;
    document.onmousemove = null;
  }
}

// Initialize hover buttons for existing images
function initializeHoverButtons() {
  const images = document.querySelectorAll('img');
  images.forEach(img => {
    addHoverButton(img);
  });
}

// Initialize on DOM content loaded
document.addEventListener('DOMContentLoaded', () => {
  console.log('Manga Translator content script loaded');
  console.log('Current settings:', settings);
});