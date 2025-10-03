let rules = [];

document.addEventListener('DOMContentLoaded', loadRules);

document.getElementById('addRuleBtn').addEventListener('click', addNewRule);
document.getElementById('saveBtn').addEventListener('click', saveRules);
document.getElementById('exportBtn').addEventListener('click', exportRules);
document.getElementById('importInput').addEventListener('change', importRules);

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
  const tbody = document.getElementById('rulesBody');
  const emptyState = document.getElementById('emptyState');
  
  if (rules.length === 0) {
    tbody.innerHTML = '';
    emptyState.style.display = 'block';
    return;
  }
  
  emptyState.style.display = 'none';
  
  // Clear existing content
  tbody.innerHTML = '';
  
  rules.forEach((rule, index) => {
    const isGeneral = rule.domains === '*' || rule.isGeneral;
    const domainValue = isGeneral ? '*' : rule.domains;
    const domainReadonly = isGeneral ? 'readonly style="background: #f0f0f0; cursor: not-allowed;"' : '';
    const badgeHtml = isGeneral ? '<span style="display: inline-block; background: #ffc107; color: #333; padding: 2px 6px; border-radius: 3px; font-size: 11px; font-weight: 600; margin-left: 8px;">GENERAL</span>' : '';
    
    // Create row element
    const row = document.createElement('tr');
    row.setAttribute('data-index', index);
    
    row.innerHTML = `
      <td style="text-align: center;">
        <input type="checkbox" class="rule-enabled" ${rule.enabled ? 'checked' : ''}>
      </td>
      <td>
        <input type="text" class="rule-domains" placeholder="e.g., bato.to, manga*.com or * for general" ${domainReadonly}>
        ${badgeHtml}
      </td>
      <td>
        <input type="text" class="rule-selector" placeholder="e.g., img.manga-page, .comic img">
      </td>
      <td style="text-align: center;">
        <button class="btn-small btn-delete">Delete</button>
      </td>
    `;
    
    // Append row to tbody
    tbody.appendChild(row);
    
    // Now safely set values using JavaScript (after element is in DOM)
    const domainsInput = row.querySelector('.rule-domains');
    const selectorInput = row.querySelector('.rule-selector');
    
    domainsInput.value = domainValue;  // Safe: JS handles quotes
    selectorInput.value = rule.selector;  // Safe: JS handles quotes like [name="image-item"] img
  });
  
  attachRowEventListeners();
}

function attachRowEventListeners() {
  document.querySelectorAll('.rule-enabled').forEach((checkbox, index) => {
    checkbox.addEventListener('change', (e) => {
      rules[index].enabled = e.target.checked;
    });
  });
  
  document.querySelectorAll('.rule-domains').forEach((input, index) => {
    input.addEventListener('input', (e) => {
      const value = e.target.value.trim();
      rules[index].domains = value;
      rules[index].isGeneral = value === '*';
    });
  });
  
  document.querySelectorAll('.rule-selector').forEach((input, index) => {
    input.addEventListener('input', (e) => {
      rules[index].selector = e.target.value;
    });
  });
  
  document.querySelectorAll('.btn-delete').forEach((btn, index) => {
    btn.addEventListener('click', () => {
      if (confirm('Are you sure you want to delete this rule?')) {
        rules.splice(index, 1);
        renderRules();
      }
    });
  });
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
  
  const tbody = document.getElementById('rulesBody');
  const lastRow = tbody.lastElementChild;
  const domainsInput = lastRow.querySelector('.rule-domains');
  domainsInput.focus();
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
    
    //setTimeout(() => {
    //  window.close();
    //}, 1500);
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
        id: rule.id || Date.now() + Math.random()
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

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}