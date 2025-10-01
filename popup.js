// Popup script for settings management

const DEFAULT_SETTINGS = {
  backendUrl: 'http://127.0.0.1:8000',
  translator: 'sugoi',
  targetLang: 'ENG',
  detector: 'default',
  inpainter: 'lama_large',
  renderer: 'manga2eng',
  useGpu: false, // Disimpan tapi tidak ditampilkan di UI
  displayMode: 'overlay',
  customSelector: '[name="image-item"] img', // Default selector sesuai dengan yang Anda gunakan
  enableBatchMode: true,
  // Overlay settings
  overlayMode: 'colored',
  overlayOpacity: 90,
  overlayTextColor: 'auto',
  customTextColor: '#ffffff',
  draggableOverlay: true,
  // Cache settings
  enableCache: true,
  // Other settings
  skipProcessed: true, // Changed from skipTranslated to skipProcessed
  observeDynamicImages: true,
  autoTranslate: true
};

// Load settings on popup open
document.addEventListener('DOMContentLoaded', loadSettings);

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

// Custom selector change handler for auto-translation
document.getElementById('customSelector').addEventListener('change', function() {
  if (this.value && settings.enableBatchMode) {
    // Notify content script about selector change
    browser.tabs.query({active: true, currentWindow: true}).then(tabs => {
      browser.tabs.sendMessage(tabs[0].id, {
        action: 'updateSelector',
        selector: this.value
      }).catch(() => {
        // Ignore if content script not ready
      });
    });
  }
});

// Enable batch mode change handler
document.getElementById('enableBatchMode').addEventListener('change', function() {
  if (this.checked && document.getElementById('customSelector').value) {
    // Notify content script to start auto-translation
    browser.tabs.query({active: true, currentWindow: true}).then(tabs => {
      browser.tabs.sendMessage(tabs[0].id, {
        action: 'startAutoTranslate',
        selector: document.getElementById('customSelector').value
      }).catch(() => {
        // Ignore if content script not ready
      });
    });
  } else {
    // Notify content script to stop auto-translation
    browser.tabs.query({active: true, currentWindow: true}).then(tabs => {
      browser.tabs.sendMessage(tabs[0].id, {
        action: 'stopAutoTranslate'
      }).catch(() => {
        // Ignore if content script not ready
      });
    });
  }
  
  // Update status display
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
    
    // Populate form fields
    document.getElementById('backendUrl').value = settings.backendUrl;
    document.getElementById('displayMode').value = settings.displayMode;
    document.getElementById('customSelector').value = settings.customSelector;
    document.getElementById('enableBatchMode').checked = settings.enableBatchMode;
    document.getElementById('translator').value = settings.translator;
    document.getElementById('targetLang').value = settings.targetLang;
    document.getElementById('detector').value = settings.detector;
    document.getElementById('inpainter').value = settings.inpainter;
    document.getElementById('renderer').value = settings.renderer;
    
    // Load overlay settings
    document.getElementById('overlayMode').value = settings.overlayMode;
    document.getElementById('overlayOpacity').value = settings.overlayOpacity;
    document.getElementById('overlayTextColor').value = settings.overlayTextColor;
    document.getElementById('customTextColor').value = settings.customTextColor;
    document.getElementById('draggableOverlay').checked = settings.draggableOverlay;
    
    // Load cache and other settings
    document.getElementById('enableCache').checked = settings.enableCache;
    document.getElementById('skipProcessed').checked = settings.skipProcessed; // Changed from skipTranslated
    document.getElementById('observeDynamicImages').checked = settings.observeDynamicImages;
    
    // Show/hide overlay settings based on display mode
    const overlaySettings = document.getElementById('overlaySettings');
    if (settings.displayMode === 'overlay') {
      overlaySettings.style.display = 'block';
    } else {
      overlaySettings.style.display = 'none';
    }
    
    // Show/hide custom color picker
    const customColorGroup = document.getElementById('customColorGroup');
    if (settings.overlayTextColor === 'custom') {
      customColorGroup.style.display = 'block';
    } else {
      customColorGroup.style.display = 'none';
    }
    
    // Update cache info
    updateCacheInfo();
    
    // Update auto-translate status
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
  const hasSelector = document.getElementById('customSelector').value.length > 0;
  
  if (isEnabled && hasSelector) {
    statusElement.textContent = 'Status: Active';
    statusElement.style.color = '#28a745';
  } else if (isEnabled && !hasSelector) {
    statusElement.textContent = 'Status: Waiting for selector';
    statusElement.style.color = '#ffc107';
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
      customSelector: document.getElementById('customSelector').value.trim(),
      enableBatchMode: document.getElementById('enableBatchMode').checked,
      translator: document.getElementById('translator').value,
      targetLang: document.getElementById('targetLang').value,
      detector: document.getElementById('detector').value,
      inpainter: document.getElementById('inpainter').value,
      renderer: document.getElementById('renderer').value,
      useGpu: false, // Selalu false, tidak ada opsi UI
      // Save overlay settings
      overlayMode: document.getElementById('overlayMode').value,
      overlayOpacity: parseInt(document.getElementById('overlayOpacity').value),
      overlayTextColor: document.getElementById('overlayTextColor').value,
      customTextColor: document.getElementById('customTextColor').value,
      draggableOverlay: document.getElementById('draggableOverlay').checked,
      // Save cache and other settings
      enableCache: document.getElementById('enableCache').checked,
      skipProcessed: document.getElementById('skipProcessed').checked, // Changed from skipTranslated
      observeDynamicImages: document.getElementById('observeDynamicImages').checked,
      autoTranslate: true
    };
    
    // Validate backend URL
    if (!settings.backendUrl) {
      showStatus('Backend URL is required', 'error');
      return;
    }
    
    // Validate custom selector if provided
    if (settings.customSelector) {
      try {
        document.querySelectorAll(settings.customSelector);
      } catch (e) {
        showStatus('Invalid CSS selector', 'error');
        return;
      }
    }
    
    await browser.storage.local.set({ settings });
    showStatus('Settings saved successfully!', 'success');
    
    // Reload content scripts to apply new settings
    browser.tabs.query({}).then(tabs => {
      tabs.forEach(tab => {
        browser.tabs.sendMessage(tab.id, { action: 'reloadSettings', settings: settings }).catch(() => {
          // Ignore errors for tabs without content script
        });
      });
    });
    
    // Close popup after 1 second
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