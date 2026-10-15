/** Offline authoring check for the #214 block/depot/compound inward grounds (52).
 *
 * node map/tools/author-inward-grounds.mts --primitives PATH --common PATH --district PATH [--local-library PATH] [--check]
 * node map/tools/author-inward-grounds.mts --primitives PATH --common PATH --district PATH [--local-library PATH] --out-dir DIR
 *
 * The default is read-only. Regeneration always writes separate module copies.
 */
import { readFileSync, mkdirSync, writeFileSync, realpathSync, existsSync } from 'node:fs';
import { resolve, join, basename, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { CHAIN_LIBRARY_VERSION } from '../macro/src/chain/library.ts';

const KINDS = ['block', 'compound', 'depot'] as const;
type Kind = typeof KINDS[number];
type Json = Record<string, any>;
const SIDES = [
  { letter: 'n', dx: 0, dy: -1, key: (i: number) => `h:0,${i}` },
  { letter: 'e', dx: 1, dy: 0, key: (i: number) => `v:6,${i}` },
  { letter: 's', dx: 0, dy: 1, key: (i: number) => `h:6,${i}` },
  { letter: 'w', dx: -1, dy: 0, key: (i: number) => `v:0,${i}` },
] as const;
const copy = <T,>(value: T): T => structuredClone(value);
const generatedTile = (id: string) => KINDS.some(kind => id.startsWith(`${kind}-ground-inward-`));
const generatedSet = (id: string) => KINDS.some(kind => id.startsWith(`${kind}-ground-inward-`));
const originalSet = (kind: Kind) => `${kind}-grounds`;

function reinsertGenerated(items: Json[], generated: Json[], isGenerated: (id: string) => boolean): Json[] {
  const first = items.findIndex(item => isGenerated(item.id));
  const before = (first < 0 ? items : items.slice(0, first)).filter(item => !isGenerated(item.id)).length;
  const authored = items.filter(item => !isGenerated(item.id));
  return [...authored.slice(0, before), ...generated, ...authored.slice(before)];
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function read(path: string): Json {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  expect(value && typeof value === 'object', `${path}: expected JSON object`);
  return value;
}

function options(argv: string[]) {
  const values = new Map<string, string>();
  let check = false;
  for (let i = 0; i < argv.length;) {
    const flag = argv[i];
    if (flag === '--check') { expect(!check, 'duplicate --check'); check = true; i++; continue; }
    expect(['--primitives', '--common', '--district', '--local-library', '--out-dir'].includes(flag) && argv[i + 1] && !values.has(flag),
      `invalid arguments; use --primitives PATH --common PATH --district PATH [--local-library PATH] [--check | --out-dir DIR]`);
    values.set(flag, argv[i + 1]);
    i += 2;
  }
  for (const flag of ['--primitives', '--common', '--district']) expect(values.has(flag), `missing ${flag}`);
  expect(!(check && values.has('--out-dir')), '--check cannot be combined with --out-dir');
  return {
    files: [values.get('--primitives')!, values.get('--common')!, values.get('--district')!,
      values.get('--local-library')].filter((file): file is string => file !== undefined).map(file => resolve(file)),
    outDir: values.has('--out-dir') ? resolve(values.get('--out-dir')!) : undefined,
  };
}

function identity(module: Json, name: string): void {
  expect(module.schema === 1 && module.name === name && Number.isSafeInteger(module.version) && module.version > 0,
    `expected ${name} schema 1 with a positive integer content version`);
}

function author(primitives: Json, blueprints: Json[]): { modules: Json[]; variants: number; references: number } {
  identity(primitives, 'common-primitives');
  identity(blueprints[0], 'common-set-pieces');
  identity(blueprints[1], 'district-set-pieces');
  // A top-level library's version is its file format, not an authored content revision.
  if (blueprints[2]) expect(typeof blueprints[2].name === 'string' && blueprints[2].version === CHAIN_LIBRARY_VERSION,
    `expected a named local library of format version ${CHAIN_LIBRARY_VERSION}`);
  expect(Array.isArray(primitives.tiles) && Array.isArray(primitives.tileSets), 'missing primitive tiles or tile sets');
  for (const blueprint of blueprints) {
    expect(Array.isArray(blueprint.setPieces), `${blueprint.name}: missing set pieces`);
    expect(blueprint.includes?.some((ref: Json) => ref.name === 'common-primitives' && ref.version === primitives.version),
      `${blueprint.name}: expected common-primitives@${primitives.version} include`);
  }
  const tiles = primitives.tiles.filter((tile: Json) => !generatedTile(tile.id));
  const sets = primitives.tileSets.filter((set: Json) => !generatedSet(set.id));
  const originals = new Map<Kind, Json>();
  for (const kind of KINDS) {
    const matches = tiles.filter((tile: Json) => tile.id === `${kind}-ground`);
    expect(matches.length === 1, `expected one ${kind}-ground original`);
    const original = matches[0];
    expect(original.defaultCellClass === kind && isDeepStrictEqual(original.orientations, [0]) && original.weight === 0,
      `${kind}-ground original class/orientation/weight changed`);
    expect(original.segments && typeof original.segments === 'object', `${kind}-ground has no segments`);
    for (const side of SIDES) for (let i = 0; i < 6; i++) {
      expect(original.segments[side.key(i)] && Object.hasOwn(original.segments[side.key(i)], 'passability'),
        `${kind}-ground original perimeter lacks passability at ${side.letter}:${i}`);
    }
    originals.set(kind, original);
    const originalSets = sets.filter((set: Json) => set.id === originalSet(kind));
    expect(originalSets.length === 1 && isDeepStrictEqual(originalSets[0].members, [`${kind}-ground`]),
      `expected one ${originalSet(kind)} singleton original set`);
  }
  const used = new Set<string>();
  let references = 0;
  const outputBlueprints = blueprints.map(blueprint => {
    const result = copy(blueprint);
    for (const piece of result.setPieces) {
      const byPosition = new Map<string, Json>(piece.tiles.map((slot: Json) => [`${slot.dx},${slot.dy}`, slot]));
      expect(byPosition.size === piece.tiles.length, `${piece.id}: duplicate slot coordinate`);
      const kindAt = (slot: Json | undefined): Kind | undefined => {
        if (!slot || typeof slot.tileSetId !== 'string') return undefined;
        return KINDS.find(kind => slot.tileSetId === originalSet(kind) ||
          slot.tileSetId.startsWith(`${kind}-ground-inward-`));
      };
      for (const slot of piece.tiles) {
        const kind = kindAt(slot);
        if (!kind) continue;
        expect(!('orientation' in slot) || slot.orientation === 0,
          `${piece.id} (${slot.dx},${slot.dy}): target slot orientation must be 0`);
        const mask = SIDES.filter(side => kindAt(byPosition.get(`${slot.dx + side.dx},${slot.dy + side.dy}`)) === kind)
          .map(side => side.letter).join('');
        const tileId = mask ? `${kind}-ground-inward-${mask}` : `${kind}-ground`;
        slot.tileSetId = mask ? `${tileId}-tiles` : originalSet(kind);
        if (mask) {
          const key = `${kind}:${mask}`;
          used.add(key);
          references++;
        }
      }
    }
    return result;
  });
  const variants: Json[] = [], variantSets: Json[] = [];
  for (const kind of KINDS) for (const mask of [...used].filter(key => key.startsWith(`${kind}:`)).map(key => key.split(':')[1]).sort()) {
    const id = `${kind}-ground-inward-${mask}`;
    const variant = copy(originals.get(kind)!);
    variant.id = id;
    variant.weight = 0;
    variant.orientations = [0];
    for (const side of SIDES) if (mask.includes(side.letter)) for (let i = 0; i < 6; i++) {
      variant.segments[side.key(i)] = { ...variant.segments[side.key(i)], passability: 'not-passable-hint' };
    }
    variants.push(variant);
    variantSets.push({ id: `${id}-tiles`, members: [id] });
  }
  const outputPrimitives = copy(primitives);
  outputPrimitives.tiles = reinsertGenerated(primitives.tiles, variants, generatedTile);
  outputPrimitives.tileSets = reinsertGenerated(primitives.tileSets, variantSets, generatedSet);
  return { modules: [outputPrimitives, ...outputBlueprints], variants: variants.length, references };
}

function safeOutputs(inputs: string[], dir: string): string[] {
  const paths = inputs.map(file => join(dir, basename(file)));
  expect(new Set(paths).size === paths.length, 'output basenames collide');
  for (const path of paths) for (const input of inputs) {
    const outputParent = existsSync(dirname(path)) ? realpathSync(dirname(path)) : resolve(dirname(path));
    const outputActual = existsSync(path) ? realpathSync(path) : join(outputParent, basename(path));
    expect(outputActual !== realpathSync(input), `refusing to overwrite input ${input}`);
  }
  for (const path of paths) expect(!existsSync(path), `refusing to overwrite existing output ${path}`);
  return paths;
}

export function run(argv: string[]): void {
  const { files, outDir } = options(argv);
  const source = files.map(read);
  const { modules: generated, variants, references } = author(source[0], source.slice(1));
  if (outDir) {
    const outputs = safeOutputs(files, outDir);
    mkdirSync(outDir, { recursive: true });
    outputs.forEach((file, index) => writeFileSync(file, `${JSON.stringify(generated[index], null, 2)}\n`, { flag: 'wx' }));
    console.log(`Wrote ${variants} inward variants and ${references} blueprint references to ${outputs.join(', ')}`);
  } else {
    for (let i = 0; i < files.length; i++) {
      expect(isDeepStrictEqual(source[i], generated[i]), `${files[i]} differs from regenerated inward grounds or slot references`);
    }
    console.log(`${variants} inward variants and ${references} blueprint references match their originals.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { run(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
