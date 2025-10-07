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
  
  // Create context menu
  try {
    if(browser.contextMenus){
      await browser.contextMenus.create({
        id: "translate-image",
        title: "Translate Image",
        contexts: ["image"]
      });
    }
  } catch (error) {
    console.error('Error creating context menu:', error);
  }
});


// Handle context menu clicks
if(browser.contextMenus){
  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "translate-image") {
      handleTranslationWithOOMRetry(info.srcUrl, tab.id, null, true);
    }
  });
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
      action: 'hideProcessIndicator'
    }).catch(() => {});
    
  } catch (error) {
    console.error('Translation error caught by OOM handler:', error);
    
    browser.tabs.sendMessage(tabId, {
      action: 'hideProcessIndicator'
    }).catch(() => {});
    
    const errorMessage = error.message || error.toString() || '';
    console.log('Error message:', errorMessage);
    
    const isOomError = errorMessage.includes('out of memory') || 
                        errorMessage.includes('CUDA out of memory') ||
                        errorMessage.includes('OOM') ||
                        errorMessage.includes('allocate') ||
                        errorMessage.includes('memory') ||
                        errorMessage.includes('Backend error: 500');
    
    console.log('Is OOM error:', isOomError);
    
    if (isOomError) {
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
          
          browser.notifications.create({
            type: 'basic',
            iconUrl: 'icons/icon-48.png',
            title: 'Comic Translator - Memory Optimized',
            message: `Out of Memory! Reduced inpainting size to ${newSize}px. Retrying...`
          });
          
          const cacheKey = generateCacheKey(imageUrl, config);
          const resultStorage = await browser.storage.local.get('translationCache');
          const cache = resultStorage.translationCache || {};
          if (cache[cacheKey]) {
            delete cache[cacheKey];
            await browser.storage.local.set({ translationCache: cache });
          }
          
          browser.tabs.sendMessage(tabId, {
            action: 'updateProcessIndicator',
            text: `Retrying with ${newSize}px...`
          }).catch(() => {});
          
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
      
      browser.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon-48.png',
        title: 'Comic Translator - Out of Memory',
        message: `GPU memory full! Please reduce inpainting size in settings.\nTry: 1536px, 1024px, or 768px`
      });
    } else {
      console.log('Not an OOM error, showing generic error');
      
      browser.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon-48.png',
        title: 'Comic Translator Error',
        message: `Error: ${errorMessage.substring(0, 100)}`
      });
    }
  }
}

async function translateImage(imageUrl, tabId, imageElement, isManual = false) {
  if (activeTranslations.has(imageUrl)) {
    console.log('Image already being processed:', imageUrl);
    if (isManual) {
      browser.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon-48.png',
        title: 'Comic Translator',
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
      browser.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon-48.png',
        title: 'Comic Translator',
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
        console.error(`JSON request failed for ${imageUrl}:`, jsonError);
        throw jsonError;
      }
    }
    
    if (config.enableCache && result && result.mode !== 'no_text' && result.mode !== 'error') {
      await cacheTranslation(cacheKey, result);
    }
    
    if (isManual && result.mode !== 'no_text' && result.mode !== 'error') {
      browser.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon-48.png',
        title: 'Comic Translator',
        message: 'Translation completed!'
      });
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