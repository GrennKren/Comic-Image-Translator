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
let processIndicator = null; 
let indicatorAutoHide = true;

// Load settings with retry mechanism
async function loadSettingsWithRetry(retries = 5, delay = 200) {
  for (let i = 0; i < retries; i++) {
    try {
      const result = await browser.storage.local.get('settings');
      if (result.settings && result.settings.backendUrl) {
        console.log('Settings loaded from storage:', result.settings);
        settings = result.settings;
        settingsLoaded = true;
        setupFeatures();
        return;
      }
      
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
    autoTranslate: true,
    showProcessIndicator: true,
    fontSizeOffset: 0
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
  
  createProcessIndicator();
  
  if (imageObserver) {
    imageObserver.disconnect();
    imageObserver = null;
  }
  
  if (pageChangeObserver) {
    pageChangeObserver.disconnect();
    pageChangeObserver = null;
  }
  
  currentSelector = getActiveSelectors();
  
  if (settings.enableCache) {
    preloadCacheForAllImages();
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
  
  const specificRules = settings.selectorRules
    .filter(rule => rule.enabled && !rule.isGeneral && matchesDomain(currentDomain, rule.domains))
    .map(rule => rule.selector)
    .filter(s => s);
  
  if (specificRules.length > 0) {
    return specificRules.join(', ');
  }
  
  const generalRules = settings.selectorRules
    .filter(rule => rule.enabled && rule.isGeneral)
    .map(rule => rule.selector)
    .filter(s => s);
  
  return generalRules.length > 0 ? generalRules.join(', ') : null;
}

async function preloadCacheForAllImages() {
  try {
    const images = document.querySelectorAll('img');
    if (images.length === 0) return;
    
    const imageArray = Array.from(images)
      .filter(img => img.src && img.src.startsWith('http'))
      .filter(img => img.naturalWidth > 100 && img.naturalHeight > 100)
      .filter(img => img.dataset.miProcessed !== 'true');
    
    if (imageArray.length > 0) {
      console.log(`Found ${imageArray.length} images for cache application`);
      
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

function cleanupOrphanedOverlays() {
  const overlays = document.querySelectorAll('[data-overlay-for]');
  overlays.forEach(overlay => {
    const overlayFor = overlay.dataset.overlayFor;
    const imgExists = document.querySelector(`img[src*="${overlayFor.split('_').slice(-1).join('_')}"]`);
    if (!imgExists) {
      overlay.remove();
    }
  });
}

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
        matchingImages.forEach(img => {
          const elementInfo = getElementInfo(img);
          browser.runtime.sendMessage({
            action: 'applyCacheOnly',
            imageUrl: img.src,
            imageElement: elementInfo
          }).catch(() => {});
        });
        
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

function setupPageChangeObserver() {
  console.log('Setting up page change observer');
  
  let lastUrl = location.href;
  
  pageChangeObserver = new MutationObserver(() => {
    const url = location.href;
    if (url !== lastUrl) {
      lastUrl = url;
      console.log('Page URL changed:', url);
      
      cleanupOrphanedOverlays();
      
      if (autoTranslateEnabled) {
        scanExistingImages();
      }
    }
  });
  
  const titleElement = document.querySelector('title');
  if (titleElement) {
    pageChangeObserver.observe(titleElement, {
      childList: true,
      subtree: true
    });
  }
  
  window.addEventListener('popstate', () => {
    console.log('Popstate event detected');
    cleanupOrphanedOverlays();
    
    if (autoTranslateEnabled) {
      scanExistingImages();
    }
  });
  
  window.addEventListener('pagechange', () => {
    console.log('Page change event detected');
    cleanupOrphanedOverlays();
    
    if (autoTranslateEnabled) {
      scanExistingImages();
    }
  });
  
  console.log('Page change observer started');
}

function setupLazyLoadingObserver(img) {
  if (img.dataset.lazyObserverSetup) return;
  img.dataset.lazyObserverSetup = 'true';
  
  const lazyObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const img = entry.target;
        
        if (img.dataset.src && !img.src) {
          img.src = img.dataset.src;
        }
        
        if (img.dataset.lazySrc && !img.src) {
          img.src = img.dataset.lazySrc;
        }
        
        if (shouldProcessImage(img) && autoTranslateEnabled && img.matches(currentSelector)) {
          queueImageForTranslation(img);
        }
        
        observer.unobserve(img);
      }
    });
  });
  
  lazyObserver.observe(img);
}

function scanExistingImages() {
  if (!currentSelector) return;
  
  console.log('Scanning for existing images with selector:', currentSelector);
  translateImagesWithSelector(currentSelector);
}

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

function stopAutoTranslation() {
  autoTranslateEnabled = false;
  currentSelector = '';
  console.log('Auto-translation stopped');
}

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

function shouldProcessImage(img) {
  if (img.dataset.miProcessed === 'true') {
    return false;
  }
  
  if (!img.src || !img.src.startsWith('http')) {
    if (!img.dataset.src || !img.dataset.src.startsWith('http')) {
      return false;
    }
  }
  
  if (img.naturalWidth > 0 && img.naturalHeight > 0) {
    if (img.naturalWidth < 100 || img.naturalHeight < 100) {
      return false;
    }
  }
  
  if (translationQueue.has(img)) {
    return false;
  }
  
  return true;
}

function queueImageForTranslation(img) {
  translationQueue.add(img);
  
  if (!autoTranslateEnabled) {
    img.style.outline = '2px solid #4A90E2';
  }
  
  if (!isProcessing) {
    processTranslationQueue();
  }
}

async function processTranslationQueue() {
  if (translationQueue.size === 0) {
    isProcessing = false;
    hideProcessIndicator();
    return;
  }
  
  isProcessing = true;
  
  updateProcessIndicator(`Translating ${translationQueue.size} image${translationQueue.size > 1 ? 's' : ''}...`, true, true);
  
  for (const img of translationQueue) {
    try {
      updateProcessIndicator(`Translating... (${translationQueue.size} remaining)`, true, true);
      await translateSingleImage(img);
      translationQueue.delete(img);
      
      await new Promise(resolve => setTimeout(resolve, 300));
    } catch (error) {
      console.error('Error translating image:', error);
      markImageAsProcessed(img, 'error', error.message);
      translationQueue.delete(img);
    }
  }
  
  isProcessing = false;
  updateProcessIndicator('All translations completed', true, false);
  setTimeout(() => hideProcessIndicator(), 2000);
  
  if (translationQueue.size > 0) {
    processTranslationQueue();
  }
}

function createProcessIndicator() {
  if (processIndicator) return;
  
  processIndicator = document.createElement('div');
  processIndicator.id = 'comic-translator-indicator';
  processIndicator.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    background: rgba(0, 0, 0, 0.7);
    color: white;
    padding: 8px 12px;
    border-radius: 20px;
    font-size: 12px;
    z-index: 10000;
    display: none;
    align-items: center;
    gap: 8px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.2);
    transition: opacity 0.3s ease;
    max-width: 300px;
  `;
  
  const spinner = document.createElement('div');
  spinner.style.cssText = `
    width: 12px;
    height: 12px;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-top: 2px solid white;
    border-radius: 50%;
    animation: spin 1s linear infinite;
  `;
  
  const style = document.createElement('style');
  style.textContent = `
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
  `;
  document.head.appendChild(style);
  
  const text = document.createElement('span');
  text.id = 'comic-translator-indicator-text';
  text.textContent = 'Processing...';
  
  const closeBtn = document.createElement('span');
  closeBtn.innerHTML = '×';
  closeBtn.style.cssText = `
    margin-left: 8px;
    cursor: pointer;
    font-size: 16px;
    opacity: 0.7;
    transition: opacity 0.2s;
  `;
  closeBtn.addEventListener('mouseenter', () => {
    closeBtn.style.opacity = '1';
  });
  closeBtn.addEventListener('mouseleave', () => {
    closeBtn.style.opacity = '0.7';
  });
  closeBtn.addEventListener('click', hideProcessIndicator);
  
  processIndicator.appendChild(spinner);
  processIndicator.appendChild(text);
  processIndicator.appendChild(closeBtn);
  document.body.appendChild(processIndicator);
}

function updateProcessIndicator(text, show = true, persistent = false) {
  if (!settings.showProcessIndicator) {
    hideProcessIndicator();
    return;
  }
  
  if (!processIndicator) {
    createProcessIndicator();
  }
  
  const textElement = document.getElementById('comic-translator-indicator-text');
  if (textElement) {
    textElement.textContent = text || 'Processing...';
  }
  
  if (show) {
    processIndicator.style.display = 'flex';
  } else {
    hideProcessIndicator();
  }
}

function hideProcessIndicator() {
  if (processIndicator) {
    processIndicator.style.display = 'none';
    clearTimeout(processIndicator.hideTimeout);
  }
}

async function translateSingleImage(img) {
  console.log('Translating image:', img.src);
  
  const elementInfo = getElementInfo(img);
  
  updateProcessIndicator('Translating...', true, true);
  
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      markImageAsProcessed(img, 'error', 'Translation timeout');
      updateProcessIndicator('Translation timeout', true, false);
      setTimeout(() => hideProcessIndicator(), 3000);
      reject(new Error('Translation timeout'));
    }, 60000);
    
    browser.runtime.sendMessage({
      action: 'translateImage',
      imageUrl: img.src,
      imageElement: elementInfo
    }).then(response => {
      clearTimeout(timeoutId);
      img.style.outline = '';
      updateProcessIndicator('Translation completed', true, false);
      setTimeout(() => hideProcessIndicator(), 2000);
      markImageAsProcessed(img, 'ok');
      resolve(response);
    }).catch(error => {
      clearTimeout(timeoutId);
      img.style.outline = '';
      updateProcessIndicator('Translation failed', true, false);
      setTimeout(() => hideProcessIndicator(), 3000);
      markImageAsProcessed(img, 'error', error.message);
      console.warn('Translation failed for image:', img.src, 'Error:', error.message);
      resolve(null);
    });
  });
}

function markImageAsProcessed(img, status, errorMessage = '') {
  img.dataset.miProcessed = 'true';
  img.dataset.miStatus = status;
  
  if (status === 'error' && errorMessage) {
    img.dataset.miError = errorMessage.substring(0, 100);
    console.warn(`Image marked as processed with error: ${img.src} - ${errorMessage}`);
  } else if (status === 'ok') {
    console.log(`Image successfully processed: ${img.src}`);
  }
}

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'replaceImage') {
    replaceImageElement(message.imageUrl, message.imageElement, message.originalImageUrl);
  } else if (message.action === 'overlayText') {
    overlayTextBoxes(message.textRegions, message.imageElement, message.originalImageUrl, message.cleanedImageUrl);
  } else if (message.action === 'reloadSettings') {
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
    const element = findElementByUrl(message.originalImageUrl);
    if (element) {
      markImageAsProcessed(element, message.status, message.error);
    }
  } else if (message.action === 'updateProcessIndicator') {
    updateProcessIndicator(message.text);
  } else if (message.action === 'hideProcessIndicator') {
    hideProcessIndicator();
  }
  
  return true;
});

document.addEventListener('contextmenu', (e) => {
  if (e.target.tagName === 'IMG') {
    e.target.style.outline = '2px solid #4A90E2';
    setTimeout(() => {
      e.target.style.outline = '';
    }, 500);
  }
});

document.addEventListener('mouseenter', (e) => {
  if (e.target.tagName === 'IMG') {
    selectedImage = e.target;
  }
}, true);

document.addEventListener('keydown', (e) => {
  if (e.altKey && e.key.toLowerCase() === 't') {
    if (selectedImage) {
      e.preventDefault();
      translateSelectedImage();
    }
  }
});

function translateSelectedImage() {
  if (!selectedImage) return;
  
  const imageUrl = selectedImage.src;
  
  if (imageUrl && imageUrl.startsWith('http')) {
    if (selectedImage.dataset.miProcessed === 'true') {
      console.log('Skipping already processed image');
      return;
    }
    
    const elementInfo = getElementInfo(selectedImage);
    
    updateProcessIndicator('Translating selected image...', true, true);
    
    browser.runtime.sendMessage({
      action: 'translateImage',
      imageUrl: imageUrl,
      imageElement: elementInfo
    });
  }
}

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

function findElementByUID(uid) {
  const images = document.querySelectorAll('img');
  for (const img of images) {
    if (generateElementUID(img) === uid) {
      return img;
    }
  }
  return null;
}

function findElementByUrl(url) {
  const images = document.querySelectorAll('img');
  for (const img of images) {
    if (img.src === url) {
      return img;
    }
  }
  return null;
}

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
    
    markImageAsProcessed(element, 'ok');
    element.style.border = '2px solid #4A90E2';
    
    setTimeout(() => {
      element.style.border = '';
    }, 2000);
  }, 300);
}

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
  
  waitForImageReady(element).then(() => {
    createOverlayForImage(element, textRegions, elementInfo, originalImageUrl, cleanedImageUrl);
  }).catch(error => {
    console.error('Error waiting for image ready:', error);
  });
}

function waitForImageReady(img) {
  return new Promise((resolve, reject) => {
    if (img.complete && img.naturalWidth > 0 && img.naturalHeight > 0) {
      const rect = img.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        resolve();
        return;
      }
    }
    
    const handleLoad = () => {
      cleanup();
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
      
      setTimeout(() => {
        observer.disconnect();
        resolve();
      }, 5000);
    };
    
    const cleanup = () => {
      img.removeEventListener('load', handleLoad);
      img.removeEventListener('error', handleError);
    };
    
    img.addEventListener('load', handleLoad);
    img.addEventListener('error', handleError);
    
    if (img.complete) {
      cleanup();
      checkDimensions();
    }
  });
}

function createOverlayForImage(element, textRegions, elementInfo, originalImageUrl, cleanedImageUrl) {
  const existingOverlay = document.querySelector(`[data-overlay-for="${elementInfo ? elementInfo.uid : originalImageUrl}"]`);
  if (existingOverlay) {
    existingOverlay.remove();
  }
  
  const rect = element.getBoundingClientRect();
  
  if (rect.width === 0 || rect.height === 0) {
    console.warn('Image still has no dimensions, retrying...', originalImageUrl);
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
  overlayContainer.dataset.originalImageUrl = originalImageUrl;
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
  
  const updatePosition = () => {
    const newRect = element.getBoundingClientRect();
    if (newRect.width > 0 && newRect.height > 0) {
      overlayContainer.style.left = `${newRect.left + window.scrollX}px`;
      overlayContainer.style.top = `${newRect.top + window.scrollY}px`;
      overlayContainer.style.width = `${newRect.width}px`;
      overlayContainer.style.height = `${newRect.height}px`;
    } else {
      overlayContainer.remove();
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

function createTextBox(region, imgRect, imgElement) {
  const box = document.createElement('div');
  
  const naturalWidth = imgElement.naturalWidth;
  const naturalHeight = imgElement.naturalHeight;
  
  const x = (region.x / naturalWidth) * imgRect.width;
  const y = (region.y / naturalHeight) * imgRect.height;
  const width = (region.width / naturalWidth) * imgRect.width;
  const height = (region.height / naturalHeight) * imgRect.height;
  
  const transform = region.angle && region.angle !== 0 ? `rotate(${region.angle}deg)` : 'none';
  
  let textColor;
  let backgroundColor;
  
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
  
  const originalFgColor = region.fg_color || 'rgb(0,0,0)';
  const originalBgColor = region.bg_color || 'rgb(255,255,255)';
  const fgBrightness = getBrightness(originalFgColor);
  const bgBrightness = getBrightness(originalBgColor);
  
  if (settings.overlayTextColor === 'auto') {
    textColor = originalFgColor;
    
    if (settings.overlayMode === 'colored') {
      if (fgBrightness < 128) {
        backgroundColor = `rgba(255, 255, 255, ${settings.overlayOpacity / 100})`;
      } else {
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
    const customBrightness = getBrightness(textColor);
    if (settings.overlayMode === 'colored') {
      if (customBrightness < 128) {
        backgroundColor = `rgba(255, 255, 255, ${settings.overlayOpacity / 100})`;
      } else {
        backgroundColor = `rgba(0, 0, 0, ${settings.overlayOpacity / 100})`;
      }
    }
  }
  
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
  
  if (settings.overlayMode !== 'cleaned') {
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
  
  if (settings.draggableOverlay) {
    makeElementDraggable(box);
  }
  
  return box;
}

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

function initializeHoverButtons() {
  const images = document.querySelectorAll('img');
  images.forEach(img => {
    addHoverButton(img);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  console.log('Comic Translator content script loaded');
  console.log('Current settings:', settings);
});

function addHoverButton(img) {
  if (img.dataset.hasHoverButton) return;
  img.dataset.hasHoverButton = 'true';
  
  const hoverButton = document.createElement('div');
  hoverButton.innerHTML = '🌐';
  hoverButton.className = 'comic-translator-hover-btn';
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
  
  img.addEventListener('mouseenter', () => {
    if (autoTranslateEnabled && currentSelector && img.matches(currentSelector)) {
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