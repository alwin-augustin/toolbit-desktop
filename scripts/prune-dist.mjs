/**
 * Prunes the web-only payload out of the workspace build before Tauri embeds it.
 *
 * `frontendDist` is embedded into the binary file by file, so anything the
 * browser needed but an installed app cannot use is shipped to every user. The
 * 51 Open Graph cards alone are ~2.8 MB of the ~6.6 MB build.
 *
 * Only files that nothing in the app fetches are removed. The PWA/favicon set
 * stays: `index.html` and the runtime SEO module still point at those paths, and
 * a deleted file there is a 404 in the webview console rather than a saving
 * worth having.
 *
 * Runs from `beforeBuildCommand` (cwd is the host repo root, but paths are
 * resolved against this file so it does not matter).
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** Web-only paths, relative to the built `dist`. */
const WEB_ONLY = [
  // Open Graph cards: fetched by social crawlers, never by the app.
  'og',
  'og-image.png',
  // PWA install-prompt screenshots referenced only by `manifest.json`.
  'screenshots',
  // Emitted for the prerenderer (`seo:generate`), which the desktop build skips.
  'structured-data.json',
  // Cloudflare Pages deployment config; meaningless inside a bundled app.
  '_headers',
  '_redirects',
];

const dist = fileURLToPath(new URL('../../../Web/web/dist', import.meta.url));

if (!existsSync(dist)) {
  console.error(`prune-dist: no build at ${dist} — run the web build first`);
  process.exit(1);
}

// Sanity: only ever prune a directory that is unmistakably the app build.
if (!existsSync(`${dist}/assets`) || !existsSync(`${dist}/index.html`)) {
  console.error(`prune-dist: refusing to run — ${dist} does not look like the app build`);
  process.exit(1);
}

/**
 * URLs `index.html` actually fetches: `href`/`src` targets, without query or
 * fragment. Meta tags (`og:image`, Twitter cards) are deliberately excluded —
 * they are metadata a crawler reads, not something the app ever requests, which
 * is exactly why those images are safe to drop.
 */
function fetchedByIndex(html) {
  const urls = new Set();
  for (const [, target] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    urls.add(target.split(/[?#]/)[0]);
  }
  return urls;
}

/** Total bytes of a file or directory tree. */
function sizeOf(path) {
  const stats = statSync(path);
  if (!stats.isDirectory()) return stats.size;
  return readdirSync(path, { withFileTypes: true }).reduce(
    (total, entry) => total + sizeOf(`${path}/${entry.name}`),
    0,
  );
}

const index = await readFile(`${dist}/index.html`, 'utf8');
const fetched = fetchedByIndex(index);

let freed = 0;
const removed = [];

for (const entry of WEB_ONLY) {
  const path = `${dist}/${entry}`;
  if (!existsSync(path)) continue;

  // Guard: never delete something the entry document fetches, or the app shows
  // a 404 in place of a screen. Directories are matched by prefix (`/og/x.png`).
  const publicPath = `/${entry}`;
  const referenced = [...fetched].some((url) =>
    statSync(path).isDirectory() ? url.startsWith(`${publicPath}/`) : url === publicPath,
  );
  if (referenced) {
    console.warn(`prune-dist: keeping ${entry} — index.html still fetches it`);
    continue;
  }

  freed += sizeOf(path);
  rmSync(path, { recursive: true, force: true });
  removed.push(entry);
}

// Stray OS metadata that would otherwise be embedded too.
for (const junk of ['.DS_Store']) {
  const path = `${dist}/${junk}`;
  if (existsSync(path)) {
    freed += statSync(path).size;
    rmSync(path, { force: true });
    removed.push(junk);
  }
}

console.log(
  removed.length
    ? `prune-dist: removed ${removed.join(', ')} (${(freed / 1024 / 1024).toFixed(2)} MB)`
    : 'prune-dist: nothing to remove',
);
