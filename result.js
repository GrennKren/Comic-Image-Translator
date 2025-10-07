// Result page script

document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  const imageUrl = params.get('image');
  
  if (imageUrl) {
    displayImage(decodeURIComponent(imageUrl));
  } else {
    showError('No image URL provided');
  }
});

function displayImage(imageUrl) {
  const container = document.getElementById('container');
  
  container.innerHTML = `
    <div class="image-container">
      <img src="${imageUrl}" alt="Translated comic image" id="resultImage">
      <div class="actions">
        <button class="btn-download" id="downloadBtn">
          <span>💾</span> Download Image
        </button>
        <button class="btn-copy" id="copyBtn">
          <span>📋</span> Copy to Clipboard
        </button>
        <button class="btn-close" id="closeBtn">
          <span>✖</span> Close Tab
        </button>
      </div>
    </div>
  `;
  
  // Add event listeners
  document.getElementById('downloadBtn').addEventListener('click', downloadImage);
  document.getElementById('copyBtn').addEventListener('click', copyToClipboard);
  document.getElementById('closeBtn').addEventListener('click', () => window.close());
}

async function downloadImage() {
  const img = document.getElementById('resultImage');
  const imageUrl = img.src;
  
  try {
    const response = await fetch(imageUrl);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `manga_translated_${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    showNotification('Image downloaded successfully!');
  } catch (error) {
    console.error('Download error:', error);
    showNotification('Failed to download image', true);
  }
}

async function copyToClipboard() {
  const img = document.getElementById('resultImage');
  const imageUrl = img.src;
  
  try {
    const response = await fetch(imageUrl);
    const blob = await response.blob();
    
    await navigator.clipboard.write([
      new ClipboardItem({
        [blob.type]: blob
      })
    ]);
    
    showNotification('Image copied to clipboard!');
  } catch (error) {
    console.error('Copy error:', error);
    showNotification('Failed to copy image', true);
  }
}

function showError(message) {
  const container = document.getElementById('container');
  container.innerHTML = `
    <div class="error">
      <h2>Error</h2>
      <p>${message}</p>
      <div style="margin-top: 20px;">
        <button class="btn-close" onclick="window.close()">
          <span>✖</span> Close Tab
        </button>
      </div>
    </div>
  `;
}

function showNotification(message, isError = false) {
  const notification = document.createElement('div');
  notification.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    background: ${isError ? '#e74c3c' : '#2ecc71'};
    color: white;
    padding: 15px 20px;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.2);
    z-index: 10000;
    animation: slideIn 0.3s ease-out;
  `;
  notification.textContent = message;
  
  document.body.appendChild(notification);
  
  setTimeout(() => {
    notification.style.animation = 'slideOut 0.3s ease-out';
    setTimeout(() => notification.remove(), 300);
  }, 3000);
}

// Add CSS animations
const style = document.createElement('style');
style.textContent = `
  @keyframes slideIn {
    from {
      transform: translateX(400px);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }
  
  @keyframes slideOut {
    from {
      transform: translateX(0);
      opacity: 1;
    }
    to {
      transform: translateX(400px);
      opacity: 0;
    }
  }
`;
document.head.appendChild(style);