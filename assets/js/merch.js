(() => {
  const store = 'https://shop.snhpinballclub.com';
  const googleNamespace = 'http://base.google.com/ns/1.0';
  const categories = [
    { id: 'shirts', title: 'T-shirts', match: /\b(?:t[ -]?shirts?|tees?)\b/i },
    { id: 'hoodies-and-hats', title: 'Hoodies & hats', match: /\b(?:hoodies?|sweatshirts?|caps?|hats?|beanies?)\b/i },
    { id: 'drinkware', title: 'Drinkware', match: /\b(?:mugs?|glass(?:es)?|bottles?|tumblers?|koozies?)\b/i },
    { id: 'stickers', title: 'Stickers', match: /\b(?:stickers?|decals?)\b/i },
    { id: 'other-merch', title: 'More from the club' },
  ];

  const catalog = document.querySelector('#merch-catalog');
  const navigation = document.querySelector('#merch-categories');
  const status = document.querySelector('#merch-status');
  const decoder = document.createElement('textarea');

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function decodeTitle(title) {
    decoder.innerHTML = title.replaceAll('<', '&lt;');
    return decoder.value;
  }

  function productLink(path) {
    const url = new URL(path, store);
    return url.origin === store && /^\/products\/[a-z0-9-]+\/?$/.test(url.pathname) ? url : null;
  }

  async function getFeed(path, signal) {
    const response = await fetch(store + path, { signal, credentials: 'omit' });
    if (!response.ok) throw new Error('Fourthwall feed unavailable');
    return response;
  }

  async function loadProducts(signal) {
    const products = new Map();
    for (let page = 1; ; page += 1) {
      const path = page === 1 ? '/collections/all.json' : `/collections/all/${page}.json`;
      const feed = await (await getFeed(path, signal)).json();
      if (!Array.isArray(feed.products) || feed.current_page !== page) {
        throw new Error('Unexpected Fourthwall collection response');
      }
      if (!feed.products.length) return [...products.values()];
      for (const product of feed.products) {
        if (product.id && typeof product.title === 'string') products.set(product.id, product);
      }
    }
  }

  async function loadDescriptions(signal) {
    const response = await getFeed('/.well-known/merchant-center/rss.xml', signal);
    const feed = new DOMParser().parseFromString(await response.text(), 'application/xml');
    if (feed.documentElement.localName !== 'rss') throw new Error('Unexpected Fourthwall RSS response');

    const descriptions = new Map();
    for (const item of feed.querySelectorAll('channel > item')) {
      const field = (name) => item.getElementsByTagNameNS(googleNamespace, name)[0]?.textContent.trim();
      const description = field('description');
      const group = field('item_group_id');
      const link = field('link');
      if (description && group) descriptions.set(group, description);
      if (description && link) descriptions.set(new URL(link, store).pathname.replace(/\/$/, ''), description);
    }
    return descriptions;
  }

  function priceLabel(product) {
    const prices = (product.variants ?? []).map((variant) => variant.price);
    const currency = prices.find((price) => /^[A-Z]{3}$/.test(price?.currency_iso))?.currency_iso ?? 'USD';
    const amounts = prices.filter((price) => price?.currency_iso === currency && Number.isSafeInteger(price.cents))
      .map((price) => price.cents / 100);
    const format = new Intl.NumberFormat('en-US', { style: 'currency', currency });
    if (amounts.length) {
      const minimum = Math.min(...amounts);
      return minimum === Math.max(...amounts) ? format.format(minimum) : `From ${format.format(minimum)}`;
    }
    if (product.price != null && String(product.price).trim() && Number.isFinite(Number(product.price))) {
      return format.format(Number(product.price));
    }
    return 'See store for pricing';
  }

  function createCard(product, descriptions) {
    const link = productLink(product.url);
    if (!link) return null;
    const title = decodeTitle(product.title);
    const card = element('article', 'merch-item');

    if (typeof product.image === 'string' && product.image.startsWith('https://')) {
      const image = element('img', 'merch-item-image');
      image.src = product.image;
      image.alt = '';
      image.loading = 'lazy';
      image.decoding = 'async';
      card.append(image);
    }

    const heading = element('h3', null, title);
    const price = element('p', 'merch-price', priceLabel(product));
    if (product.available === false) price.append(element('span', 'merch-stock', 'Sold out'));

    const description = descriptions.get(product.id) ?? descriptions.get(link.pathname.replace(/\/$/, ''));
    const action = element('a', 'club-button merch-product-link', 'View in store');
    action.href = link.href;
    action.setAttribute('aria-label', `View ${title} in store`);

    card.append(heading, price);
    if (description) card.append(element('p', 'merch-description', description));
    card.append(action);
    return card;
  }

  async function showCatalog() {
    status.textContent = 'Loading current merch…';
    const signal = AbortSignal.timeout(10000);
    try {
      const [products, descriptions] = await Promise.all([
        loadProducts(signal),
        loadDescriptions(signal).catch(() => null),
      ]);
      const productDescriptions = descriptions ?? new Map();
      const sections = new Map();
      for (const product of products) {
        const category = categories.find(({ match }) => !match || match.test(product.title));
        const card = createCard(product, productDescriptions);
        if (!card) continue;
        if (!sections.has(category.id)) sections.set(category.id, []);
        sections.get(category.id).push(card);
      }

      for (const { id, title } of categories) {
        const cards = sections.get(id);
        if (!cards) continue;
        const jump = element('a', null, title);
        jump.href = `#${id}`;
        navigation.append(jump);
        const section = element('section', 'merch-category');
        section.id = id;
        const heading = element('h2', null, title);
        heading.id = `${id}-title`;
        section.setAttribute('aria-labelledby', heading.id);
        const grid = element('div', 'merch-grid');
        grid.append(...cards);
        section.append(heading, grid);
        catalog.append(section);
      }
      navigation.hidden = sections.size < 2;
      status.textContent = sections.size === 0
        ? 'There are no public products to display right now.'
        : descriptions === null ? 'Visit the store for full product descriptions.' : '';
      const anchor = document.getElementById(location.hash.slice(1));
      if (anchor && catalog.contains(anchor)) anchor.scrollIntoView();
    } catch {
      status.textContent = 'The catalog couldn’t load. Visit the Fourthwall store for current products and prices.';
    }
  }

  showCatalog();
})();
