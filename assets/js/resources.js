// Loads data/resources.json and renders category sections with resource cards.
// Deep links: resources.html#<resource-id> scrolls to the card and expands its section.
// Filter chips show all categories or isolate one (hidden categories are skipped).

const RESOURCES_URL = 'data/resources.json';

/** @typedef {{ id: string, title: string, description?: string, sortOrder?: number }} Category */
/** @typedef {{ label: string, url: string }} ResourceLink */
/** @typedef {{ id: string, categoryId: string, title: string, shortLabel?: string, summary?: string, description?: string, links?: ResourceLink[], imageUrl?: string, sortOrder?: number }} Resource */

function showMessage(container, title, details) {
  container.replaceChildren();
  const card = document.createElement('div');
  card.className = 'resource-card';
  const h3 = document.createElement('h3');
  h3.textContent = title;
  const p = document.createElement('p');
  p.textContent = details;
  card.appendChild(h3);
  card.appendChild(p);
  container.appendChild(card);
}

/**
 * @param {string | undefined} s
 * @returns {string}
 */
function safeText(s) {
  return s == null ? '' : String(s);
}

/**
 * @param {Category[]} categories
 * @param {Resource[]} resources
 */
function validateAndGroup(categories, resources) {
  const catIds = new Set(categories.map((c) => c.id));
  const seenIds = new Set();
  for (const r of resources) {
    if (seenIds.has(r.id)) {
      console.warn(`Duplicate resource id in ${RESOURCES_URL}:`, r.id);
    }
    seenIds.add(r.id);
    if (!catIds.has(r.categoryId)) {
      console.warn(`Resource "${r.id}" references unknown categoryId:`, r.categoryId);
    }
  }
}

/**
 * @param {Category[]} categories
 * @returns {Category[]}
 */
function sortCategories(categories) {
  return [...categories].sort((a, b) => {
    const ao = a.sortOrder ?? 0;
    const bo = b.sortOrder ?? 0;
    if (ao !== bo) return ao - bo;
    return a.title.localeCompare(b.title);
  });
}

/**
 * @param {Resource[]} list
 * @returns {Resource[]}
 */
function sortResources(list) {
  return [...list].sort((a, b) => {
    const ao = a.sortOrder ?? 0;
    const bo = b.sortOrder ?? 0;
    if (ao !== bo) return ao - bo;
    return a.title.localeCompare(b.title);
  });
}

/**
 * @param {Resource} resource
 * @returns {HTMLElement}
 */
function createResourceCard(resource) {
  const article = document.createElement('article');
  article.className = 'resource-card';
  article.id = resource.id;

  const imageUrl = resource.imageUrl;
  if (imageUrl != null && safeText(imageUrl).trim() !== '') {
    const img = document.createElement('img');
    img.src = safeText(imageUrl);
    img.alt = `${resource.title} image`;
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.className = 'resource-card-image';
    article.appendChild(img);
  }

  const titleRow = document.createElement('div');
  titleRow.className = 'resource-card-title-row';

  const h3 = document.createElement('h3');
  h3.className = 'resource-card-title';
  h3.textContent = resource.title;
  titleRow.appendChild(h3);

  const shortLabel = resource.shortLabel;
  if (shortLabel != null && safeText(shortLabel).trim() !== '') {
    const abbr = document.createElement('span');
    abbr.className = 'resource-card-short-label';
    abbr.textContent = safeText(shortLabel);
    abbr.title = 'Short label / acronym';
    titleRow.appendChild(abbr);
  }

  article.appendChild(titleRow);

  const summary = resource.summary;
  if (summary != null && safeText(summary).trim() !== '') {
    const sumP = document.createElement('p');
    sumP.className = 'resource-card-summary';
    sumP.textContent = safeText(summary);
    article.appendChild(sumP);
  }

  const desc = resource.description;
  if (desc != null && safeText(desc).trim() !== '') {
    const descP = document.createElement('p');
    descP.className = 'resource-card-description';
    descP.textContent = safeText(desc);
    article.appendChild(descP);
  }

  const links = resource.links;
  if (links != null && links.length > 0) {
    const list = document.createElement('ul');
    list.className = 'resource-card-links';
    for (const link of links) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      const href = safeText(link.url);
      a.href = href;
      const isExternal = /^https?:\/\//i.test(href);
      if (isExternal) {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      }
      a.textContent = safeText(link.label) || href;
      li.appendChild(a);
      list.appendChild(li);
    }
    article.appendChild(list);
  }

  const linkSelf = document.createElement('div');
  linkSelf.className = 'resource-card-permalink';
  const perm = document.createElement('a');
  perm.href = `#${encodeURIComponent(resource.id)}`;
  perm.className = 'resource-card-permalink-anchor';
  perm.setAttribute(
    'aria-label',
    `Bookmark link to ${resource.title || resource.id}`
  );
  perm.title = 'Link to this card';

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('resource-card-permalink-icon');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute(
    'd',
    'M5 5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16l-7-3.5L5 21V5z'
  );
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  perm.appendChild(svg);

  linkSelf.appendChild(perm);
  article.appendChild(linkSelf);

  return article;
}

/**
 * @param {HTMLElement} container
 * @param {{ categories: Category[], resources: Resource[] }} data
 */
function render(container, data) {
  const { categories: rawCategories, resources } = data;
  const categories = sortCategories(rawCategories);
  validateAndGroup(categories, resources);

  const byCat = new Map();
  for (const c of categories) {
    byCat.set(c.id, []);
  }
  for (const r of resources) {
    if (!byCat.has(r.categoryId)) {
      if (!byCat.has('_orphan')) {
        byCat.set('_orphan', []);
      }
      byCat.get('_orphan').push(r);
    } else {
      byCat.get(r.categoryId).push(r);
    }
  }

  container.replaceChildren();

  const toolbar = document.createElement('div');
  toolbar.className = 'resources-toolbar';
  toolbar.setAttribute('role', 'group');
  const filterLabel = document.createElement('span');
  filterLabel.className = 'resources-filter-label';
  filterLabel.id = 'resources-filter-label';
  filterLabel.textContent = 'Show:';
  toolbar.setAttribute('aria-labelledby', 'resources-filter-label');
  toolbar.appendChild(filterLabel);

  const btnAll = document.createElement('button');
  btnAll.type = 'button';
  btnAll.className = 'resources-filter-btn resources-filter-btn--active';
  btnAll.textContent = 'All';
  btnAll.setAttribute('aria-pressed', 'true');
  btnAll.dataset.filter = 'all';
  toolbar.appendChild(btnAll);

  const categoryButtons = [];
  const detailsElements = [];

  for (const cat of categories) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'resources-filter-btn';
    btn.textContent = cat.title;
    btn.setAttribute('aria-pressed', 'false');
    btn.dataset.filter = cat.id;
    btn.title = safeText(cat.description);
    categoryButtons.push(btn);
    toolbar.appendChild(btn);
  }

  container.appendChild(toolbar);

  const sectionsWrap = document.createElement('div');
  sectionsWrap.className = 'resources-sections';

  for (const cat of categories) {
    const list = sortResources(byCat.get(cat.id) || []);
    const details = document.createElement('details');
    details.className = 'resources-category';
    details.dataset.categoryId = cat.id;
    details.open = true;

    const summary = document.createElement('summary');
    summary.className = 'resources-category-summary';
    const sumTitle = document.createElement('span');
    sumTitle.className = 'resources-category-title';
    sumTitle.textContent = cat.title;
    summary.appendChild(sumTitle);
    const count = document.createElement('span');
    count.className = 'resources-category-count';
    count.textContent = `${list.length}`;
    summary.appendChild(count);
    details.appendChild(summary);

    const desc = cat.description;
    if (desc != null && safeText(desc).trim() !== '') {
      const descP = document.createElement('p');
      descP.className = 'resources-category-description';
      descP.textContent = safeText(desc);
      details.appendChild(descP);
    }

    const grid = document.createElement('div');
    grid.className = 'resources-grid';
    for (const r of list) {
      grid.appendChild(createResourceCard(r));
    }
    details.appendChild(grid);

    if (list.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'resources-category-empty';
      empty.textContent = 'No entries yet.';
      details.appendChild(empty);
    }

    sectionsWrap.appendChild(details);
    detailsElements.push(details);
  }

  const orphans = byCat.get('_orphan');
  if (orphans && orphans.length > 0) {
    const details = document.createElement('details');
    details.className = 'resources-category resources-category--orphan';
    details.open = true;
    const summary = document.createElement('summary');
    summary.className = 'resources-category-summary';
    const sumTitle = document.createElement('span');
    sumTitle.className = 'resources-category-title';
    sumTitle.textContent = 'Uncategorized';
    summary.appendChild(sumTitle);
    details.appendChild(summary);
    const grid = document.createElement('div');
    grid.className = 'resources-grid';
    for (const r of sortResources(orphans)) {
      grid.appendChild(createResourceCard(r));
    }
    details.appendChild(grid);
    sectionsWrap.appendChild(details);
    detailsElements.push(details);
  }

  container.appendChild(sectionsWrap);

  const allButtons = [btnAll, ...categoryButtons];

  function setActiveFilter(filterId) {
    for (const b of allButtons) {
      const active = b.dataset.filter === filterId;
      b.classList.toggle('resources-filter-btn--active', active);
      b.setAttribute('aria-pressed', active ? 'true' : 'false');
    }

    for (const d of detailsElements) {
      const catId = d.dataset.categoryId;
      if (filterId === 'all') {
        d.hidden = false;
      } else {
        d.hidden = catId !== filterId;
      }
    }
  }

  btnAll.addEventListener('click', () => setActiveFilter('all'));
  for (const btn of categoryButtons) {
    btn.addEventListener('click', () => {
      const id = btn.dataset.filter;
      if (id) setActiveFilter(id);
    });
  }

  /**
   * Expand parent <details>, optionally reset filter so the card is visible, then scroll.
   */
  function applyHash() {
    const raw = window.location.hash.replace(/^#/, '');
    if (!raw) {
      return;
    }
    let id;
    try {
      id = decodeURIComponent(raw);
    } catch {
      id = raw;
    }

    const el = document.getElementById(id);
    if (!el || !el.classList.contains('resource-card')) {
      return;
    }

    setActiveFilter('all');

    let node = el.parentElement;
    while (node && node !== container) {
      if (node instanceof HTMLDetailsElement) {
        node.open = true;
      }
      node = node.parentElement;
    }

    el.classList.remove('resource-card--highlight');
    void el.offsetWidth;
    el.classList.add('resource-card--highlight');

    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  window.addEventListener('hashchange', applyHash);
  requestAnimationFrame(() => applyHash());
}

async function loadResources() {
  const container = document.getElementById('resources-container');
  if (!container) {
    console.error("Element with id 'resources-container' not found.");
    return;
  }

  try {
    const response = await fetch(RESOURCES_URL, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Request failed (${response.status} ${response.statusText}) for ${RESOURCES_URL}`);
    }
    const data = await response.json();
    if (!data || typeof data !== 'object') {
      throw new Error(`Invalid data in ${RESOURCES_URL}`);
    }
    if (!Array.isArray(data.categories) || !Array.isArray(data.resources)) {
      throw new Error(`Invalid data format in ${RESOURCES_URL}: expected categories and resources arrays.`);
    }
    render(container, /** @type {{ categories: Category[], resources: Resource[] }} */ (data));
  } catch (error) {
    console.error('Error loading resources:', error);
    showMessage(
      container,
      'Unable to load resources',
      `We could not load the resources list right now. Details: ${error.message}`
    );
  }
}

loadResources();
