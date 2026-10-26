import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';

/** CommonJS/UMD packages the dev labs import by bare name, wrapped as ES modules. */
export const VENDOR_MODULES = Object.freeze({ sat: '/vendor/sat.mjs', pathfinding: '/vendor/pathfinding.mjs',
  'clipper-lib': '/vendor/clipper.mjs', delaunator: '/vendor/delaunator.mjs',
  '@kninnug/constrainautor': '/vendor/constrainautor.mjs' });
/** Package directories served to every browser as they are installed, by URL prefix. */
export const VENDOR_DIRECTORIES = Object.freeze({ '/vendor/phaser': 'phaser/dist', '/vendor/lucide': 'lucide/dist/umd',
  '/vendor/sat': 'sat', '/vendor/rapier': '@dimforge/rapier2d-compat/dist' });
/** Every third-party file above is covered here (THIRD-PARTY-NOTICES.txt, docs/21.1). */
export const NOTICES_URL = '/third-party-notices.txt';
const BARE ={ ...VENDOR_MODULES, '@dimforge/rapier2d-compat': '/vendor/rapier/rapier.mjs' };

function bareResolved(source) {
  return source.replace(/(\bfrom\s*|\bimport\s*)(["'])([^"'./][^"']*)\2/g, (match, keyword, quote, name) =>
    BARE[name] ? `${keyword}${quote}${BARE[name]}${quote}` : match);
}

// The browser imports the shared simulation modules directly, the same source the server runs.
// Node strips their types on its own; this does the equivalent for the client, per request.
//
// Stripping is not compilation: types are replaced with spaces, so line and column positions are
// preserved exactly and a browser stack trace still points at the real source line. That is why
// there is no bundle, no output directory and no source map to keep in sync.
export function serveSharedModules(root, resolveBare = false) {
  const cache = new Map();
  return async function sharedModules(req, res, next) {
    const normalizedRoot = path.normalize(root).replace(/[\\/]$/, '');
    const requested = path.join(normalizedRoot, path.normalize(req.path));
    if (!requested.startsWith(normalizedRoot + path.sep) || !requested.endsWith('.ts') || requested.endsWith('.d.ts')) return next();
    try {
      const { mtimeMs, size } = await stat(requested);
      const cached = cache.get(requested);
      let code;
      if (cached?.mtimeMs === mtimeMs && cached.size === size && cached.resolveBare === resolveBare) {
        code = cached.code;
      } else {
        const stripped = stripTypeScriptTypes(await readFile(requested, 'utf8'), { mode: 'strip' });
        code = resolveBare ? bareResolved(stripped) : stripped;
      }
      cache.set(requested, { mtimeMs, size, code, resolveBare });
      res.type('text/javascript').send(code);
    } catch (e) {
      console.error("serveSharedModules error for", requested, e);
      next();
    }
  };
}
