// Run before the stylesheet so a saved light theme is applied before the page paints.
(() => {
  let theme = 'dark';
  try { if (localStorage.getItem('tappilot.theme') === 'light') theme = 'light'; } catch { /* Storage may be unavailable; keep the default. */ }
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle('dark', theme === 'dark');
})();
