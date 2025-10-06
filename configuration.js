// configuration.js - Simple script for configuration page interactions

document.addEventListener('DOMContentLoaded', function() {
  // Open all sections by default for guide
  const headers = document.querySelectorAll('.collapsible-header');
  headers.forEach(header => {
    const content = header.nextElementSibling;
    const arrow = header.querySelector('.collapsible-arrow');
    if (content && arrow) {
      content.classList.add('open');
      arrow.classList.add('open');
      header.addEventListener('click', function() {
        toggleCollapsible(this);
      });
    }
  });

  // Close button handler
  const closeBtn = document.getElementById('closeBtn');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => window.close());
  }

  // Define toggleCollapsible if not already global
  window.toggleCollapsible = function(header) {
    const content = header.nextElementSibling;
    const arrow = header.querySelector('.collapsible-arrow');
    content.classList.toggle('open');
    arrow.classList.toggle('open');
  };
});