/**
 * Rewrite mirrored Wix archive URLs so the museum works on S3 + CloudFront:
 * 1) absolute snhpinball.wixsite.com URLs -> /wix_archive/site/... paths
 * 2) extensionless page paths -> .../index.html (S3 REST does not resolve directories)
 * 3) Wix nav hrefs like about-us/ or ../events/ -> .../index.html
 *
 * Run: node scripts/wix-mirror/rewrite-archive-urls.mjs
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.resolve(__dirname, '../../wix_archive/site');

const PREFIX = '/wix_archive/site/snhpinball.wixsite.com/home';
const PREFIX_ESCAPED = PREFIX.replace(/\//g, '\\/');
const PAGE_SLUGS = ['about-us', 'events', 'grid', 'menu', 'merch', 'our-games'];

const NAV_FIX_TAG =
  '<script src="/wix_archive/site/snhpinball.wixsite.com/home/archive-nav-fix.js" defer></script>';

function suffixes() {
  return ['"', "'", '?'];
}

function buildIndexHtmlReplacements(base, escaped) {
  const out = [];

  for (const end of suffixes()) {
    out.push([`${base}${end}`, `${base}/index.html${end}`]);
    out.push([`${base}/${end}`, `${base}/index.html${end}`]);
    out.push([`${escaped}${end}`, `${escaped}\\/index.html${end}`]);
    out.push([`${escaped}\\/${end}`, `${escaped}\\/index.html${end}`]);
  }

  for (const slug of PAGE_SLUGS) {
    for (const end of suffixes()) {
      out.push([`${base}/${slug}${end}`, `${base}/${slug}/index.html${end}`]);
      out.push([`${escaped}\\/${slug}${end}`, `${escaped}\\/${slug}\\/index.html${end}`]);
    }
  }

  return out;
}

function buildRelativeNavReplacements() {
  const out = [['href="../"', 'href="../index.html"']];
  for (const slug of PAGE_SLUGS) {
    out.push([`href="${slug}/"`, `href="${slug}/index.html"`]);
    out.push([`href="../${slug}/"`, `href="../${slug}/index.html"`]);
  }
  return out;
}

const DOMAIN_REPLACEMENTS = [
  ['https:\\/\\/snhpinball.wixsite.com\\/home', PREFIX_ESCAPED],
  ['https://snhpinball.wixsite.com/home', PREFIX],
];

const INDEX_HTML_REPLACEMENTS = buildIndexHtmlReplacements(PREFIX, PREFIX_ESCAPED);
const RELATIVE_NAV_REPLACEMENTS = buildRelativeNavReplacements();

async function walk(dir, files = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, files);
    else if (/\.(html|js|json|css)$/i.test(e.name)) files.push(full);
  }
  return files;
}

function rewrite(content) {
  let out = content;
  for (const [from, to] of DOMAIN_REPLACEMENTS) {
    out = out.split(from).join(to);
  }
  for (const [from, to] of INDEX_HTML_REPLACEMENTS) {
    if (out.includes(from) && !from.includes('/index.html')) {
      out = out.split(from).join(to);
    }
  }
  for (const [from, to] of RELATIVE_NAV_REPLACEMENTS) {
    if (out.includes(from) && !from.includes('index.html')) {
      out = out.split(from).join(to);
    }
  }
  return out;
}

function injectNavFix(content) {
  const relativeTag = '<script src="archive-nav-fix.js" defer></script>';
  let out = content.split(relativeTag).join(NAV_FIX_TAG);
  if (!out.includes('archive-nav-fix.js')) {
    out = out.replace('</body>', `${NAV_FIX_TAG}\n</body>`);
  }
  return out;
}

const files = await walk(siteRoot);
let changed = 0;
for (const file of files) {
  const raw = await fs.readFile(file, 'utf8');
  let next = rewrite(raw);
  if (file.endsWith('.html')) {
    next = injectNavFix(next);
  }
  if (next !== raw) {
    await fs.writeFile(file, next, 'utf8');
    changed++;
  }
}
console.log(`Rewrote ${changed} files under`, siteRoot);
