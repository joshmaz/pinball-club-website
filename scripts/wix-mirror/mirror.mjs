/**
 * One-off Wix static mirror for museum archive.
 * Run from repo root: node scripts/wix-mirror/mirror.mjs
 * Requires: npm install in scripts/wix-mirror
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import scrape from 'website-scraper';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const outDir = path.join(repoRoot, 'wix_archive', 'site');

const START = 'https://snhpinball.wixsite.com/home';

function allowedUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname;
    return (
      host === 'snhpinball.wixsite.com' ||
      host.endsWith('.wixstatic.com') ||
      host.endsWith('.parastorage.com') ||
      host === 'static.parastorage.com' ||
      host === 'siteassets.parastorage.com'
    );
  } catch {
    return false;
  }
}

await fs.rm(outDir, { recursive: true, force: true });

await scrape({
  urls: [START],
  directory: outDir,
  recursive: true,
  maxDepth: 4,
  maxConcurrency: 3,
  urlFilter: (url) => allowedUrl(url),
  filenameGenerator: 'bySiteStructure',
  prettifyUrls: true,
  request: {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  },
});

console.log('Mirror written to:', outDir);

const { spawnSync } = await import('child_process');
const rewrite = spawnSync(
  process.execPath,
  [path.join(__dirname, 'rewrite-archive-urls.mjs')],
  { stdio: 'inherit', cwd: repoRoot }
);
if (rewrite.status !== 0) process.exit(rewrite.status ?? 1);
