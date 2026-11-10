import { cp, mkdir, readdir, rm, writeFile, lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { generatePublicConfig } from './write-config.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDirectories = ['assets', 'wix_archive'];
const publicData = ['games.json', 'events.json', 'highlights.json', 'resources.json'];

export async function buildSite(root = repositoryRoot, env = process.env) {
  // Validate before clearing output. No network or database writes during builds.
  const config = generatePublicConfig(env);
  const output = path.join(root, 'dist');
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });

  async function copyPublic(relativePath) {
    await cp(path.join(root, relativePath), path.join(output, relativePath), {
      recursive: true,
      filter: async (source) => {
        const name = path.basename(source);
        if (name.startsWith('.') || name === 'node_modules') return false;
        if ((await lstat(source)).isSymbolicLink()) {
          throw new Error(`Refusing to publish symlink: ${path.relative(root, source)}`);
        }
        // Always use the configuration generated for this build, never a local copy.
        return path.relative(root, source) !== path.join('assets', 'js', 'config.js');
      },
    });
  }

  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && /\.html$/.test(entry.name) && env.SITE_ENV === 'staging') {
      const source = await readFile(path.join(root, entry.name), 'utf8');
      if (!/<head\b[^>]*>/i.test(source) || !/<body\b[^>]*>/i.test(source)) {
        throw new Error(`Cannot add staging banner to ${entry.name}: missing head or body element.`);
      }
      const withStylesheet = source.replace(
        /<\/head>/i,
        '  <link rel="stylesheet" href="/assets/css/staging-banner.css">\n</head>'
      );
      const withBanner = withStylesheet.replace(
        /(<body\b[^>]*>)/i,
        '$1\n<aside class="site-environment-banner" aria-label="Staging site notice"><strong>STAGING SITE</strong><span>This is a test environment. Data here is separate from production.</span></aside>'
      );
      await writeFile(path.join(output, entry.name), withBanner);
    } else if (entry.isFile() && (/\.html$/.test(entry.name) || /^favicon.*\.ico$/.test(entry.name))) {
      await copyPublic(entry.name);
    }
  }
  for (const directory of publicDirectories) await copyPublic(directory);
  for (const file of publicData) await copyPublic(path.join('data', file));
  await mkdir(path.join(output, 'assets', 'js'), { recursive: true });
  await writeFile(path.join(output, 'assets', 'js', 'config.js'), config);
  // The staging Netlify project treats its `staging` branch as its production context.
  // Keep that branch out of search results while the main production site stays indexable.
  if (env.CONTEXT === 'production' && env.BRANCH !== 'staging') {
    await copyPublic('robots.txt');
  } else {
    await writeFile(path.join(output, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
    await writeFile(path.join(output, '_headers'), '/*\n  X-Robots-Tag: noindex, nofollow\n');
  }
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const tests = (await readdir(path.join(repositoryRoot, 'scripts')))
      .filter((name) => name.endsWith('.test.mjs'))
      .sort().map((name) => path.join('scripts', name));
    for (const args of [['--test', ...tests], ['scripts/check-events-duplicates.mjs'], ['scripts/snapshots.mjs', 'check']]) {
      const result = spawnSync(process.execPath, args, { cwd: repositoryRoot, stdio: 'inherit' });
      if (result.error || result.status !== 0) throw new Error('Build validation failed.');
    }
    console.log(`Site build ready: ${await buildSite()}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
