// Background script for Comic Image Translator Extension

if (typeof importScripts !== 'undefined') {
  importScripts('browser-polyfill.js');
}

const DEFAULT_SETTINGS = {
  backendUrl: 'http://127.0.0.1:8000',
  translator: 'offline',
  targetLang: 'ENG',
  detector: 'default',
  inpainter: 'lama_large',
  renderer: 'manga2eng',
  displayMode: 'overlay',
  inpaintingSize: 2048,
  autoReduceInpainting: true,
  showProcessIndicator: true,
  fontSizeOffset: 0,
  selectorRules: [
    {
      enabled: true,
      domains: '*',
      selector: 'img.manga-page, img.comic-page',
      id: Date.now(),
      isGeneral: true
    },
    {
      enabled: true,
      domains: 'bato.to',
      selector: '[name="image-item"] img',
      id: Date.now() + 1
    }
  ],
  autoTranslate: false,
  overlayMode: 'colored',
  overlayOpacity: 90,
  overlayTextColor: 'auto',
  customTextColor: '#ffffff',
  draggableOverlay: true,
  enableCache: true,
  skipProcessed: true,
  observeDynamicImages: true
};

let activeTranslations = new Map(); 
let translationQueue = []; 
let isProcessingQueue = false;
let isBatchTranslating = false;
let activeSingleTranslations = new Set();

// Service worker lifecycle: Log startup
self.addEventListener('activate', (event) => {
  console.log('Background service worker activated');
  event.waitUntil(clients.claim());
});

// Initialize settings on install
browser.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await browser.storage.local.set({ settings: DEFAULT_SETTINGS });
  }
  
  await updateContextMenu();
});

// Update context menu when tab changes
browser.tabs.onActivated.addListener(async (activeInfo) => {
  await updateContextMenu();
});

// Update context menu when tab URL changes
browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    await updateContextMenu();
  }
});

// Update context menu when settings change
browser.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName === 'local' && changes.settings) {
    await updateContextMenu();
  }
});


// Handle context menu clicks
if (browser.contextMenus) {
  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "translate-image") {
      const imageUrl = info.srcUrl;
      
      if (activeSingleTranslations.has(imageUrl)) {
        browser.tabs.sendMessage(tab.id, {
          action: 'updateProcessIndicator',
          text: 'Translation already in progress for this image',
          autoHide: true,
          duration: 2000
        }).catch(() => {});
        return;
      }
      
      if (isBatchTranslating) {
        browser.tabs.sendMessage(tab.id, {
          action: 'updateProcessIndicator',
          text: 'Batch translation in progress. Please wait.',
          autoHide: true,
          duration: 2000
        }).catch(() => {});
        return;
      }
      
      activeSingleTranslations.add(imageUrl);
      handleTranslationWithOOMRetry(info.srcUrl, tab.id, null, true)
        .finally(() => {
          activeSingleTranslations.delete(imageUrl);
        });
    } else if (info.menuItemId === "translate-all-images") {
      if (isBatchTranslating) {
        browser.tabs.sendMessage(tab.id, {
          action: 'updateProcessIndicator',
          text: 'Batch translation already in progress',
          autoHide: true,
          duration: 2000
        }).catch(() => {});
        return;
      }
      
      handleBatchTranslation(tab.id);
    }
  });
}

// Helper function to check connection errors
function isConnectionError(errorMessage) {
  return errorMessage.includes('NS_ERROR_CONNECTION_REFUSED') ||
         errorMessage.includes('Failed to fetch') ||
         errorMessage.includes('NetworkError') ||
         errorMessage.includes('ERR_CONNECTION_REFUSED') ||
         errorMessage.includes('net::ERR_') ||
         errorMessage.includes('404');
}

// Helper function to check OOM errors
function isOOMError(errorMessage) {
  return errorMessage.includes('out of memory') || 
         errorMessage.includes('CUDA out of memory') ||
         errorMessage.includes('OOM') ||
         errorMessage.includes('allocate') ||
         errorMessage.includes('memory') ||
         errorMessage.includes('Backend error: 500');
}

async function updateContextMenu() {
  try {
    // Remove existing context menus first
    if (browser.contextMenus) {
      await browser.contextMenus.removeAll();
    }
    
    // Always create single image translation menu
    if (browser.contextMenus) {
      await browser.contextMenus.create({
        id: "translate-image",
        title: "Translate Image",
        contexts: ["image"]
      });
    }
    
    // Check if we should show "Translate All" menu
    const currentTab = await browser.tabs.query({ active: true, currentWindow: true });
    if (currentTab && currentTab[0]) {
      const shouldShowTranslateAll = await shouldShowTranslateAllMenu(currentTab[0].id);
      
      if (shouldShowTranslateAll) {
        if (browser.contextMenus) {
          await browser.contextMenus.create({
            id: "translate-all-images",
            title: "Translate All Images",
            contexts: ["page", "selection", "image"]
          });
        }
      }
    }
  } catch (error) {
    console.error('Error updating context menu:', error);
  }
}

// Function to check if "Translate All" menu should be shown
async function shouldShowTranslateAllMenu(tabId) {
  try {
    // Get current settings
    const result = await browser.storage.local.get('settings');
    const settings = result.settings || DEFAULT_SETTINGS;

    // Check if selector rules exist
    if (!settings.selectorRules || !Array.isArray(settings.selectorRules)) {
      return false;
    }

    // Get current tab
    const tab = await browser.tabs.get(tabId);

    // Check if tab has valid URL (allow both http and https)
    if (!tab || !tab.url || !/^https?:\/\//.test(tab.url)) {
      return false;
    }

    const url = new URL(tab.url);
    const currentDomain = url.hostname;

    // Find matching selectors for current domain
    const matchingRules = settings.selectorRules.filter(rule => {
      if (!rule.enabled) return false;

      // Check if rule matches current domain
      if (rule.isGeneral) {
        return true; // General rules apply to all domains
      }

      return matchesDomain(currentDomain, rule.domains);
    });

    if (matchingRules.length === 0) {
      return false; // No selectors configured for this domain
    }

    // Get selectors from matching rules
    const selectors = matchingRules.map(rule => rule.selector).filter(s => s);
    if (selectors.length === 0) {
      return false;
    }

    // Use messaging to check if content script is loaded and get active selector
    try {
      const response = await browser.tabs.sendMessage(tabId, {
        action: 'getActiveSelectorAndCheckElements'
      }).catch(() => {
        // Ignore errors for tabs that don't have content script loaded
      });
      return response && response.hasElements;
    } catch (error) {
      // Content script not loaded, this is normal for some pages
      return false;
    }

  } catch (error) {
    console.error('Error checking if Translate All menu should be shown:', error);
    return false;
  }
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

async function handleBatchTranslation(tabId) {
  if (isBatchTranslating) {
    return;
  }
  
  isBatchTranslating = true;
  
  try {
    await browser.tabs.sendMessage(tabId, {
      action: 'startBatchTranslation'
    });
  } catch (error) {
    console.error('Error starting batch translation:', error);
    isBatchTranslating = false;
  }
}


// Handle messages from content scripts and popup
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'updateProcessIndicator') {
    browser.tabs.sendMessage(sender.tab.id, {
      action: 'updateProcessIndicator',
      text: message.text
    }).catch(() => {});
    return true;
  }
  
  if (message.action === 'hideProcessIndicator') {
    browser.tabs.sendMessage(sender.tab.id, {
      action: 'hideProcessIndicator'
    }).catch(() => {});
    return true;
  }
  
  if (message.action === 'translateImage') {
    handleTranslationWithOOMRetry(message.imageUrl, sender.tab.id, message.imageElement, false);
    return true;
  }
  
  if (message.action === 'getSettings') {
    browser.storage.local.get('settings').then(result => {
      sendResponse({ settings: result.settings || DEFAULT_SETTINGS });
    });
    return true;
  }

  if (message.action === 'applyCacheOnly') {
    applyCacheIfExists(message.imageUrl, message.imageElement, sender.tab.id);
    sendResponse({ success: true });
    return true;
  }
  
  if (message.action === 'translateBatch') {
    handleBatchTranslationWithOOMRetry(message.imageUrls, sender.tab.id);
    return true;
  }

  if (message && message.action === 'forceUpdateContextMenu') {
    updateContextMenu();
    sendResponse({ ok: true });
    return true;
  }
  
  return true;
});

async function applyCacheIfExists(imageUrl, imageElement, tabId) {
  try {
    const { settings } = await browser.storage.local.get('settings');
    const config = settings || DEFAULT_SETTINGS;
    
    if (!config.enableCache) return;
    
    const cacheKey = generateCacheKey(imageUrl, config);
    const cachedResult = await getCachedTranslation(cacheKey);
    
    if (cachedResult) {
      console.log('Applying cached translation for:', imageUrl);
      applyCachedResult(cachedResult, imageElement, tabId, imageUrl);
    }
  } catch (error) {
    console.error('Apply cache error:', error);
  }
}

async function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function generateCacheKey(imageUrl, settings) {
  const settingsString = JSON.stringify({
    translator: settings.translator,
    targetLang: settings.targetLang,
    detector: settings.detector,
    inpainter: settings.inpainter,
    renderer: settings.renderer,
    overlayMode: settings.overlayMode,
    overlayTextColor: settings.overlayTextColor
  });
  
  return `cache_${btoa(imageUrl + settingsString).replace(/[^a-zA-Z0-9]/g, '')}`;
}

function createConfig(settings) {
  const config = {
    translator: {
      translator: settings.translator,
      target_lang: settings.targetLang,
      no_text_lang_skip: false,
      skip_lang: null,
      gpt_config: null,
      translator_chain: null,
      selective_translation: null
    },
    detector: {
      detector: settings.detector,
      detection_size: 2048,
      text_threshold: 0.5,
      det_rotate: false,
      det_auto_rotate: false,
      det_invert: false,
      det_gamma_correct: false,
      box_threshold: 0.7,
      unclip_ratio: 2.3
    },
    inpainter: {
      inpainter: settings.inpainter,
      inpainting_size: settings.inpaintingSize || 2048,
      inpainting_precision: "bf16"
    },
    render: {
      renderer: settings.renderer,
      alignment: "auto",
      disable_font_border: false,
      font_size_offset: settings.fontSizeOffset || 0,
      font_size_minimum: -1,
      direction: "auto",
      uppercase: false,
      lowercase: false,
      gimp_font: "Sans-serif",
      no_hyphenation: false,
      font_color: null,
      line_spacing: null,
      font_size: null,
      rtl: true
    },
    ocr: {
      use_mocr_merge: false,
      ocr: "48px",
      min_text_length: 0,
      ignore_bubble: 0
    },
    upscale: {
      upscaler: "esrgan",
      revert_upscaling: false,
      upscale_ratio: null
    },
    colorizer: {
      colorization_size: 576,
      denoise_sigma: 30,
      colorizer: "none"
    },
    kernel_size: 3,
    mask_dilation_offset: 20,
    device: 'cuda'
  };
  
  if (settings.displayMode === 'overlay' && settings.overlayMode === 'cleaned') {
    config.render.renderer = 'none';
  }
  
  return config;
}

async function getCachedTranslation(cacheKey) {
  try {
    const result = await browser.storage.local.get('translationCache');
    const cache = result.translationCache || {};
    return cache[cacheKey] || null;
  } catch (error) {
    console.error('Error getting cached translation:', error);
    return null;
  }
}

async function cacheTranslation(cacheKey, result) {
  try {
    const resultStorage = await browser.storage.local.get('translationCache');
    const cache = resultStorage.translationCache || {};
    
    cache[cacheKey] = result;
    
    const cacheKeys = Object.keys(cache);
    if (cacheKeys.length > 100) {
      const keysToRemove = cacheKeys.slice(0, cacheKeys.length - 100);
      keysToRemove.forEach(key => delete cache[key]);
    }
    
    await browser.storage.local.set({ translationCache: cache });
    console.log('Translation cached with key:', cacheKey);
  } catch (error) {
    console.error('Error caching translation:', error);
  }
}

async function handleTranslationWithOOMRetry(imageUrl, tabId, imageElement, isManual = false, retryCount = 0) {
  console.log('OOM Handler called for:', imageUrl, 'Retry count:', retryCount);
  
  try {
    browser.tabs.sendMessage(tabId, {
      action: 'updateProcessIndicator',
      text: 'Translating...'
    }).catch(() => {});
    
    await translateImage(imageUrl, tabId, imageElement, isManual);
    console.log('Translation successful for:', imageUrl);
    
    browser.tabs.sendMessage(tabId, {
      action: 'updateProcessIndicator',
      text: 'Translation completed',
      autoHide: true,
      duration: 2000
    }).catch(() => {});
    
  } catch (error) {
    console.error('Translation error caught by OOM handler:', error);
    
    const errorMessage = error.message || error.toString() || '';
    console.log('Error message:', errorMessage);
    
    if (isConnectionError(errorMessage)) {
      console.log('Connection error detected, canceling translation');
      browser.tabs.sendMessage(tabId, {
        action: 'updateProcessIndicator',
        text: 'Backend connection failed. Check Backend URL or console for details.',
        autoHide: true,
        duration: 5000
      }).catch(() => {});
      throw error;
    }
    
    console.log('Is OOM error:', isOOMError(errorMessage));
    
    if (isOOMError(errorMessage)) {
      const { settings } = await browser.storage.local.get('settings');
      const config = settings || DEFAULT_SETTINGS;
      
      console.log('Auto reduce inpainting setting:', config.autoReduceInpainting);
      
      if (config.autoReduceInpainting && retryCount < 3) {
        const currentSize = config.inpaintingSize || 2048;
        const sizeOptions = [2048, 1536, 1024, 768, 512];
        const currentIndex = sizeOptions.indexOf(currentSize);
        
        console.log('Current inpainting size:', currentSize);
        
        if (currentIndex < sizeOptions.length - 1) {
          const newSize = sizeOptions[currentIndex + 1];
          
          console.log('Reducing inpainting size to:', newSize);
          
          const newSettings = { ...config, inpaintingSize: newSize };
          await browser.storage.local.set({ settings: newSettings });
          
          browser.tabs.sendMessage(tabId, {
            action: 'updateProcessIndicator',
            text: `Out of Memory! Reduced to ${newSize}px. Retrying...`,
            autoHide: false
          }).catch(() => {});
          
          const cacheKey = generateCacheKey(imageUrl, config);
          const resultStorage = await browser.storage.local.get('translationCache');
          const cache = resultStorage.translationCache || {};
          if (cache[cacheKey]) {
            delete cache[cacheKey];
            await browser.storage.local.set({ translationCache: cache });
          }
          
          setTimeout(() => {
            console.log('Retrying translation with new settings...');
            handleTranslationWithOOMRetry(imageUrl, tabId, imageElement, isManual, retryCount + 1);
          }, 1000);
          
          return;
        } else {
          console.log('No more size options to try');
        }
      } else {
        console.log('Auto reduce disabled or max retries reached');
      }
      
      browser.tabs.sendMessage(tabId, {
        action: 'updateProcessIndicator',
        text: 'GPU memory full! Reduce inpainting size in settings. Try: 1536px, 1024px, or 768px',
        autoHide: true,
        duration: 5000
      }).catch(() => {});
    } else {
      console.log('Not an OOM error, showing generic error');
      
      browser.tabs.sendMessage(tabId, {
        action: 'updateProcessIndicator',
        text: `Error: ${errorMessage.substring(0, 100)}`,
        autoHide: true,
        duration: 5000
      }).catch(() => {});
    }
  }
}

async function handleBatchTranslationWithOOMRetry(imageUrls, tabId, retryCount = 0) {
  console.log('Batch OOM Handler called for:', imageUrls.length, 'images. Retry count:', retryCount);
  
  try {
    browser.tabs.sendMessage(tabId, {
      action: 'updateProcessIndicator',
      text: `Translating ${imageUrls.length} images...`
    }).catch(() => {});
    
    await translateBatchImages(imageUrls, tabId);
    console.log('Batch translation successful for:', imageUrls.length, 'images');
    
    browser.tabs.sendMessage(tabId, {
      action: 'updateProcessIndicator',
      text: `Batch completed! Processed ${imageUrls.length} images.`,
      autoHide: true,
      duration: 3000
    }).catch(() => {});
    
  } catch (error) {
    
    const errorMessage = error.message || error.toString() || '';
    
    if (isConnectionError(errorMessage)) {
      console.log('Connection error detected in batch translation, canceling');
      browser.tabs.sendMessage(tabId, {
        action: 'updateProcessIndicator',
        text: 'Backend connection failed. Check Backend URL or console for details.',
        autoHide: true,
        duration: 5000
      }).catch(() => {});
      throw error;
    }
    
    if (isOOMError(errorMessage)) {
      console.error('Batch translation error caught by OOM handler:', errorMessage);
      
      const { settings } = await browser.storage.local.get('settings');
      const config = settings || DEFAULT_SETTINGS;
      
      if (config.autoReduceInpainting && retryCount < 3) {
        const currentSize = config.inpaintingSize || 2048;
        const sizeOptions = [2048, 1536, 1024, 768, 512];
        const currentIndex = sizeOptions.indexOf(currentSize);
        
        if (currentIndex < sizeOptions.length - 1) {
          const newSize = sizeOptions[currentIndex + 1];
          
          console.log('Reducing inpainting size to:', newSize);
          
          const newSettings = { ...config, inpaintingSize: newSize };
          await browser.storage.local.set({ settings: newSettings });
          
          browser.tabs.sendMessage(tabId, {
            action: 'updateProcessIndicator',
            text: `Out of Memory! Reduced to ${newSize}px. Retrying batch...`,
            autoHide: false
          }).catch(() => {});
          
          setTimeout(() => {
            handleBatchTranslationWithOOMRetry(imageUrls, tabId, retryCount + 1);
          }, 1000);
          
          return;
        }
      }
      
      browser.tabs.sendMessage(tabId, {
        action: 'updateProcessIndicator',
        text: 'GPU memory full! Reduce inpainting size in settings. Try: 1536px, 1024px, or 768px',
        autoHide: true,
        duration: 5000
      }).catch(() => {});
    } else {
      browser.tabs.sendMessage(tabId, {
        action: 'updateProcessIndicator',
        text: `Batch error: ${errorMessage.substring(0, 80)}`,
        autoHide: true,
        duration: 5000
      }).catch(() => {});
    }
  } finally {
    isBatchTranslating = false;
  }
}

async function translateBatchImages(imageUrls, tabId) {
  const { settings } = await browser.storage.local.get('settings');
  const config = settings || DEFAULT_SETTINGS;
  
  const batchSize = 4;
  const results = [];
  
  try {
    for (let i = 0; i < imageUrls.length; i += batchSize) {
      const batch = imageUrls.slice(i, i + batchSize);
      const processedCount = Math.min(i + batchSize, imageUrls.length);
      
      browser.tabs.sendMessage(tabId, {
        action: 'updateProcessIndicator',
        text: `Translating ${processedCount}/${imageUrls.length} images...`
      }).catch(() => {});
      
      const batchResults = await translateImageBatch(batch, config);
      results.push(...batchResults);
      
      // Apply results to the page
      batchResults.forEach((result, index) => {
        const originalUrl = batch[index];
        if (result.mode === 'overlay') {
          browser.tabs.sendMessage(tabId, {
            action: 'overlayText',
            textRegions: result.textRegions,
            originalImageUrl: originalUrl,
            cleanedImageUrl: result.cleanedImageUrl
          }).catch(() => {});
        } else if (result.imageUrl) {
          browser.tabs.sendMessage(tabId, {
            action: 'replaceImage',
            imageUrl: result.imageUrl,
            originalImageUrl: originalUrl
          }).catch(() => {});
        }
      });
      
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    browser.tabs.sendMessage(tabId, {
      action: 'updateProcessIndicator',
      text: `Batch completed! Processed ${results.length}/${imageUrls.length} images.`,
      autoHide: true,
      duration: 3000
    }).catch(() => {});
    
  } catch (error) {
    console.error('Error in translateBatchImages:', error);
    throw error;
  }
}

async function translateImageBatch(imageUrls, config) {
  const promises = imageUrls.map(async (imageUrl) => {
    try {
      const cacheKey = generateCacheKey(imageUrl, config);
      if (config.enableCache) {
        const cachedResult = await getCachedTranslation(cacheKey);
        if (cachedResult) {
          console.log('Using cached translation for batch item:', imageUrl);
          return { ...cachedResult, originalUrl: imageUrl };
        }
      }

      const imageBlob = await fetchImage(imageUrl);
      
      if (config.displayMode === 'download') {
        const result = await sendToBackend(imageBlob, config);
        result.mode = 'download';
        
        if (config.enableCache) {
          await cacheTranslation(cacheKey, result);
        }
        
        return { ...result, originalUrl: imageUrl };
      } else if (config.displayMode === 'replace') {
        const result = await sendToBackend(imageBlob, config);
        result.mode = 'replace';
        
        if (config.enableCache) {
          await cacheTranslation(cacheKey, result);
        }
        
        return { ...result, originalUrl: imageUrl };
      } else if (config.displayMode === 'overlay') {
        const jsonResult = await sendToBackendJson(imageBlob, config);
        
        if (jsonResult && jsonResult.translations && jsonResult.translations.length > 0) {
          const textRegions = convertTranslationsToTextRegions(jsonResult.translations, config.targetLang);
          
          let cleanedImageUrl = null;
          if (config.overlayMode === 'cleaned') {
            const cleanedResult = await sendToBackend(imageBlob, config);
            cleanedImageUrl = cleanedResult.imageUrl;
          }
          
          const result = { textRegions, cleanedImageUrl, mode: 'overlay' };
          
          if (config.enableCache) {
            await cacheTranslation(cacheKey, result);
          }
          
          return { textRegions, cleanedImageUrl, mode: 'overlay', originalUrl: imageUrl };
        }
      }
      
      return { mode: 'no_text', originalUrl: imageUrl };
    } catch (error) {
      console.error('Error processing image in batch:', imageUrl, error);
      // Rethrow connection errors to stop batch
      const errorMessage = error.message || error.toString() || '';
      if (isConnectionError(errorMessage)) {
        throw error;
      }
      return { mode: 'error', originalUrl: imageUrl, error: error.message };
    }
  });
  
  return Promise.all(promises);
}

async function translateImage(imageUrl, tabId, imageElement, isManual = false) {
  if (activeTranslations.has(imageUrl)) {
    console.log('Image already being processed:', imageUrl);
    if (isManual) {
      browser.tabs.sendMessage(tabId, {
        action: 'updateProcessIndicator',
        text: 'Translation in progress, please wait...',
        autoHide: true,
        duration: 2000
      }).catch(() => {});
    }
    return;
  }

  activeTranslations.set(imageUrl, { tabId, imageElement, startTime: Date.now() });

  try {
    const { settings } = await browser.storage.local.get('settings');
    const config = settings || DEFAULT_SETTINGS;
    
    const cacheKey = generateCacheKey(imageUrl, config);
    
    if (config.enableCache) {
      const cachedResult = await getCachedTranslation(cacheKey);
      if (cachedResult) {
        console.log('Using cached translation for:', imageUrl);
        applyCachedResult(cachedResult, imageElement, tabId, imageUrl);
        activeTranslations.delete(imageUrl);
        return;
      }
    }
    
    if (isManual) {
      browser.tabs.sendMessage(tabId, {
        action: 'updateProcessIndicator',
        text: 'Processing image...'
      }).catch(() => {});
    }
    
    const imageBlob = await fetchImage(imageUrl);
    
    let result;
    if (config.displayMode === 'download') {
      result = await sendToBackend(imageBlob, config);
      result.mode = 'download';
      displayResultInNewTab(result.imageUrl, tabId);
    } else if (config.displayMode === 'replace') {
      result = await sendToBackend(imageBlob, config);
      result.mode = 'replace';
      replaceImageInPage(result.imageUrl, imageElement, tabId, imageUrl);
    } else if (config.displayMode === 'overlay') {
      try {
        const jsonResult = await sendToBackendJson(imageBlob, config);
        
        if (jsonResult && jsonResult.translations && jsonResult.translations.length > 0) {
          const textRegions = convertTranslationsToTextRegions(jsonResult.translations, config.targetLang);
          
          let cleanedImageUrl = null;
          if (config.overlayMode === 'cleaned') {
            const cleanedResult = await sendToBackend(imageBlob, config);
            cleanedImageUrl = cleanedResult.imageUrl;
            replaceImageInPage(cleanedImageUrl, imageElement, tabId, imageUrl);
          }
          
          result = { textRegions, cleanedImageUrl, mode: 'overlay' };
          overlayTextOnImage(textRegions, imageElement, tabId, imageUrl, cleanedImageUrl);
        } else {
          console.warn(`No text regions found in image: ${imageUrl}`);
          result = { mode: 'no_text', error: 'No text regions found' };
          
          browser.tabs.sendMessage(tabId, {
            action: 'markImageProcessed',
            imageElement: imageElement,
            originalImageUrl: imageUrl,
            status: 'error',
            error: 'No text regions found'
          }).catch(() => {});
        }
      } catch (jsonError) {
        console.error(`JSON request failed for ${imageUrl}:`, jsonError);
        throw jsonError;
      }
    }
    
    if (config.enableCache && result && result.mode !== 'no_text' && result.mode !== 'error') {
      await cacheTranslation(cacheKey, result);
    }
    
    if (isManual && result.mode !== 'no_text' && result.mode !== 'error') {
      browser.tabs.sendMessage(tabId, {
        action: 'updateProcessIndicator',
        text: 'Translation completed!',
        autoHide: true,
        duration: 2000
      }).catch(() => {});
    }
    
  } catch (error) {
    console.error('Translation error:', error);
    throw error;
  } finally {
    activeTranslations.delete(imageUrl);
  }
}

function applyCachedResult(cachedResult, imageElement, tabId, originalImageUrl) {
  console.log('Applying cached result for:', originalImageUrl);
  
  if (cachedResult.imageUrl) {
    if (cachedResult.mode === 'download') {
      displayResultInNewTab(cachedResult.imageUrl, tabId);
    } else {
      replaceImageInPage(cachedResult.imageUrl, imageElement, tabId, originalImageUrl);
    }
  } else if (cachedResult.textRegions) {
    overlayTextOnImage(cachedResult.textRegions, imageElement, tabId, originalImageUrl, cachedResult.cleanedImageUrl);
  }
}

function convertTranslationsToTextRegions(translations, targetLang) {
  return translations.map(translation => {
    const width = translation.maxX - translation.minX;
    const height = translation.maxY - translation.minY;
    const translatedText = translation.text[targetLang] || translation.text[Object.keys(translation.text)[0]] || '';
    
    const fgColor = translation.text_color?.fg || [0, 0, 0];
    const bgColor = translation.text_color?.bg || [255, 255, 255];
    
    return {
      x: translation.minX,
      y: translation.minY,
      width: width,
      height: height,
      img_width: translation.maxX,
      img_height: translation.maxY,
      translated_text: translatedText,
      text: translation.text[Object.keys(translation.text)[0]] || '',
      fg_color: `rgb(${fgColor.join(',')})`,
      bg_color: `rgb(${bgColor.join(',')})`,
      font_size: translation.font_size || Math.max(12, Math.min(24, height / 2)),
      bold: translation.bold || false,
      prob: translation.prob,
      angle: translation.angle
    };
  });
}

async function fetchImage(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
    }
    return await response.blob();
  } catch (error) {
    console.error('Fetch image error:', error);
    throw error;
  }
}

async function sendToBackend(imageBlob, config) {
  try {
    const base64Image = await blobToBase64(imageBlob);
    const payload = {
      image: base64Image,
      config: createConfig(config)
    };
    
    const url = `${config.backendUrl}/translate/image`;
    
    console.log('Sending request to backend:', url);
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.warn(`Backend error: ${response.status} - ${errorText}`);
      throw new Error(`Backend error: ${response.status} - ${errorText}`);
    }
    
    const resultBlob = await response.blob();
    const imageUrl = URL.createObjectURL(resultBlob);
    
    return { imageUrl, textRegions: [] };
  } catch (error) {
    console.error('Backend request error:', error);
    throw error;
  }
}

async function sendToBackendJson(imageBlob, config) {
  try {
    const base64Image = await blobToBase64(imageBlob);
    const payload = {
      image: base64Image,
      config: createConfig(config)
    };
    
    const url = `${config.backendUrl}/translate/json`;
    
    console.log('Sending JSON request to backend:', url);
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.warn(`Backend JSON request error: ${response.status} - ${errorText}`);
      throw new Error(`Backend JSON request error: ${response.status} - ${errorText}`);
    }
    
    const result = await response.json();
    
    if (!result) {
      console.warn('Invalid JSON response from backend - null result');
      throw new Error('Invalid JSON response from backend - null result');
    }
    
    if (!result.translations) {
      console.warn('No translations found in backend response');
      return { translations: [] };
    }
    
    return result;
  } catch (error) {
    console.error('Backend JSON request error:', error);
    throw error;
  }
}

function base64ToBlob(base64) {
  const byteString = atob(base64.split(',')[1]);
  const mimeString = base64.split(',')[0].split(':')[1].split(';')[0];
  const ab = new ArrayBuffer(byteString.length);
  const ia = new Uint8Array(ab);
  
  for (let i = 0; i < byteString.length; i++) {
    ia[i] = byteString.charCodeAt(i);
  }
  
  return new Blob([ab], { type: mimeString });
}

function displayResultInNewTab(imageUrl, tabId) {
  browser.tabs.create({
    url: browser.runtime.getURL('result.html') + '?image=' + encodeURIComponent(imageUrl)
  });
}

function replaceImageInPage(imageUrl, imageElement, tabId, originalImageUrl) {
  browser.tabs.sendMessage(tabId, {
    action: 'replaceImage',
    imageUrl: imageUrl,
    imageElement: imageElement,
    originalImageUrl: originalImageUrl
  });
}

function overlayTextOnImage(textRegions, imageElement, tabId, originalImageUrl, cleanedImageUrl = null) {
  browser.tabs.sendMessage(tabId, {
    action: 'overlayText',
    textRegions: textRegions,
    imageElement: imageElement,
    originalImageUrl: originalImageUrl,
    cleanedImageUrl: cleanedImageUrl
  });
}

// Handle storage changes
browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.settings) {
    // Notify all tabs about settings changes
    browser.tabs.query({}).then(tabs => {
      tabs.forEach(tab => {
        browser.tabs.sendMessage(tab.id, {
          action: 'reloadSettings',
          settings: changes.settings.newValue
        }).catch(() => {
          // Ignore errors for tabs that don't have content script loaded
        });
      });
    });
  }
});