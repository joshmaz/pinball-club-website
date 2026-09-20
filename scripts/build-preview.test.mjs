import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { buildPreview } from './build-preview.mjs';

const env = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'public-test-key',
  GAMES_CATALOG_SOURCE: 'db',
  SUPABASE_SERVICE_ROLE_KEY: 'must-never-be-published',
  CONTEXT: 'deploy-preview',
};

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinball-preview-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {
    'index.html': '<h1>Club</h1>',
    'members.html': '<h1>Members</h1>',
    'donate/index.html': '<h1>Donate</h1>',
    'wix_archive/site/home/index.html': '<h1>Archive</h1>',
    'assets/js/config.js': 'LOCAL CONFIG MUST NOT BE COPIED',
    'assets/js/site-auth.js': '// Public script',
    'assets/.env': 'private nested file',
    'data/games.json': '[]', 'data/events.json': '[]',
    'data/highlights.json': '[]', 'data/resources.json': '[]',
    'data/latest-opdb.json': 'maintenance input',
    'scripts/private.mjs': 'private tooling',
    'supabase/migrations/private.sql': 'schema',
    '.env': 'private config', 'README.md': 'internal docs',
    'robots.txt': 'User-agent: *\nAllow: /\n',
    'dist/stale.html': 'previous build',
  };
  for (const [file, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), contents);
  }
  return root;
}

test('preview publishes public pages, nested routes and fresh config without private files', async (t) => {
  const root = await fixture(t);
  const output = await buildPreview(root, env);
  for (const file of ['index.html', 'members.html', 'donate/index.html', 'wix_archive/site/home/index.html', 'assets/js/site-auth.js', 'data/events.json']) {
    await access(path.join(output, file));
  }
  for (const file of ['.env', 'assets/.env', 'scripts', 'supabase', 'README.md', 'data/latest-opdb.json', 'stale.html']) {
    await assert.rejects(access(path.join(output, file)), { code: 'ENOENT' });
  }
  const config = await readFile(path.join(output, 'assets/js/config.js'), 'utf8');
  const context = { window: {} };
  vm.runInNewContext(config, context);
  assert.equal(context.window.SNH_CONFIG.supabaseUrl, env.SUPABASE_URL);
  assert.equal(context.window.SNH_CONFIG.supabaseAnonKey, env.SUPABASE_ANON_KEY);
  assert.equal(context.window.SNH_CONFIG.gamesCatalogSource, 'db');
  assert.ok(!config.includes(env.SUPABASE_SERVICE_ROLE_KEY));
  assert.match(await readFile(path.join(output, '_headers'), 'utf8'), /noindex/);
  assert.match(await readFile(path.join(output, 'robots.txt'), 'utf8'), /Disallow: \//);
  assert.equal(await readFile(path.join(root, 'assets/js/config.js'), 'utf8'), 'LOCAL CONFIG MUST NOT BE COPIED');
});

test('Netlify production keeps the normal robots policy and removes preview headers', async (t) => {
  const root = await fixture(t);
  await buildPreview(root, env);
  const output = await buildPreview(root, { ...env, CONTEXT: 'production' });
  assert.match(await readFile(path.join(output, 'robots.txt'), 'utf8'), /Allow: \//);
  await assert.rejects(access(path.join(output, '_headers')), { code: 'ENOENT' });
});

test('missing public configuration fails before replacing prior output', async (t) => {
  const root = await fixture(t);
  await assert.rejects(buildPreview(root, {}), /Missing SUPABASE_URL/);
  assert.equal(await readFile(path.join(root, 'dist/stale.html'), 'utf8'), 'previous build');
});

test('symlinks cannot publish files from outside public directories', async (t) => {
  const root = await fixture(t);
  await symlink(path.join(root, '.env'), path.join(root, 'assets', 'leak.txt'));
  await assert.rejects(buildPreview(root, env), /Refusing to publish symlink/);
});
