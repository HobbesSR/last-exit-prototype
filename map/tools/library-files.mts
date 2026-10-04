/** Node adapter: named module files live beside the authored library. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MAX_JSON_BYTES } from './core.ts';
import { resolveLibrary } from '../macro/src/chain/library.ts';

function readJson(file: string): any {
  const bytes = readFileSync(file);
  if (bytes.length > MAX_JSON_BYTES) throw new Error(`${file} is too large`);
  return JSON.parse(bytes.toString('utf8'));
}

export function readLibraryFile(file: string, top = readJson(file)): unknown {
  if (!top || typeof top !== 'object' || !('includes' in top)) return top;
  const registry: Record<string, unknown> = Object.create(null);
  function gather(value: { includes?: unknown }): void {
    if (!Array.isArray(value.includes)) return;
    for (const ref of value.includes) {
      if (!ref || typeof ref.name !== 'string') continue; // The resolver names malformed references.
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(ref.name)) throw new Error(`invalid module file name ${ref.name}`);
      if (!Number.isSafeInteger(ref.version) || ref.version < 1) throw new Error(`invalid module content version ${String(ref.version)}`);
      const key = `${ref.name}@${ref.version}`;
      if (Object.hasOwn(registry, key)) continue;
      const path = join(dirname(file), `${key}.json`);
      let module;
      try { module = readJson(path); }
      catch (error) { throw new Error(`cannot load module ${ref.name} from ${path}: ${String(error)}`); }
      registry[key] = module;
      if (module && typeof module === 'object') gather(module);
    }
  }
  gather(top);
  return resolveLibrary(top, registry);
}
