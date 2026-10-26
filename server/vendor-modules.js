import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOTICES_URL } from './shared-assets.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MODULES = path.join(ROOT, "node_modules");

function required(from, name) {
  if (!name.startsWith(".")) {
    const root = path.join(MODULES, name);
    const main = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).main ?? "index.js";
    return required(path.join(root, "package.json"), `./${main}`);
  }
  const base = path.resolve(path.dirname(from), name);
  if (fs.existsSync(`${base}.js`)) return `${base}.js`;
  return fs.existsSync(base) && fs.statSync(base).isFile() ? base : path.join(base, "index.js");
}

/** The installed package a file belongs to, as `{ name, version, license }`. */
function packageOf(file) {
  const parts = path.relative(MODULES, file).split(path.sep);
  const name = parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
  const manifest = JSON.parse(fs.readFileSync(path.join(MODULES, name, "package.json"), "utf8"));
  const license = manifest.license ?? manifest.licenses?.map((entry) => entry.type).join(" OR ") ?? "unknown";
  return { name, version: manifest.version, license };
}

/** Every file a wrapped package's entry pulls in through `require()`, entry first. */
export function vendorSources(name) {
  const files = [];
  const visit = (file) => {
    if (files.includes(file)) return;
    files.push(file);
    const source = fs.readFileSync(file, "utf8");
    for (const [, , target] of source.matchAll(/\brequire\((["'])([^"']+)\1\)/g)) visit(required(file, target));
  };
  // Delaunator's main is ESM; its distributed UMD bundle includes its dependencies
  // and follows the same module.exports path as the other wrapped packages.
  visit(name === 'delaunator' ? path.join(MODULES, 'delaunator/delaunator.min.js')
    : required(path.join(ROOT, "package.json"), name));
  return files;
}

/** The packages a wrapped module redistributes, in the order their files are first reached. */
export function vendorPackages(name) {
  const packages = new Map();
  for (const file of vendorSources(name)) {
    const found = packageOf(file);
    if (!packages.has(found.name)) packages.set(found.name, found);
  }
  return [...packages.values()];
}

const vendored = new Map();

/**
 * A CommonJS/UMD package as one ES module, for the browser.
 * This hand-rolled bundler handles simple `require()` calls in the registered packages.
 * It does not support circular dependencies, dynamic imports, or JSON files.
 * Wrapping drops nothing from the sources, and the banner names what they are and where
 * their licence texts are served, since some ship minified without them (#551).
 */
export function vendorModule(name) {
  const cached = vendored.get(name);
  if (cached) return cached;
  const files = vendorSources(name), ids = new Map(files.map((file, id) => [file, id]));
  const factories = files.map((file) => {
    const source = fs.readFileSync(file, "utf8")
      .replace(/\brequire\((["'])([^"']+)\1\)/g, (_, _quote, target) => `require(${ids.get(required(file, target))})`);
    return `function (module, exports, require) {\n${source}\n}`;
  });
  const banner = vendorPackages(name).map(({ name, version, license }) => `${name} ${version} (${license})`).join(", ");
  const body = `/*! Bundles ${banner}. Licences and notices: ${NOTICES_URL} */
const factories = [${factories.join(",\n")}], loaded = [];
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
