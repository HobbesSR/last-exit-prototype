// Checks the local Markdown links and #fragments in docs/ and the README files (#876).
// Run `node tools/check-doc-links.mjs` from anywhere; it exits 1 and lists each broken link as file:line.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p) : p.endsWith('.md') ? [p] : [];
});

/** The files whose links are checked: docs/**, the root README and README.*.md. */
export function docFiles(base = root) {
  const files = existsSync(path.join(base, 'docs')) ? walk(path.join(base, 'docs')) : [];
  for (const name of readdirSync(base)) {
    if (/^README(\..+)?\.md$/.test(name)) files.push(path.join(base, name));
  }
  return files;
}

/** Visible lines with fenced code blocks blanked, so links and headings inside them are ignored. */
function visibleLines(text) {
  let fence = null;
  return text.split(/\r?\n/).map((line) => {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      return '';
    }
    if (m) { fence = m[1]; return ''; }
    return line;
  });
}

const stripInline = (s) => s
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, '$1')
  .replace(/<[^>]+>/g, '')
  .replace(/[`*~]/g, '')
  .replace(/(^|\W)_+|_+(?=\W|$)/g, '$1');

/** GitHub's heading slug: lowercase, drop punctuation, spaces to hyphens. */
export function slug(heading) {
  return stripInline(heading).trim().toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, '')
    .replace(/ /g, '-');
}

/** Heading slugs (with GitHub's -1, -2 suffixes for repeats) and explicit anchor ids of a document. */
export function anchors(text) {
  const headings = new Set();
  const ids = new Set();
  const seen = new Map();
  for (const line of visibleLines(text)) {
    const h = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (h) {
      const base = slug(h[1]);
      // GitHub gives a repeat the next free `-N`, so a suffixed slug can collide with a later heading's own.
      let n = seen.get(base) ?? 0;
      let id = n ? `${base}-${n}` : base;
      while (headings.has(id)) id = `${base}-${++n}`;
      seen.set(base, n + 1);
      headings.add(id);
    }
    for (const a of line.matchAll(/<a\s[^>]*?\b(?:id|name)\s*=\s*["']([^"']+)["']/gi)) ids.add(a[1]);
    for (const a of line.matchAll(/<[a-z][^>]*?\bid\s*=\s*["']([^"']+)["']/gi)) ids.add(a[1]);
  }
  return { headings, ids };
}

/** Local link targets in a document, as { target, line }. Code spans, fences and external URLs are skipped. */
export function links(text) {
  const out = [];
  visibleLines(text).forEach((raw, i) => {
    const line = raw.replace(/(`+)[^`]*?\1/g, (m) => ' '.repeat(m.length));
    const push = (target) => {
      target = target.trim();
      target = target.startsWith('<') ? target.slice(1).split('>')[0] : target.replace(/\s+["'(].*$/, '');
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) return;
      // Forgejo issue, pull request and commit links are site paths, outside this check (#876).
      if (/^\/[^/]+\/[^/]+\/(issues|pulls?|commits?|actions|releases)(\/|#|$)/.test(target)) return;
      out.push({ target, line: i + 1 });
    };
    for (const m of line.matchAll(/\]\(\s*((?:<[^>]*>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?)\s*\)/g)) push(m[1]);
    const ref = /^ {0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/.exec(line);
    if (ref) push(ref[1]);
    for (const m of line.matchAll(/<a\s[^>]*?\bhref\s*=\s*["']([^"']+)["']/gi)) push(m[1]);
  });
  return out;
}

const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

/** Every broken local link as { file, line, target, problem }, paths relative to `base`. */
export function checkLinks(base = root) {
  const cache = new Map();
  const anchorsOf = (file) => {
    if (!cache.has(file)) cache.set(file, anchors(readFileSync(file, 'utf8')));
    return cache.get(file);
  };
  const inside = (file, dir) => !path.relative(dir, file).startsWith('..');
  const archive = path.join(base, 'docs', 'archive');
  const problems = [];
  for (const file of docFiles(base)) {
    const fromArchive = inside(file, archive);
    for (const { target, line } of links(readFileSync(file, 'utf8'))) {
      const [pathPart, ...rest] = target.split('#');
      const fragment = rest.length ? safeDecode(rest.join('#')) : '';
      const resolved = pathPart ? path.resolve(path.dirname(file), safeDecode(pathPart.split('?')[0])) : file;
      // 33: an archived record keeps its wording, so only its links within the archive are checked.
      if (fromArchive && !inside(resolved, archive)) continue;
      const report = (problem) => problems.push({ file: path.relative(base, file).replaceAll('\\', '/'), line, target, problem });
      if (!existsSync(resolved)) { report('target does not exist'); continue; }
      if (!fragment || !resolved.endsWith('.md') || !statSync(resolved).isFile()) continue;
      if (/^L\d+(-L?\d+)?$/.test(fragment)) continue;
      const { headings, ids } = anchorsOf(resolved);
      if (!ids.has(fragment) && !headings.has(fragment.toLowerCase())) report('no heading or anchor named #' + fragment);
    }
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = checkLinks();
  for (const p of problems) console.log(`${p.file}:${p.line}  ${p.target}  (${p.problem})`);
  console.log(`${problems.length} broken local link${problems.length === 1 ? '' : 's'} in ${docFiles().length} files`);
  process.exit(problems.length ? 1 : 0);
}
