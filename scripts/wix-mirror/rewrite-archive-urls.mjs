/**
 * Rewrite absolute snhpinball.wixsite.com URLs in mirrored files to root-relative
 * paths under /wix_archive/site/snhpinball.wixsite.com/home so the museum works
 * after the live Wix site is turned off.
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

const REPLACEMENTS = [
  ['https:\\/\\/snhpinball.wixsite.com\\/home', PREFIX_ESCAPED],
  ['https://snhpinball.wixsite.com/home', PREFIX],
];

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
  for (const [from, to] of REPLACEMENTS) {
    out = out.split(from).join(to);
  }
  return out;
}

const files = await walk(siteRoot);
let changed = 0;
for (const file of files) {
  const raw = await fs.readFile(file, 'utf8');
  const next = rewrite(raw);
  if (next !== raw) {
    await fs.writeFile(file, next, 'utf8');
    changed++;
  }
}
console.log(`Rewrote ${changed} files under`, siteRoot);
