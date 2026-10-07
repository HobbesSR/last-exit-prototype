import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

function required(from, name) {
  if (!name.startsWith(".")) {
    const root = path.join(ROOT, "node_modules", name);
    const main = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).main ?? "index.js";
    return required(path.join(root, "package.json"), `./${main}`);
  }
  const base = path.resolve(path.dirname(from), name);
  if (fs.existsSync(`${base}.js`)) return `${base}.js`;
  return fs.existsSync(base) && fs.statSync(base).isFile() ? base : path.join(base, "index.js");
}

const vendored = new Map();

/**
 * A CommonJS package as one ES module, for the browser.
 * Note: This hand-rolled bundler handles simple `require()` calls for these two packages.
 * It does not support circular dependencies, dynamic imports, or JSON files.
 */
export function vendorModule(name) {
  const cached = vendored.get(name);
  if (cached) return cached;
  const ids = new Map(), factories = [];
  const visit = (file) => {
    if (ids.has(file)) return ids.get(file);
    const id = factories.push("") - 1;
    ids.set(file, id);
    const source = fs.readFileSync(file, "utf8")
      .replace(/\brequire\((["'])([^"']+)\1\)/g, (_, _quote, target) => `require(${visit(required(file, target))})`);
    factories[id] = `function (module, exports, require) {\n${source}\n}`;
    return id;
  };
  visit(required(path.join(ROOT, "package.json"), name));
  const body = `const factories = [${factories.join(",\n")}], loaded = [];
function require(id) {
  if (!loaded[id]) {
    const module = (loaded[id] = { exports: {} });
    factories[id](module, module.exports, require);
  }
  return loaded[id].exports;
}
export default require(0);
`;
  vendored.set(name, body);
  return body;
}
