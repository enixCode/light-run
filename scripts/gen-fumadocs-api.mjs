/*
 * Regenerate the Fumadocs API reference from the TypeScript source.
 *
 * Runs typedoc (typedoc-plugin-markdown, configured in typedoc.json) into
 * website/content/docs/api, then rewrites each page for Fumadocs: adds a
 * frontmatter `title` derived from the typedoc H1 (stripping the kind prefix
 * like "Interface: ") and drops the typedoc page header. Fumadocs then
 * auto-builds the API sidebar from the file tree.
 *
 * Run from the repo root: `node scripts/gen-fumadocs-api.mjs`. Wire this into
 * the docs CI step before `next build` so the API tracks the code.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const OUT = 'website/content/docs/api';

execSync(`npx typedoc --out ${OUT}`, { stdio: 'inherit' });

const ROOT = path.resolve(OUT);

function clean(h1) {
  return h1
    .replace(/^#\s+/, '')
    .replace(/^(Interface|Class|Function|Type Alias|Variable|Enumeration|Enum|Namespace):\s*/, '')
    .replace(/\(\)$/, '')
    .trim();
}

function fixLinks(text, currentDir) {
  // Rewrite typedoc's relative `.md` cross-links to extensionless Fumadocs
  // routes, e.g. `../interfaces/RunRequest.md#x` -> `/docs/api/interfaces/RunRequest#x`.
  // Fumadocs routes have no `.md`, so the raw typedoc links 404.
  return text.replace(/\]\(([^)#\s]+\.md)(#[^)]*)?\)/g, (m, relPath, anchor) => {
    if (/^https?:\/\//.test(relPath)) return m;
    const resolved = path.posix.normalize(path.posix.join(currentDir, relPath)).replace(/\.md$/, '');
    const route = resolved === 'index' ? '/docs/api' : `/docs/api/${resolved}`;
    return `](${route}${anchor ?? ''})`;
  });
}

function rewrite(file) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const h1Idx = lines.findIndex((l) => /^#\s+/.test(l));
  let title;
  if (rel === 'index.md') title = 'API reference';
  else if (h1Idx >= 0) title = clean(lines[h1Idx]);
  else title = path.basename(file, '.md');

  let body = h1Idx >= 0 ? lines.slice(h1Idx + 1) : lines;
  while (body.length && body[0].trim() === '') body.shift();

  const dir = path.posix.dirname(rel);
  const fixed = fixLinks(body.join('\n'), dir === '.' ? '' : dir);
  const safe = title.replace(/"/g, '\\"');
  fs.writeFileSync(file, `---\ntitle: "${safe}"\n---\n\n${fixed.trimEnd()}\n`, 'utf8');
}

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.md')) rewrite(p);
  }
}

walk(ROOT);

// typedoc's cleanOutputDir wipes the folder on every run, so (re)write the
// Fumadocs group meta here rather than keeping it as a static file. The pages
// list is derived from the groups typedoc actually emitted (so a project with
// exported variables/enums is not silently dropped from the sidebar), in a
// stable conventional order with any unexpected group appended.
const GROUP_ORDER = ['classes', 'interfaces', 'functions', 'variables', 'type-aliases', 'enumerations'];
const present = fs
  .readdirSync(ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);
const pages = [
  'index',
  ...GROUP_ORDER.filter((g) => present.includes(g)),
  ...present.filter((g) => !GROUP_ORDER.includes(g)).sort(),
];
fs.writeFileSync(
  path.join(ROOT, 'meta.json'),
  `${JSON.stringify({ title: 'API reference', pages }, null, 2)}\n`,
  'utf8',
);

console.log('Fumadocs API reference regenerated.');
