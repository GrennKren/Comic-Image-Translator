// selectors.js - Updated to wrap all event listeners in DOMContentLoaded

let rules = [];

document.addEventListener('DOMContentLoaded', function() {
  loadRules();

  // Manage Selectors button handlers
  const addRuleBtn = document.getElementById('addRuleBtn');
  if (addRuleBtn) {
    addRuleBtn.addEventListener('click', addNewRule);
  } else {
    console.warn('addRuleBtn not found');
  }

  const saveBtn = document.getElementById('saveBtn');
  if (saveBtn) {
    saveBtn.addEventListener('click', saveRules);
  } else {
    console.warn('saveBtn not found');
  }

  const exportBtn = document.getElementById('exportBtn');
  if (exportBtn) {
    exportBtn.addEventListener('click', exportRules);
  } else {
    console.warn('exportBtn not found');
  }

  const importBtn = document.getElementById('importBtn');
  if (importBtn) {
    importBtn.addEventListener('click', function() {
      const importInput = document.getElementById('importInput');
      if (importInput) {
        importInput.click();
      }
    });
  } else {
    console.warn('importBtn not found');
  }

  const importInput = document.getElementById('importInput');
  if (importInput) {
    importInput.addEventListener('change', importRules);
  } else {
    console.warn('importInput not found');
  }

  const mobileSaveBtn = document.getElementById('mobileSaveBtn');
  if (mobileSaveBtn) {
    mobileSaveBtn.addEventListener('click', saveRules);
  }
});

async function loadRules() {
  try {
    const result = await browser.storage.local.get('settings');
    const settings = result.settings || {};
    
    rules = settings.selectorRules || [
      {
        enabled: true,
        domains: 'bato.to',
        selector: '[name="image-item"] img',
        id: Date.now()
      }
    ];
    
    renderRules();
  } catch (error) {
    console.error('Error loading rules:', error);
    showStatus('Error loading rules', 'error');
  }
}

function renderRules() {
  const container = document.getElementById('rulesContainer');
  const emptyState = document.getElementById('emptyState');
  
  if (rules.length === 0) {
    container.innerHTML = '';
    emptyState.style.display = 'block';
    return;
  }
  
  emptyState.style.display = 'none';
  container.innerHTML = '';
  
  rules.forEach((rule, index) => {
    const isGeneral = rule.domains === '*' || rule.isGeneral;
    const card = createRuleCard(rule, index, isGeneral);
    container.appendChild(card);
  });
}

function createRuleCard(rule, index, isGeneral) {
  const card = document.createElement('div');
  card.className = 'rule-card';
  card.setAttribute('data-index', index);
  
  const header = document.createElement('div');
  header.className = 'rule-header';
  
  const toggle = document.createElement('div');
  toggle.className = 'rule-toggle';
  
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = rule.enabled;
  checkbox.id = `rule-enabled-${index}`;
  checkbox.addEventListener('change', (e) => {
    rules[index].enabled = e.target.checked;
  });
  
  const label = document.createElement('label');
  label.htmlFor = `rule-enabled-${index}`;
  label.textContent = 'Enabled';
  
  toggle.appendChild(checkbox);
  toggle.appendChild(label);
  
  if (isGeneral) {
    const badge = document.createElement('span');
    badge.className = 'rule-badge';
    badge.textContent = 'GENERAL';
    toggle.appendChild(badge);
  }
  
  const actions = document.createElement('div');
  actions.className = 'rule-actions';
  
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn-delete';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', () => {
    if (confirm('Are you sure you want to delete this rule?')) {
      rules.splice(index, 1);
      renderRules();
    }
  });
  
  actions.appendChild(deleteBtn);
  
  header.appendChild(toggle);
  header.appendChild(actions);
  
  const domainField = document.createElement('div');
  domainField.className = 'rule-field';
  
  const domainLabel = document.createElement('label');
  domainLabel.textContent = 'Domain(s):';
  
  const domainInput = document.createElement('input');
  domainInput.type = 'text';
  domainInput.value = isGeneral ? '*' : rule.domains;
  domainInput.placeholder = 'e.g., bato.to, manga*.com or * for general';
  if (isGeneral) {
    domainInput.readOnly = true;
  }
  domainInput.addEventListener('input', (e) => {
    const value = e.target.value.trim();
    rules[index].domains = value;
    rules[index].isGeneral = value === '*';
  });
  
  domainField.appendChild(domainLabel);
  domainField.appendChild(domainInput);
  
  const selectorField = document.createElement('div');
  selectorField.className = 'rule-field';
  
  const selectorLabel = document.createElement('label');
  selectorLabel.textContent = 'CSS Selector:';
  
  const selectorInput = document.createElement('input');
  selectorInput.type = 'text';
  selectorInput.value = rule.selector;
  selectorInput.placeholder = 'e.g., img.manga-page, .comic img';
  selectorInput.addEventListener('input', (e) => {
    rules[index].selector = e.target.value;
  });
  
  selectorField.appendChild(selectorLabel);
  selectorField.appendChild(selectorInput);
  
  card.appendChild(header);
  card.appendChild(domainField);
  card.appendChild(selectorField);
  
  return card;
}

function addNewRule() {
  rules.push({
    enabled: true,
    domains: '',
    selector: '',
    id: Date.now(),
    isGeneral: false
  });
  renderRules();
  
  const container = document.getElementById('rulesContainer');
  const lastCard = container.lastElementChild;
  const domainInput = lastCard.querySelector('input[type="text"]');
  domainInput.focus();
}

async function saveRules() {
  try {
    const validRules = rules.filter(rule => rule.domains.trim() && rule.selector.trim());
    
    if (validRules.length === 0 && rules.length > 0) {
      showStatus('Please fill in all fields or delete empty rules', 'error');
      return;
    }
    
    const result = await browser.storage.local.get('settings');
    const settings = result.settings || {};
    
    settings.selectorRules = validRules;
    
    await browser.storage.local.set({ settings });
    
    showStatus('Rules saved successfully!', 'success');
    
    browser.tabs.query({}).then(tabs => {
      tabs.forEach(tab => {
        browser.tabs.sendMessage(tab.id, { 
          action: 'reloadSettings', 
          settings: settings 
        }).catch(() => {});
      });
    });
  } catch (error) {
    console.error('Error saving rules:', error);
    showStatus('Error saving rules', 'error');
  }
}

function exportRules() {
  const validRules = rules.filter(rule => rule.domains.trim() && rule.selector.trim());
  
  const dataStr = JSON.stringify(validRules, null, 2);
  const dataBlob = new Blob([dataStr], { type: 'application/json' });
  const url = URL.createObjectURL(dataBlob);
  
  const link = document.createElement('a');
  link.href = url;
  link.download = 'manga-translator-selectors.json';
  link.click();
  
  URL.revokeObjectURL(url);
  showStatus('Rules exported successfully!', 'success');
}

function importRules(event) {
  const file = event.target.files[0];
  if (!file) return;
  
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const imported = JSON.parse(e.target.result);
      
      if (!Array.isArray(imported)) {
        showStatus('Invalid JSON format: expected an array', 'error');
        return;
      }
      
      const validImported = imported.filter(rule => 
        rule.domains && rule.selector && 
        typeof rule.domains === 'string' && 
        typeof rule.selector === 'string'
      ).map(rule => ({
        enabled: rule.enabled !== false,
        domains: rule.domains,
        selector: rule.selector,
        id: rule.id || Date.now() + Math.random(),
        isGeneral: rule.domains === '*' || rule.isGeneral
      }));
      
      if (validImported.length === 0) {
        showStatus('No valid rules found in import file', 'error');
        return;
      }
      
      rules = validImported;
      renderRules();
      showStatus(`Successfully imported ${validImported.length} rule(s)`, 'success');
    } catch (error) {
      console.error('Import error:', error);
      showStatus('Error parsing JSON file', 'error');
    }
  };
  
  reader.readAsText(file);
  event.target.value = '';
}

function showStatus(message, type) {
  const statusEl = document.getElementById('status');
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
  statusEl.style.display = 'block';
  
  setTimeout(() => {
    statusEl.style.display = 'none';
  }, 3000);
}