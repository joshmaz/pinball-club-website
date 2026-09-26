/* Shared link labels, safe presentation, and the repeatable event editor. */
(function (root) {
  function safeUrl(value) {
    try {
      const url = new URL(String(value || '').trim());
      return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
    } catch { return ''; }
  }
  function inferLabel(value) {
    const url = safeUrl(value);
    if (!url) return 'Event link';
    const host = new URL(url).hostname.toLowerCase();
    const providers = [
      ['matchplay.events', 'Match Play'], ['ifpapinball.com', 'IFPA'],
      ['facebook.com', 'Facebook'], ['fb.me', 'Facebook'], ['fb.com', 'Facebook'],
      ['discord.com', 'Discord'], ['discord.gg', 'Discord'],
      ['eventbrite.com', 'Eventbrite'], ['meetup.com', 'Meetup'],
      ['instagram.com', 'Instagram'], ['youtube.com', 'YouTube'], ['youtu.be', 'YouTube'],
    ];
    return (providers.find(([domain]) => host === domain || host.endsWith('.' + domain)) || [null, 'Event link'])[1];
  }
  function fromEvent(event) {
    if (Array.isArray(event.external_links)) return event.external_links;
    return [...(Array.isArray(event.externalLinks) ? event.externalLinks : []),
      ...((event.external_url || event.url) ? [{ url: event.external_url || event.url }] : [])];
  }
  function normalize(items, strict = false) {
    const seen = new Set();
    return (items || []).flatMap(item => {
      const raw = typeof item?.url === 'string' ? item.url.trim() : '';
      const label = typeof item?.label === 'string' ? item.label.trim() : '';
      if (!raw && !label) return [];
      const url = safeUrl(raw);
      if (!url || raw.length > 1000 || label.length > 200) {
        if (strict) throw new Error('Each link needs an http:// or https:// URL (up to 1,000 characters) and an optional label (up to 200 characters).');
        return [];
      }
      if (seen.has(url)) return [];
      seen.add(url);
      return [{ url, ...(label ? { label } : {}) }];
    });
  }
  function presentation(event) {
    return normalize(fromEvent(event)).map(item => ({ ...item, label: item.label || inferLabel(item.url) }));
  }
  function createEditor(container, addButton) {
    const doc = container.ownerDocument;
    let rows = [];
    let nextId = 0;
    function add(item = {}, focus = false) {
      const row = doc.createElement('div'); row.className = 'event-link-row';
      const url = doc.createElement('input'); url.type = 'url'; url.maxLength = 1000; url.placeholder = 'https://…';
      const label = doc.createElement('input'); label.type = 'text'; label.maxLength = 200; label.placeholder = 'Optional';
      const id = 'event-link-' + (++nextId);
      url.id = id + '-url'; label.id = id + '-label';
      for (const [input, text] of [[url, 'URL'], [label, 'Label (optional)']]) {
        const wrapper = doc.createElement('label'); wrapper.htmlFor = input.id;
        wrapper.textContent = text; wrapper.appendChild(input); row.appendChild(wrapper);
      }
      url.value = item.url || '';
      label.value = item.label || (url.value && inferLabel(url.value) !== 'Event link' ? inferLabel(url.value) : '');
      let manual = !!item.label;
      label.addEventListener('input', () => { manual = true; });
      url.addEventListener('input', () => {
        url.setCustomValidity('');
        if (!manual) { const inferred = inferLabel(url.value); label.value = inferred === 'Event link' ? '' : inferred; }
      });
      const remove = doc.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove link';
      const entry = { row, url, label };
      remove.addEventListener('click', () => {
        rows = rows.filter(candidate => candidate !== entry); row.remove();
        if (!rows.length) add();
        (rows[0]?.url || addButton).focus();
      });
      row.appendChild(remove); rows.push(entry); container.appendChild(row);
      if (focus) url.focus();
    }
    function set(items) {
      rows = []; container.replaceChildren();
      (items && items.length ? items : [{}]).forEach(item => add(item));
    }
    function get() {
      return normalize(rows.map(({ url, label }) => ({ url: url.value, label: label.value })), true);
    }
    function append(item) {
      const items = get();
      if (!items.some(existing => existing.url === safeUrl(item.url))) {
        // Keep existing row state, especially manually edited labels.
        const blank = rows.find(entry => !entry.url.value && !entry.label.value);
        if (blank) { rows = rows.filter(entry => entry !== blank); blank.row.remove(); }
        add(item);
      }
    }
    addButton.addEventListener('click', () => add({}, true));
    set([]);
    return { set, get, append };
  }
  const api = { safeUrl, inferLabel, fromEvent, normalize, presentation, createEditor };
  root.SNHEventLinks = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
