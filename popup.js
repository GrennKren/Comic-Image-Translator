// Popup script for settings management

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

// Load settings on popup open
document.addEventListener('DOMContentLoaded', loadSettings);

document.getElementById('manageSelectorsBtn').addEventListener('click', function() {
  browser.tabs.create({
    url: browser.runtime.getURL('selectors.html')
  });
});

// Save button handler
document.getElementById('saveBtn').addEventListener('click', saveSettings);

// Reset button handler
document.getElementById('resetBtn').addEventListener('click', resetSettings);

// Clear cache button handler
document.getElementById('clearCache').addEventListener('click', clearCache);

// Display mode change handler
document.getElementById('displayMode').addEventListener('change', function() {
  const overlaySettings = document.getElementById('overlaySettings');
  if (this.value === 'overlay') {
    overlaySettings.style.display = 'block';
  } else {
    overlaySettings.style.display = 'none';
  }
});


// Enable batch mode change handler
document.getElementById('enableBatchMode').addEventListener('change', function() {
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

// Add event listeners for overlay options
document.getElementById('overlayTextColor').addEventListener('change', function() {
  const customColorGroup = document.getElementById('customColorGroup');
  if (this.value === 'custom') {
    customColorGroup.style.display = 'block';
  } else {
    customColorGroup.style.display = 'none';
  }
});

// Load settings from storage
async function loadSettings() {
  try {
    const result = await browser.storage.local.get('settings');
    settings = result.settings || DEFAULT_SETTINGS;
    
    // Ensure selectorRules exists
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
    
    document.getElementById('enableCache').checked = settings.enableCache;
    document.getElementById('skipProcessed').checked = settings.skipProcessed;
    document.getElementById('observeDynamicImages').checked = settings.observeDynamicImages;
    
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

// Save settings to storage
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
      autoTranslate: true
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
  statusEl.className = `status ${type}`;
  statusEl.style.display = 'block';
  
  // Hide after 3 seconds
  setTimeout(() => {
    statusEl.style.display = 'none';
  }, 3000);
}