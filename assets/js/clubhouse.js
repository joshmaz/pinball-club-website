/* Shared visible selector, backed by the existing shared theme preference. */
(function () {
  const select = document.getElementById('club-theme');
  if (!select || !window.SNHTheme) return;
  const sync = () => { select.value = window.SNHTheme.get(); };
  select.addEventListener('change', () => window.SNHTheme.set(select.value));
  new MutationObserver(sync).observe(document.documentElement, {
    attributes: true, attributeFilter: ['data-theme-pref'],
  });
  sync();
})();
