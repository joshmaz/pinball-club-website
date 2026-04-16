#!/usr/bin/env node
/**
 * Reads Facebook events export markdown and writes data/events.json
 * Usage: node scripts/build-events-from-md.mjs <path-to.md>
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseDateLine(line) {
  const m = line.match(
    /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), ([A-Za-z]{3}) (\d{1,2}), (\d{4})$/
  );
  if (!m) return null;
  const d = new Date(`${m[1]} ${m[2]}, ${m[3]}`);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${day}`;
}

function unescapeTitle(s) {
  return s
    .replace(/\\!/g, '!')
    .replace(/\\-/g, '-')
    .replace(/\\#/g, '#')
    .replace(/\\\[/g, '[')
    .replace(/\\\]/g, ']')
    .replace(/\\\*/g, '*');
}

function canonicalUrl(u) {
  const id = /\/events\/(\d+)/.exec(u);
  if (!id) return u;
  return `https://www.facebook.com/events/${id[1]}/`;
}

async function main() {
  const mdPath = process.argv[2] || path.join(__dirname, '..', '..', 'Downloads', 'Untitled document.md');
  const outPath = path.join(__dirname, '..', 'data', 'events.json');
  const raw = await readFile(mdPath, 'utf8');
  const lines = raw.split(/\r?\n/);

  const events = [];
  let pendingDate = null;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const iso = parseDateLine(trimmed);
    if (iso) {
      pendingDate = iso;
      continue;
    }

    const link = trimmed.match(
      /^\[(.+)]\((https:\/\/www\.facebook\.com\/events\/[^)]+)\)$/
    );
    if (!link || !pendingDate) {
      continue;
    }

    const name = unescapeTitle(link[1]);
    const url = link[2];
    i++;

    const locParts = [];
    for (; i < lines.length; i++) {
      const L = lines[i].trim();
      if (L.startsWith('Event by')) break;
      if (L === '') continue;
      if (L.startsWith('·')) continue;
      locParts.push(L);
    }

    const location = locParts.length > 0 ? locParts.join(' ') : 'TBD';

    events.push({
      name,
      date: pendingDate,
      location,
      url: canonicalUrl(url),
      source: 'facebook',
    });

    pendingDate = null;
  }

  await writeFile(outPath, `${JSON.stringify(events, null, 4)}\n`, 'utf8');
  console.log(`Wrote ${events.length} events to ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
