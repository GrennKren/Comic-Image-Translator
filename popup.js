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

// Load settings on popup open
// Update the DOMContentLoaded event listener in popup.js to ensure all elements exist before adding listeners
document.addEventListener('DOMContentLoaded', function() {
  // Ensure polyfill is loaded before using browser API
  if (typeof browser === 'undefined') {
    console.error('Browser polyfill not loaded in popup');
    showStatus('Error: Browser API not available', 'error');
    return;
  }
  
  // Open Basic Settings by default
  const basicSettings = document.querySelector('.collapsible');
  if (basicSettings) {
    const content = basicSettings.querySelector('.collapsible-content');
    const arrow = basicSettings.querySelector('.collapsible-arrow');
    
    if (content && arrow) {
      content.classList.add('open');
      arrow.classList.add('open');
    }
  }
  
  // Add click listeners to all collapsible headers
  const headers = document.querySelectorAll('.collapsible-header');
  headers.forEach(header => {
    header.addEventListener('click', function() {
      toggleCollapsible(this);
    });
  });
  
  // Wait a tick for collapsible to render, then add button listeners
  setTimeout(() => {
    // Manage Selectors button handler
    const manageSelectorsBtn = document.getElementById('manageSelectorsBtn');
    if (manageSelectorsBtn) {
      manageSelectorsBtn.addEventListener('click', async function() {
        const selectorsUrl = browser.runtime.getURL('selectors.html');
        
        if (await isPopup()) {
          // Desktop popup: open selectors in new tab and close popup
          await openOrSwitchToTab(selectorsUrl);
          window.close();
        } else {
          // Mobile tab: replace current page
          window.location.href = selectorsUrl;
        }
      });
    } else {
      console.warn('manageSelectorsBtn not found');
    }

    // Configuration button handler
    const configBtn = document.getElementById('configBtn');
    if (configBtn) {
      configBtn.addEventListener('click', async function() {
        const configUrl = browser.runtime.getURL('configuration.html');
        const popupCheck = await isPopup();
        
        console.log('Is popup?', popupCheck); // Debug
        
        if (popupCheck) {
          await openOrSwitchToTab(configUrl);
          window.close();
        } else {
          window.location.href = configUrl;
        }
      });
    } else {
      console.warn('configBtn not found');
    }

    // Save button handler
    const saveBtn = document.getElementById('saveBtn');
    if (saveBtn) {
      saveBtn.addEventListener('click', saveSettings);
    } else {
      console.warn('saveBtn not found');
    }

    // Reset button handler
    const resetBtn = document.getElementById('resetBtn');
    if (resetBtn) {
      resetBtn.addEventListener('click', resetSettings);
    } else {
      console.warn('resetBtn not found');
    }

    // Clear cache button handler
    const clearCacheBtn = document.getElementById('clearCache');
    if (clearCacheBtn) {
      clearCacheBtn.addEventListener('click', clearCache);
    } else {
      console.warn('clearCache not found');
    }

    // Display mode change handler
    const displayMode = document.getElementById('displayMode');
    if (displayMode) {
      displayMode.addEventListener('change', function() {
        const overlaySettings = document.getElementById('overlaySettings');
        if (this.value === 'overlay') {
          overlaySettings.style.display = 'block';
        } else {
          overlaySettings.style.display = 'none';
        }
      });
    }

    // Enable batch mode change handler
    const enableBatchMode = document.getElementById('enableBatchMode');
    if (enableBatchMode) {
      enableBatchMode.addEventListener('change', function() {
        if (this.checked) {
          browser.tabs.query({active: true, currentWindow: true}).then(tabs => {
            browser.tabs.sendMessage(tabs[0].id, {
              action: 'startAutoTranslate'
            }).catch(() => {});
          });
        } else {
          browser.tabs.query({active: true, currentWindow: true}).then(tabs => {
            browser.tabs.sendMessage(tabs[0].id, {
              action: 'stopAutoTranslate'
            }).catch(() => {});
          });
        }
        
        updateAutoTranslateStatus();
      });
    }

    // Add event listeners for overlay options
    const overlayTextColor = document.getElementById('overlayTextColor');
    if (overlayTextColor) {
      overlayTextColor.addEventListener('change', function() {
        const customColorGroup = document.getElementById('customColorGroup');
        if (this.value === 'custom') {
          customColorGroup.style.display = 'block';
        } else {
          customColorGroup.style.display = 'none';
        }
      });
    }

    // Font size offset change handler
    const fontSizeOffset = document.getElementById('fontSizeOffset');
    if (fontSizeOffset) {
      fontSizeOffset.addEventListener('change', function() {
        const value = this.value;
        const info = document.querySelector('label[for="fontSizeOffset"]').nextElementSibling;
        if (value > 0) {
          info.textContent = `Font size increased by ${value} pixels`;
        } else if (value < 0) {
          info.textContent = `Font size decreased by ${Math.abs(value)} pixels`;
        } else {
          info.textContent = 'Default font size';
        }
      });
    }

    // Opacity range handler
    const opacityRange = document.getElementById('overlayOpacity');
    if (opacityRange) {
      opacityRange.addEventListener('input', function() {
        document.getElementById('opacityValue').textContent = this.value + '%';
      });
    }
  }, 0); // Use setTimeout with 0 delay to queue after current DOM mutations
  
  loadSettings(); // Call loadSettings after setup
});

// Update auto-translate status display
function updateAutoTranslateStatus() {
  const statusElement = document.getElementById('autoTranslateStatus');
  const isEnabled = document.getElementById('enableBatchMode').checked;
  
  if (isEnabled) {
    statusElement.textContent = 'Status: Active';
    statusElement.style.color = '#28a745';
  } else {
    statusElement.textContent = 'Status: Disabled';
    statusElement.style.color = '#6c757d';
  }
}

// Load settings from storage
async function loadSettings() {
  try {
    const result = await browser.storage.local.get('settings');
    settings = result.settings || DEFAULT_SETTINGS;
    
    if (!settings.selectorRules) {
      settings.selectorRules = DEFAULT_SETTINGS.selectorRules;
    }
    
    document.getElementById('backendUrl').value = settings.backendUrl;
    document.getElementById('displayMode').value = settings.displayMode;
    document.getElementById('enableBatchMode').checked = settings.enableBatchMode;
    document.getElementById('translator').value = settings.translator;
    document.getElementById('targetLang').value = settings.targetLang;
    document.getElementById('detector').value = settings.detector;
    document.getElementById('inpainter').value = settings.inpainter;
    document.getElementById('renderer').value = settings.renderer;
    
    document.getElementById('overlayMode').value = settings.overlayMode;
    document.getElementById('overlayOpacity').value = settings.overlayOpacity;
    document.getElementById('overlayTextColor').value = settings.overlayTextColor;
    document.getElementById('customTextColor').value = settings.customTextColor;
    document.getElementById('draggableOverlay').checked = settings.draggableOverlay;
    
    document.getElementById('fontSizeOffset').value = settings.fontSizeOffset || 0;
    
    document.getElementById('enableCache').checked = settings.enableCache;
    document.getElementById('skipProcessed').checked = settings.skipProcessed;
    document.getElementById('observeDynamicImages').checked = settings.observeDynamicImages;
    
    document.getElementById('inpaintingSize').value = settings.inpaintingSize || 2048;
    document.getElementById('autoReduceInpainting').checked = settings.autoReduceInpainting !== false;
    document.getElementById('showProcessIndicator').checked = settings.showProcessIndicator !== false;
    
    const overlaySettings = document.getElementById('overlaySettings');
    if (settings.displayMode === 'overlay') {
      overlaySettings.style.display = 'block';
    } else {
      overlaySettings.style.display = 'none';
    }
    
    const customColorGroup = document.getElementById('customColorGroup');
    if (settings.overlayTextColor === 'custom') {
      customColorGroup.style.display = 'block';
    } else {
      customColorGroup.style.display = 'none';
    }
    
    updateCacheInfo();
    updateAutoTranslateStatus();
  } catch (error) {
    showStatus('Error loading settings', 'error');
    console.error('Load settings error:', error);
  }
}

async function saveSettings() {
  try {
    const settings = {
      backendUrl: document.getElementById('backendUrl').value.trim(),
      displayMode: document.getElementById('displayMode').value,
      selectorRules: (await browser.storage.local.get('settings')).settings?.selectorRules || DEFAULT_SETTINGS.selectorRules,
      enableBatchMode: document.getElementById('enableBatchMode').checked,
      translator: document.getElementById('translator').value,
      targetLang: document.getElementById('targetLang').value,
      detector: document.getElementById('detector').value,
      inpainter: document.getElementById('inpainter').value,
      renderer: document.getElementById('renderer').value,
      overlayMode: document.getElementById('overlayMode').value,
      overlayOpacity: parseInt(document.getElementById('overlayOpacity').value),
      overlayTextColor: document.getElementById('overlayTextColor').value,
      customTextColor: document.getElementById('customTextColor').value,
      draggableOverlay: document.getElementById('draggableOverlay').checked,
      enableCache: document.getElementById('enableCache').checked,
      skipProcessed: document.getElementById('skipProcessed').checked,
      observeDynamicImages: document.getElementById('observeDynamicImages').checked,
      autoTranslate: true,
      inpaintingSize: parseInt(document.getElementById('inpaintingSize').value),
      autoReduceInpainting: document.getElementById('autoReduceInpainting').value === 'true',
      showProcessIndicator: document.getElementById('showProcessIndicator').value === 'true',
      fontSizeOffset: parseInt(document.getElementById('fontSizeOffset').value)
    };
    
    if (!settings.backendUrl) {
      showStatus('Backend URL is required', 'error');
      return;
    }
    
    await browser.storage.local.set({ settings });
    showStatus('Settings saved successfully!', 'success');
    
    browser.tabs.query({}).then(tabs => {
      tabs.forEach(tab => {
        browser.tabs.sendMessage(tab.id, { action: 'reloadSettings', settings: settings }).catch(() => {});
      });
    });
    
    setTimeout(() => window.close(), 1000);
  } catch (error) {
    showStatus('Error saving settings', 'error');
    console.error('Save settings error:', error);
  }
}

// Reset settings to default
async function resetSettings() {
  try {
    await browser.storage.local.set({ settings: DEFAULT_SETTINGS });
    loadSettings();
    showStatus('Settings reset to default', 'success');
  } catch (error) {
    showStatus('Error resetting settings', 'error');
    console.error('Reset settings error:', error);
  }
}

// Clear cache
async function clearCache() {
  try {
    await browser.storage.local.remove('translationCache');
    updateCacheInfo();
    showStatus('Cache cleared successfully!', 'success');
  } catch (error) {
    showStatus('Error clearing cache', 'error');
    console.error('Clear cache error:', error);
  }
}

// Update cache info
async function updateCacheInfo() {
  try {
    const result = await browser.storage.local.get('translationCache');
    const cache = result.translationCache || {};
    const cacheSize = Object.keys(cache).length;
    document.getElementById('cacheInfo').textContent = `Cache size: ${cacheSize} entries`;
  } catch (error) {
    console.error('Update cache info error:', error);
  }
}

// Show status message
function showStatus(message, type) {
  const statusEl = document.getElementById('status');
  statusEl.textContent = message;
  statusEl.className = `status-popup ${type}`;
  statusEl.style.display = 'block';
  
  // Hide after 3 seconds
  setTimeout(() => {
    statusEl.style.display = 'none';
  }, 3000);
}

// Make sure functions are available globally
function toggleCollapsible(header) {
  const content = header.nextElementSibling;
  const arrow = header.querySelector('.collapsible-arrow');
  
  content.classList.toggle('open');
  arrow.classList.toggle('open');
}

// Check if we're in popup or tab
async function isPopup() {
  try {
    const currentWindow = await browser.windows.getCurrent();
    
    // If innerWidth <= 400, it's desktop popup panel
    // If innerWidth > 400, it's mobile tab (full width)
    return window.innerWidth <= 400;
  } catch (error) {
    return window.innerWidth <= 400;
  }
}

// Smart tab opener - checks if tab already exists
async function openOrSwitchToTab(url) {
  try {
    const tabs = await browser.tabs.query({});
    const existingTab = tabs.find(tab => 
      tab.url && tab.url.includes(url.split('/').pop())
    );
    
    if (existingTab) {
      await browser.tabs.update(existingTab.id, { active: true });
      await browser.windows.update(existingTab.windowId, { focused: true });
    } else {
      await browser.tabs.create({ url: url });
    }
  } catch (error) {
    console.error('Error managing tabs:', error);
    await browser.tabs.create({ url: url });
  }
}