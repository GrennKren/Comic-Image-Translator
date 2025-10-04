// Background script for Manga Image Translator Extension

// Default settings for the extension
const DEFAULT_SETTINGS = {
  backendUrl: 'http://127.0.0.1:8000',
  translator: 'sugoi',
  targetLang: 'ENG',
  detector: 'default',
  inpainter: 'lama_large',
  renderer: 'manga2eng',
  displayMode: 'overlay',
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

let activeTranslations = new Map(); 
let translationQueue = []; 
let isProcessingQueue = false;

// Initialize extension when installed
browser.runtime.onInstalled.addListener(() => {
  // Set default settings if not exist
  browser.storage.local.get('settings').then(result => {
    if (!result.settings) {
      browser.storage.local.set({ settings: DEFAULT_SETTINGS });
    }
  });
  
  // Create context menu items only if API is available (not on Android)
  if (typeof browser.contextMenus !== 'undefined') {
    try {
      createContextMenus();
    } catch (e) {
      console.log('Context menus not supported on this platform');
    }
  }
});

// Create context menu items for translation
function createContextMenus() {
  try {
    // Single image translation menu
    browser.contextMenus.create({
      id: "translate-image",
      title: "Translate Manga Image",
      contexts: ["image"]
    });
    
    // Batch translation menu
    browser.contextMenus.create({
      id: "translate-batch-selector",
      title: "Translate Images with CSS Selector...",
      contexts: ["page", "selection", "link"]
    });
    
    // Setup click listener only if create succeeded
    browser.contextMenus.onClicked.addListener((info, tab) => {
      if (info.menuItemId === "translate-image") {
        translateImage(info.srcUrl, tab.id, null, true);
      } else if (info.menuItemId === "translate-batch-selector") {
        browser.tabs.sendMessage(tab.id, {
          action: 'showBatchSelectorDialog'
        }).catch(() => {
          browser.tabs.executeScript(tab.id, {
            file: 'content.js'
          }).then(() => {
            browser.tabs.sendMessage(tab.id, {
              action: 'showBatchSelectorDialog'
            });
          });
        });
      }
    });
  } catch (e) {
    console.log('Failed to setup context menus:', e);
  }
}

// Listen for messages from content script
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'translateImage') {
    // Handle single image translation request
    translateImage(message.imageUrl, sender.tab.id, message.imageElement, false);
    return true;
  }
  
  if (message.action === 'translateBatch') {
    // Handle batch translation request
    translateBatch(message.images, sender.tab.id);
    return true;
  }
  
  if (message.action === 'translateBatchWithSelector') {
    // Handle batch translation with selector
    translateBatchWithSelector(message.selector, sender.tab.id);
    return true;
  }
  
  if (message.action === 'getSettings') {
    // Return current settings
    browser.storage.local.get('settings').then(result => {
      sendResponse({ settings: result.settings || DEFAULT_SETTINGS });
    });
    return true;
  }

  
  if (message.action === 'applyCacheOnly') {
    // Apply cache if exists, don't block, don't wait
    applyCacheIfExists(message.imageUrl, message.imageElement, sender.tab.id);
    sendResponse({ success: true });
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

// Convert blob to base64 string
async function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Generate unique cache key based on image URL and settings
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

// Create configuration object for backend API
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
      inpainting_size: 2048,
      inpainting_precision: "bf16"
    },
    render: {
      renderer: settings.renderer,
      alignment: "auto",
      disable_font_border: false,
      font_size_offset: 0,
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
    device: 'cpu'
  };
  
  // Special handling for overlay mode
  if (settings.displayMode === 'overlay' && settings.overlayMode === 'cleaned') {
    config.render.renderer = 'none';
  }
  
  return config;
}

// Get cached translation from storage
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

// Cache translation result in storage
async function cacheTranslation(cacheKey, result) {
  try {
    const resultStorage = await browser.storage.local.get('translationCache');
    const cache = resultStorage.translationCache || {};
    
    // Add to cache
    cache[cacheKey] = result;
    
    // Limit cache size to 100 entries
    const cacheKeys = Object.keys(cache);
    if (cacheKeys.length > 100) {
      // Remove oldest entries
      const keysToRemove = cacheKeys.slice(0, cacheKeys.length - 100);
      keysToRemove.forEach(key => delete cache[key]);
    }
    
    await browser.storage.local.set({ translationCache: cache });
    console.log('Translation cached with key:', cacheKey);
  } catch (error) {
    console.error('Error caching translation:', error);
  }
}

// Main translation function with improved error handling
async function translateImage(imageUrl, tabId, imageElement, isManual = false) {
  // Check if already processing
  if (activeTranslations.has(imageUrl)) {
    console.log('Image already being processed:', imageUrl);
    if (isManual) {
      browser.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon-48.png',
        title: 'Manga Translator',
        message: 'Translation in progress, please wait...'
      });
    }
    return;
  }

  activeTranslations.set(imageUrl, { tabId, imageElement, startTime: Date.now() });

  try {
    const { settings } = await browser.storage.local.get('settings');
    const config = settings || DEFAULT_SETTINGS;
    
    const cacheKey = generateCacheKey(imageUrl, config);
    
    // Check cache FIRST
    if (config.enableCache) {
      const cachedResult = await getCachedTranslation(cacheKey);
      if (cachedResult) {
        console.log('Using cached translation for:', imageUrl);
        applyCachedResult(cachedResult, imageElement, tabId, imageUrl);
        activeTranslations.delete(imageUrl);
        return;
      }
    }
    
    // No cache, proceed with translation
    if (isManual) {
      browser.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon-48.png',
        title: 'Manga Translator',
        message: 'Processing image...'
      });
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
        console.error(`JSON request failed for ${imageUrl}:`, jsonError.message);
        result = { mode: 'error', error: jsonError.message };
        
        browser.tabs.sendMessage(tabId, {
          action: 'markImageProcessed',
          imageElement: imageElement,
          originalImageUrl: imageUrl,
          status: 'error',
          error: jsonError.message
        }).catch(() => {});
      }
    }
    
    // Cache result if successful
    if (config.enableCache && result && result.mode !== 'no_text' && result.mode !== 'error') {
      await cacheTranslation(cacheKey, result);
    }
    
    if (isManual && result.mode !== 'no_text' && result.mode !== 'error') {
      browser.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon-48.png',
        title: 'Manga Translator',
        message: 'Translation completed!'
      });
    }
    
  } catch (error) {
    console.error('Translation error:', error);
    
    browser.tabs.sendMessage(tabId, {
      action: 'markImageProcessed',
      imageElement: imageElement,
      originalImageUrl: imageUrl,
      status: 'error',
      error: error.message
    }).catch(() => {});
    
    if (isManual) {
      browser.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon-48.png',
        title: 'Manga Translator Error',
        message: `Error: ${error.message}`
      });
    }
  } finally {
    activeTranslations.delete(imageUrl);
  }
}

// Apply cached translation result
function applyCachedResult(cachedResult, imageElement, tabId, originalImageUrl) {
  console.log('Applying cached result for:', originalImageUrl);
  
  if (cachedResult.imageUrl) {
    // Handle replace/download mode result
    if (cachedResult.mode === 'download') {
      displayResultInNewTab(cachedResult.imageUrl, tabId);
    } else {
      replaceImageInPage(cachedResult.imageUrl, imageElement, tabId, originalImageUrl);
    }
  } else if (cachedResult.textRegions) {
    // Handle overlay mode result
    overlayTextOnImage(cachedResult.textRegions, imageElement, tabId, originalImageUrl, cachedResult.cleanedImageUrl);
  }
}

// Convert backend translations to text regions format
function convertTranslationsToTextRegions(translations, targetLang) {
  return translations.map(translation => {
    const width = translation.maxX - translation.minX;
    const height = translation.maxY - translation.minY;
    const translatedText = translation.text[targetLang] || translation.text[Object.keys(translation.text)[0]] || '';
    
    // Parse color information from backend
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
      font_size: Math.max(12, Math.min(24, height / 2)),
      bold: false,
      prob: translation.prob,
      angle: translation.angle
    };
  });
}

// Fetch image from URL
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

// Send image to backend for translation
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

// Send request to get JSON response with text regions
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
    
    // Check if result is valid
    if (!result) {
      console.warn('Invalid JSON response from backend - null result');
      throw new Error('Invalid JSON response from backend - null result');
    }
    
    // Handle case where text_regions is null or undefined
    if (!result.translations) {
      console.warn('No translations found in backend response');
      return { translations: [] }; // Return empty translations instead of throwing
    }
    
    return result;
  } catch (error) {
    console.error('Backend JSON request error:', error);
    throw error;
  }
}

// Convert base64 to blob
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

// Display result in new tab
function displayResultInNewTab(imageUrl, tabId) {
  browser.tabs.create({
    url: browser.runtime.getURL('result.html') + '?image=' + encodeURIComponent(imageUrl)
  });
}

// Replace image in page
function replaceImageInPage(imageUrl, imageElement, tabId, originalImageUrl) {
  browser.tabs.sendMessage(tabId, {
    action: 'replaceImage',
    imageUrl: imageUrl,
    imageElement: imageElement,
    originalImageUrl: originalImageUrl
  });
}

// Overlay text on image
function overlayTextOnImage(textRegions, imageElement, tabId, originalImageUrl, cleanedImageUrl = null) {
  browser.tabs.sendMessage(tabId, {
    action: 'overlayText',
    textRegions: textRegions,
    imageElement: imageElement,
    originalImageUrl: originalImageUrl,
    cleanedImageUrl: cleanedImageUrl
  });
}

// Batch translation with selector
async function translateBatchWithSelector(selector, tabId) {
  try {
    console.log('Starting batch translation with selector:', selector);
    
    // Get images from the page
    const images = await browser.tabs.executeScript(tabId, {
      code: `
        Array.from(document.querySelectorAll('${selector}'))
          .filter(img => img.src && img.src.startsWith('http'))
          .filter(img => img.naturalWidth > 100 && img.naturalHeight > 100)
          .filter(img => img.dataset.miProcessed !== 'true') // Use new processed attribute
          .map(img => ({
            src: img.src,
            processed: img.dataset.miProcessed === 'true'
          }))
      `
    });
    
    if (!images || images.length === 0) {
      browser.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon-48.png',
        title: 'Manga Translator',
        message: 'No images found with the specified selector'
      });
      return;
    }
    
    console.log(`Found ${images.length} images with selector: ${selector}`);
    
    // Get settings
    const { settings } = await browser.storage.local.get('settings');
    const config = settings || DEFAULT_SETTINGS;
    
    // Filter out already processed images if skip is enabled
    const imagesToTranslate = settings.skipProcessed 
      ? images.filter(img => !img.processed)
      : images;
    
    if (imagesToTranslate.length === 0) {
      browser.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon-48.png',
        title: 'Manga Translator',
        message: 'All images are already processed'
      });
      return;
    }
    
    // Start batch translation
    browser.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon-48.png',
      title: 'Manga Translator',
      message: `Translating ${imagesToTranslate.length} images...`
    });
    
    let completed = 0;
    for (const imgData of imagesToTranslate) {
      try {
        console.log('Translating image:', imgData.src);
        const elementInfo = { src: imgData.src };
        
        if (config.displayMode === 'replace') {
          const result = await sendToBackend(await fetchImage(imgData.src), config);
          result.mode = 'replace';
          replaceImageInPage(result.imageUrl, elementInfo, tabId, imgData.src);
        } else if (config.displayMode === 'overlay') {
          try {
            const imageBlob = await fetchImage(imgData.src);
            const jsonResult = await sendToBackendJson(imageBlob, config);
            
            if (jsonResult && jsonResult.translations && jsonResult.translations.length > 0) {
              const textRegions = convertTranslationsToTextRegions(jsonResult.translations, config.targetLang);
              
              let cleanedImageUrl = null;
              if (config.overlayMode === 'cleaned') {
                const cleanedResult = await sendToBackend(imageBlob, config);
                cleanedImageUrl = cleanedResult.imageUrl;
                replaceImageInPage(cleanedImageUrl, elementInfo, tabId, imgData.src);
              }
              
              const result = { textRegions, cleanedImageUrl, mode: 'overlay' };
              overlayTextOnImage(textRegions, elementInfo, tabId, imgData.src, cleanedImageUrl);
            } else {
              console.warn(`No text regions found in image: ${imgData.src}`);
              browser.tabs.sendMessage(tabId, {
                action: 'markImageProcessed',
                imageElement: elementInfo,
                originalImageUrl: imgData.src,
                status: 'error',
                error: 'No text regions found'
              }).catch(() => {});
            }
          } catch (e) {
            
            console.error(`Translation failed for ${imgData.src}:`, e.message);
            browser.tabs.sendMessage(tabId, {
              action: 'markImageProcessed',
              imageElement: elementInfo,
              originalImageUrl: imgData.src,
              status: 'error',
              error: e.message
            }).catch(() => {});
          }
        } else {
          const result = await sendToBackend(await fetchImage(imgData.src), config);
          result.mode = 'download';
          displayResultInNewTab(result.imageUrl, tabId);
        }
        
        completed++;
        
        if (completed % 5 === 0 || completed === imagesToTranslate.length) {
          browser.notifications.create({
            type: 'basic',
            iconUrl: 'icons/icon-48.png',
            title: 'Manga Translator',
            message: `Progress: ${completed}/${imagesToTranslate.length} images`
          });
        }
      } catch (error) {
        console.error(`Error translating image ${imgData.src}:`, error.message);
        // Mark as processed with error
        browser.tabs.sendMessage(tabId, {
          action: 'markImageProcessed',
          imageElement: { src: imgData.src },
          originalImageUrl: imgData.src,
          status: 'error',
          error: error.message
        }).catch(() => {
          // Ignore if content script not available
        });
      }
    }
    
    browser.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon-48.png',
      title: 'Manga Translator',
      message: `Batch translation completed! (${completed}/${imagesToTranslate.length})`
    });
    
  } catch (error) {
    console.error('Batch translation error:', error);
    browser.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon-48.png',
      title: 'Manga Translator Error',
      message: `Error: ${error.message}`
    });
  }
}

// Batch translation (existing function)
async function translateBatch(images, tabId) {
  const { settings } = await browser.storage.local.get('settings');
  const config = settings || DEFAULT_SETTINGS;
  
  browser.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon-48.png',
    title: 'Manga Translator',
    message: `Translating ${images.length} images...`
  });
  
  let completed = 0;
  for (const imgData of images) {
    try {
      if (config.displayMode === 'replace') {
        const result = await sendToBackend(await fetchImage(imgData.url), config);
        result.mode = 'replace';
        replaceImageInPage(result.imageUrl, imgData.element, tabId, imgData.url);
      } else if (config.displayMode === 'overlay') {
        try {
          const imageBlob = await fetchImage(imgData.url);
          const jsonResult = await sendToBackendJson(imageBlob, config);
          
          if (jsonResult && jsonResult.translations && jsonResult.translations.length > 0) {
            const textRegions = convertTranslationsToTextRegions(jsonResult.translations, config.targetLang);
            
            let cleanedImageUrl = null;
            if (config.overlayMode === 'cleaned') {
              const cleanedResult = await sendToBackend(imageBlob, config);
              cleanedImageUrl = cleanedResult.imageUrl;
              replaceImageInPage(cleanedImageUrl, imgData.element, tabId, imgData.url);
            }
            
            const result = { textRegions, cleanedImageUrl, mode: 'overlay' };
            overlayTextOnImage(textRegions, imgData.element, tabId, imgData.url, cleanedImageUrl);
          } else {
            console.warn(`No text regions found in image: ${imgData.url}`);
            // Mark as processed with no text error
            browser.tabs.sendMessage(tabId, {
              action: 'markImageProcessed',
              imageElement: imgData.element,
              originalImageUrl: imgData.url,
              status: 'error',
              error: 'No text regions found'
            }).catch(() => {
              // Ignore if content script not available
            });
          }
        } catch (e) {
          console.warn(`JSON request failed for ${imgData.url}, falling back to image mode:`, e.message);
          const result = await sendToBackend(await fetchImage(imgData.url), config);
          result.mode = 'replace';
          replaceImageInPage(result.imageUrl, imgData.element, tabId, imgData.url);
        }
      } else {
        const result = await sendToBackend(await fetchImage(imgData.url), config);
        result.mode = 'download';
        displayResultInNewTab(result.imageUrl, tabId);
      }
      
      completed++;
      
      if (completed % 5 === 0 || completed === images.length) {
        browser.notifications.create({
          type: 'basic',
          iconUrl: 'icons/icon-48.png',
          title: 'Manga Translator',
          message: `Progress: ${completed}/${images.length} images`
        });
      }
    } catch (error) {
      console.error(`Error translating image ${imgData.url}:`, error.message);
      // Mark as processed with error
      browser.tabs.sendMessage(tabId, {
        action: 'markImageProcessed',
        imageElement: imgData.element,
        originalImageUrl: imgData.url,
        status: 'error',
        error: error.message
      }).catch(() => {
        // Ignore if content script not available
      });
    }
  }
  
  browser.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon-48.png',
    title: 'Manga Translator',
    message: `Batch translation completed! (${completed}/${images.length})`
  });
}