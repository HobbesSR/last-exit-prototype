import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';

// The browser imports the shared simulation modules directly, the same source the server runs.
// Node strips their types on its own; this does the equivalent for the client, per request.
//
// Stripping is not compilation: types are replaced with spaces, so line and column positions are
// preserved exactly and a browser stack trace still points at the real source line. That is why
// there is no bundle, no output directory and no source map to keep in sync.
export function serveSharedModules(root) {
  const cache = new Map();
  return async function sharedModules(req, res, next) {
    const requested = path.join(root, path.normalize(req.path));
    // path.normalize resolves '..' segments; confirm the result stayed inside the shared tree.
    if (!requested.startsWith(root + path.sep) || !requested.endsWith('.ts') || requested.endsWith('.d.ts')) return next();
    try {
      const { mtimeMs, size } = await stat(requested);
      const cached = cache.get(requested);
      const code = cached?.mtimeMs === mtimeMs && cached.size === size
        ? cached.code
        : stripTypeScriptTypes(await readFile(requested, 'utf8'), { mode: 'strip' });
      cache.set(requested, { mtimeMs, size, code });
      res.type('text/javascript').send(code);
    } catch {
      next();
    }
  };
}
