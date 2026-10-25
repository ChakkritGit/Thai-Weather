// Runs in <head> before the page paints (a file, not inline: the CSP allows only 'self' scripts): the theme and
// language picked on this device, so a pinned light / dark never flashes the OS one first. See i18n.js.
(() => {
  const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const theme = read('dock.theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  const lang = read('dock.lang');
  if (lang === 'en' || lang === 'ja') document.documentElement.lang = lang;
})();
