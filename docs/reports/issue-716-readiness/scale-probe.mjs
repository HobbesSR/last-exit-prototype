// Copy a complete #724 prototype snapshot, add diagnostic-only access counters,
// then make one isolated attempt at the original macro-sized depot witness.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const [sourceArg, snapshotArg, outputArg] = process.argv.slice(2);
if (!sourceArg || !snapshotArg || !outputArg || process.argv.length !== 5)
  throw new Error('Usage: node scale-probe.mjs SOURCE NEW_SNAPSHOT NEW_OUTPUT');
const source = path.resolve(sourceArg), snapshot = path.resolve(snapshotArg), output = path.resolve(outputArg);
if (!fs.statSync(source).isDirectory()) throw new Error('SOURCE must be a directory.');
if (fs.existsSync(snapshot) || fs.existsSync(output)) throw new Error('NEW_SNAPSHOT and NEW_OUTPUT must not already exist.');
const within = (parent, child) => child.startsWith(parent + path.sep);
if (source === snapshot || source === output || snapshot === output || within(source, snapshot) || within(snapshot, source)
  || within(source, output) || within(output, source) || within(snapshot, output) || within(output, snapshot))
  throw new Error('SOURCE, NEW_SNAPSHOT, and NEW_OUTPUT must be separate, non-nested paths.');

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceFiles = [
  'map/micro/strategies/content-access.ts', 'map/micro/route-clearance.ts', 'map/micro/geometry.ts',
  'map/micro/strategies/depot.ts', 'map/micro/canvas.ts', 'tests/micro-depot.test.js',
  'tests/helpers/budget.js', 'tests/helpers/machine-lock.js', 'package.json',
];
const sourceHashes = Object.fromEntries(sourceFiles.map(file => [file, hash(fs.readFileSync(path.join(source, file)))]));
fs.cpSync(source, snapshot, { recursive: true, errorOnExist: true });

function replaceOnce(text, before, after, label = before.slice(0, 90)) {
  const at = text.indexOf(before);
  if (at < 0 || text.indexOf(before, at + before.length) >= 0) throw new Error(`Expected exactly one instrumentation anchor: ${label}`);
  return text.slice(0, at) + after + text.slice(at + before.length);
}
function editContentAccess(transform) {
  const file = path.join(snapshot, 'map/micro/strategies/content-access.ts');
  const original = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  fs.writeFileSync(file, transform(original));
}

editContentAccess(text => {
  text = replaceOnce(text,
    'export function createContentAccess(brief: RegionBrief, initialBlockers: readonly Shape[], initialTargets: readonly Vec2[] = []): ContentAccessResult {\n',
    `export function createContentAccess(brief: RegionBrief, initialBlockers: readonly Shape[], initialTargets: readonly Vec2[] = []): ContentAccessResult {\n  const diagnosticInitStarted = performance.now();\n  let diagnosticInitEnded = false, diagnosticInitialRouteCalls = 0, diagnosticInitialRouteMs = 0;\n  let diagnosticPrepareCalls = 0, diagnosticAccepted = 0;\n  const diagnosticLog = (entry: unknown) => process.stderr.write(JSON.stringify(entry) + '\\n');\n  const diagnosticInitEnd = () => {\n    if (diagnosticInitEnded) return;\n    diagnosticInitEnded = true;\n    diagnosticLog({ type: 'content-access-init-end', ms: performance.now() - diagnosticInitStarted,\n      initialRouteCalls: diagnosticInitialRouteCalls, initialRouteMs: diagnosticInitialRouteMs });\n  };\n  diagnosticLog({ type: 'content-access-init-start' });\n`);
  text = replaceOnce(text, "if (blockers.some(s => !validShape(s))) return { ok: false, reason: 'Invalid initial collision shape.' };",
    "if (blockers.some(s => !validShape(s))) { diagnosticInitEnd(); return { ok: false, reason: 'Invalid initial collision shape.' }; }");
  text = replaceOnce(text, "if (stands.some(p => !clear(p, blockers))) return { ok: false, reason: 'Initial portal stand is obstructed.' };",
    "if (stands.some(p => !clear(p, blockers))) { diagnosticInitEnd(); return { ok: false, reason: 'Initial portal stand is obstructed.' }; }");
  text = replaceOnce(text, "if (portals.length >= 2 && portals.some(p => !p.points.length)) return { ok:false, reason:'Initial portal is too short for a hunter.' };",
    "if (portals.length >= 2 && portals.some(p => !p.points.length)) { diagnosticInitEnd(); return { ok:false, reason:'Initial portal is too short for a hunter.' }; }");
  text = replaceOnce(text,
    "  const initialRoute = (a: Vec2, b: Vec2): Vec2[] | null => createRegionRouteSearch(mask, blockers, a, radius, undefined, clearance.accepted())(b) ?? knownRoute(a, b);",
    `  const initialRoute = (a: Vec2, b: Vec2): Vec2[] | null => {\n    const started = performance.now();\n    try { return createRegionRouteSearch(mask, blockers, a, radius, undefined, clearance.accepted())(b) ?? knownRoute(a, b); }\n    finally { diagnosticInitialRouteCalls++; diagnosticInitialRouteMs += performance.now() - started; }\n  };`);
  text = replaceOnce(text, "if (!route) return { ok: false, reason: 'Initial portal stands lack a connecting witness.' };",
    "if (!route) { diagnosticInitEnd(); return { ok: false, reason: 'Initial portal stands lack a connecting witness.' }; }");
  text = replaceOnce(text, "if (!route) return { ok: false, reason: 'Initial nearby portals lack a connecting witness.' };",
    "if (!route) { diagnosticInitEnd(); return { ok: false, reason: 'Initial nearby portals lack a connecting witness.' }; }");
  text = replaceOnce(text, "if (!entrances) return { ok: false, reason: 'Initial entrance target lacks clear portal access.' };",
    "if (!entrances) { diagnosticInitEnd(); return { ok: false, reason: 'Initial entrance target lacks clear portal access.' }; }");
  text = replaceOnce(text, '  return { ok: true, guard: {\n    prepare(addedBlockers, addedTargets = []) {',
    `  diagnosticInitEnd();\n  return { ok: true, guard: {\n    prepare(addedBlockers, addedTargets = []) {\n      const diagnosticStarted = performance.now(), diagnosticCall = ++diagnosticPrepareCalls;\n      try {`);
  text = replaceOnce(text,
    '        index.add(added); blockers = nextBlockers; targets = nextTargets; proof = nextProof; version++;',
    '        index.add(added); blockers = nextBlockers; targets = nextTargets; proof = nextProof; version++; diagnosticAccepted++;');
  text = replaceOnce(text,
    '      } };\n    },\n  } };\n}',
    `      } };\n      } finally {\n        const diagnosticMs = performance.now() - diagnosticStarted;\n        if (diagnosticCall % 25 === 0 || diagnosticMs > 100) diagnosticLog({ type: 'content-access-prepare', call: diagnosticCall,\n          ms: diagnosticMs, accepted: diagnosticAccepted, proofLength: proof.length,\n          sweptShapes: proof.reduce((sum, item) => sum + item.swept.length, 0) });\n      }\n    },\n  } };\n}`,
    'guard.prepare try/finally tail');
  return text;
});

const instrumentedHash = hash(fs.readFileSync(path.join(snapshot, sourceFiles[0])));
const sourceHashRecord = { source, snapshot, files: sourceHashes,
  instrumented: { 'map/micro/strategies/content-access.ts': instrumentedHash } };

const lockModule = pathToFileURL(path.join(snapshot, 'tests/helpers/machine-lock.js')).href;
const { acquireMachineLock } = await import(lockModule);
const lock = await acquireMachineLock('bench', { timeoutMs: 10 * 60_000, pollMs: 2_000 });
let stdout = '', stderr = '', spawnError = null, timedOut = false, exitCode = null, signal = null;
const startedAt = new Date().toISOString(), started = performance.now();
try {
  const child = spawn(process.execPath, ['--test', '--test-isolation=none', '--test-name-pattern=a macro-sized depot with hundreds of portals builds quickly', 'tests/micro-depot.test.js'], {
    cwd: snapshot, env: { ...process.env, BUILD_BUDGETS: 'enforce' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 10_000);
  await new Promise(resolve => {
    child.once('error', error => { spawnError = { name: error.name, message: error.message, code: error.code }; });
    child.once('close', (code, childSignal) => { exitCode = code; signal = childSignal; resolve(); });
  });
  clearTimeout(timer);
} finally { lock.release(); }

fs.mkdirSync(output);
const status = { startedAt, elapsedMs: performance.now() - started, exitCode, signal, timedOut, spawnError,
  command: [process.execPath, '--test', '--test-isolation=none', '--test-name-pattern=a macro-sized depot with hundreds of portals builds quickly', 'tests/micro-depot.test.js'],
  cwd: snapshot, BUILD_BUDGETS: 'enforce', lock: 'bench', timeoutMs: 10_000 };
const note = `# Issue 716 access scale probe\n\nOne diagnostic-only attempt against the copied #724 prototype snapshot. ` +
  `Instrumentation adds synchronous stderr records, so this run is for attribution only and is not a performance claim. ` +
  `The probe ran the existing 200 × 150 depot witness once with BUILD_BUDGETS=enforce under the bench machine lock, ` +
  `with a 10 second child timeout.\n\nOutcome: ${timedOut ? 'timed out' : exitCode === 0 ? 'completed successfully' : 'did not complete successfully'}; ` +
  `exit code ${exitCode}; signal ${signal ?? 'none'}; elapsed ${status.elapsedMs.toFixed(1)} ms.\n`;
for (const [name, data] of [
  ['stdout.txt', stdout], ['stderr.txt', stderr], ['error.json', JSON.stringify(spawnError, null, 2) + '\n'],
  ['status.json', JSON.stringify(status, null, 2) + '\n'], ['source-hashes.json', JSON.stringify(sourceHashRecord, null, 2) + '\n'],
  ['diagnostic-note.md', note],
]) fs.writeFileSync(path.join(output, name), data, { flag: 'wx' });
