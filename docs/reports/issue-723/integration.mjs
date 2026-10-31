// Current-main diagnostic integration, never a production content adoption.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

const [batchArg = 'test-results/issue-723-WqVFAg/batch', output = 'docs/reports/issue-723/integration.json'] = process.argv.slice(2);
if (fs.existsSync(output)) throw Error(`Refusing existing report: ${output}`);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024 });
const revision = git('rev-parse', 'forgejo/main').toString().trim();
if (!revision.startsWith('5d81668')) throw Error(`Review newer main before running: ${revision}`);
const scratch = fs.mkdtempSync(path.resolve('test-results/issue-723-integration-'));
const root = path.join(scratch, 'current-main'), archive = path.join(scratch, 'main.tar');
fs.mkdirSync(root);
git('archive', `--output=${archive}`, revision);
execFileSync('tar', ['-xf', archive, '-C', root]);
const walk = (directory, prefix = '') => fs.readdirSync(path.join(directory, prefix), { withFileTypes: true })
  .flatMap(e => e.isDirectory() ? walk(directory, `${prefix}${e.name}/`) : [`${prefix}${e.name}`]);
const mainSource = Object.fromEntries(['map', 'shared', 'server', 'public'].flatMap(d => walk(root, `${d}/`))
  .map(f => [f, hash(fs.readFileSync(path.join(root, f)))]));
const batch = path.resolve(batchArg);
const sourceFiles = ['map/micro/geometry.ts', ...['boundary-content', 'content-access', 'depot', 'market'].map(n => `map/micro/strategies/${n}.ts`)];
const diagnostics = ['tests/micro-content-access.test.js', 'tests/micro-depot-boundary.test.js', 'tests/micro-market.test.js',
  ...fs.readdirSync(path.join(batch, 'tools')).filter(f => /^incidental-.*\.mjs$/.test(f)).map(f => `tools/${f}`)];
const depotMain = fs.readFileSync(path.join(root, 'map/micro/strategies/depot.ts'), 'utf8');
const sourcePins = {};
for (const file of [...sourceFiles, ...diagnostics]) {
  const target = path.join(root, file), original = fs.existsSync(target) ? fs.readFileSync(target) : null;
  const fromBatch = fs.readFileSync(path.join(batch, file));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, fromBatch);
  sourcePins[file] = { main: original && hash(original), batch: hash(fromBatch) };
}
// Only depot.ts needs reconciliation: retain main's #584 presentation adoption verbatim.
const depotPath = path.join(root, 'map/micro/strategies/depot.ts');
let depot = fs.readFileSync(depotPath, 'utf8');
const appearanceImport = depotMain.match(/^import type \{ BuildingAppearance \}.*$/m)?.[0];
const descriptorStart = depotMain.search(/\/\*\*\r?\n \* Authored minimal appearance descriptor/);
const catalogueStart = depotMain.indexOf('/** The catalogue');
if (!appearanceImport || descriptorStart < 0 || catalogueStart < descriptorStart) throw Error('Main depot appearance contract changed');
depot = depot.replace("import { builtRegion }", `${appearanceImport}\nimport { builtRegion }`);
depot = depot.replace('/** The catalogue', depotMain.slice(descriptorStart, catalogueStart) + '/** The catalogue');
const buildArgs = 'alongX, seed }, size)';
if (depot.split(buildArgs).length !== 2) throw Error('Prototype warehouse build contract changed');
depot = depot.replace(buildArgs, "alongX, seed, appearance: DEPOT_WAREHOUSE_APPEARANCE, shelfAppearance: { material: 'oxidizedMetal' } }, size)");
fs.writeFileSync(depotPath, depot);
for (const file of Object.keys(sourcePins)) sourcePins[file].integrated = hash(fs.readFileSync(path.join(root, file)));
// Audit every main source against the extracted tree, permitting only the five explicit overlays.
const changedSource = [];
for (const [file, expected] of Object.entries(mainSource)) {
  if (hash(fs.readFileSync(path.join(root, file))) !== expected) changedSource.push(file);
}
const permittedChanged = sourceFiles.filter(f => fileExistsOnMain(f)).sort();
function fileExistsOnMain(file) { return Object.hasOwn(mainSource, file); }
if (JSON.stringify(changedSource.sort()) !== JSON.stringify(permittedChanged)) throw Error(`Unexpected changed main source: ${changedSource}`);
const addedSource = ['map', 'shared', 'server', 'public'].flatMap(d => walk(root, `${d}/`)).filter(f => !fileExistsOnMain(f)).sort();
if (JSON.stringify(addedSource) !== JSON.stringify(sourceFiles.filter(f => !fileExistsOnMain(f)).sort())) throw Error(`Unexpected added source: ${addedSource}`);
const corpusBytes = fs.readFileSync(path.join(batch, 'docs/reports/issue-716/frozen-corpus.json.gz'));
const corpus = JSON.parse(gunzipSync(corpusBytes));
const report = { status: 'running', scope: 'Current main plus diagnostic #716 feature/search overlays; no version bump or adoption',
  mainRevision: revision, mainArchiveSha256: hash(fs.readFileSync(archive)), node: process.version,
  corpusSha256: hash(corpusBytes), scratch, sourcePins, changedExistingMainSource: changedSource, addedSource,
  preservedMainSource: ['map/micro/placeables/warehouse.ts', 'map/micro/building/realize.ts', 'map/micro/sdk.ts', 'map/micro/region-types.ts'], direct: [], parents: [], tests: [] };
const save = () => fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
fs.writeFileSync(output, '', { flag: 'wx' });
const body = ({ elements, loot, coreElements, manifest }) => ({ elements, loot, coreElements, manifest });
const project = value => Array.isArray(value) ? value.map(project) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'appearance').map(([k, v]) => [k, project(v)])) : value;
const appearances = (value, prefix = '', found = {}) => {
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    if (key === 'appearance') found[`${prefix}/${key}`] = hash(JSON.stringify(child));
    else appearances(child, `${prefix}/${key}`, found);
  }
  return found;
};
try {
  const { buildRegion } = await import(pathToFileURL(path.join(root, 'map/micro/region-types.ts')));
  for (const [label, rows] of [['direct', corpus.rows], ['parents', corpus.additionalParentRows]]) {
    for (const row of rows) {
      if (hash(JSON.stringify(row.expected)) !== row.sha256) throw Error(`Corrupt historical expectation: ${row.seed}/${row.brief.id}`);
      const actual = body(buildRegion(structuredClone(row.brief)));
      const expectedAppearance = appearances(row.expected), actualAppearance = appearances(actual);
      const paths = new Set([...Object.keys(expectedAppearance), ...Object.keys(actualAppearance)]);
      const result = { seed: row.seed, id: row.brief.id, historicalFullSha256: row.sha256, integratedFullSha256: hash(JSON.stringify(actual)),
        expectedProjectionSha256: hash(JSON.stringify(project(row.expected))), actualProjectionSha256: hash(JSON.stringify(project(actual))),
        appearance: { expected: Object.keys(expectedAppearance).length, actual: Object.keys(actualAppearance).length,
          differences: [...paths].filter(p => expectedAppearance[p] !== actualAppearance[p]).length } };
      report[label].push(result); save();
      if (result.expectedProjectionSha256 !== result.actualProjectionSha256) throw Error(`Structural output drift: ${row.seed}/${row.brief.id}`);
    }
    console.log(`${label}: ${rows.length} exact appearance-stripped matches`);
  }
  const selections = [
    ['--test-name-pattern=existing depot region strategy adopts', 'tests/appearance-descriptor.test.js'],
    ['--test-name-pattern=^(?!.*macro).*', 'tests/micro-content-access.test.js', 'tests/micro-market.test.js', 'tests/micro-depot-boundary.test.js'],
  ];
  for (const selection of selections) {
    const args = ['--test', '--test-concurrency=1', ...selection];
    const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const stdout = result.stdout ?? '', stderr = result.stderr ?? '';
    report.tests.push({ command: [process.execPath, ...args], exitCode: result.status, stdout, stderr }); save();
    console.log(stdout); if (stderr) console.error(stderr);
    if (result.status !== 0) throw Error(`Focused integration tests failed: ${selection}`);
  }
  report.status = 'complete';
} catch (error) {
  report.status = 'failed'; report.error = String(error); throw error;
} finally { save(); }
