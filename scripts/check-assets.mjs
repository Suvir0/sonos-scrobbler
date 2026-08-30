/**
 * Checks the static pages.
 *
 * There is no build step, so nothing else would catch a page that references a file
 * which is not there, or a stylesheet pulled from a CDN. The second is the one worth
 * automating: the Content-Security-Policy in `src/lib/http.ts` forbids every remote
 * origin, and a blocked stylesheet or font produces no error a visitor or a log would
 * show — the page simply renders wrong for everyone, quietly, in production.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative } from 'node:path';

const ROOT = new URL('../public/', import.meta.url).pathname;
const problems = [];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const files = walk(ROOT);
const pages = files.filter((file) => file.endsWith('.html'));
const present = new Set(files.map((file) => '/' + posix.normalize(relative(ROOT, file))));

if (pages.length === 0) problems.push('no HTML pages found under public/');

/** Attributes that make the browser fetch a subresource, which the CSP governs. */
const SUBRESOURCE = /<(?:link|script|img|source|video|audio|iframe|embed)\b[^>]*?\b(?:src|href)\s*=\s*"([^"]+)"/gi;
/** url(...) inside CSS, same reasoning. */
const CSS_URL = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;

function checkReference(file, url, where) {
  if (/^(data:|mailto:|#)/i.test(url)) return;
  if (/^(https?:)?\/\//i.test(url)) {
    problems.push(`${file}: ${where} loads a remote subresource, which the CSP blocks: ${url}`);
    return;
  }
  if (!url.startsWith('/')) {
    problems.push(`${file}: ${where} uses a relative path (${url}); assets are served from the root`);
    return;
  }
  // Directory pages are served as `/privacy` from `/privacy/index.html`.
  const candidates = [url, posix.join(url, 'index.html'), `${url}.html`];
  if (!candidates.some((candidate) => present.has(candidate))) {
    problems.push(`${file}: ${where} points at ${url}, which is not in public/`);
  }
}

for (const page of pages) {
  const name = relative(ROOT, page);
  const html = readFileSync(page, 'utf8');

  for (const [, url] of html.matchAll(SUBRESOURCE)) checkReference(name, url, 'a subresource');

  // Every page is a document a person can land on directly, including the 404.
  if (!/<html lang="[a-z-]+"/.test(html)) problems.push(`${name}: no lang on <html>`);
  if (!/<title>[^<]+<\/title>/.test(html)) problems.push(`${name}: no <title>`);
  if (!/name="viewport"/.test(html)) problems.push(`${name}: no viewport meta`);
  if (!/rel="stylesheet" href="\/style\.css"/.test(html)) problems.push(`${name}: no stylesheet`);
  if (!/rel="icon"/.test(html)) problems.push(`${name}: no icon`);

  // An external link that can reach back through window.opener, or leak a referrer.
  // The whole tag is matched because rel= sits either side of href=.
  for (const [tag] of html.matchAll(/<a\b[^>]*>/gi)) {
    const href = /href="(https?:\/\/[^"]+)"/i.exec(tag);
    if (href && !/rel="[^"]*noopener/i.test(tag)) {
      problems.push(`${name}: external link to ${href[1]} has no rel="noopener"`);
    }
  }
}

for (const sheet of files.filter((file) => file.endsWith('.css'))) {
  const name = relative(ROOT, sheet);
  for (const [, url] of readFileSync(sheet, 'utf8').matchAll(CSS_URL)) {
    checkReference(name, url, 'a url()');
  }
}

// The licences the OFL requires to travel with the fonts.
for (const required of ['/fonts/Archivo-OFL.txt', '/fonts/IBMPlexMono-OFL.txt']) {
  if (!present.has(required)) problems.push(`${required} is missing; the OFL requires it to ship`);
}

if (problems.length) {
  console.error(problems.map((problem) => `  ✗ ${problem}`).join('\n'));
  console.error(`\n${problems.length} problem(s) in public/`);
  process.exit(1);
}
console.log(`✓ ${pages.length} pages, every reference local and present`);
