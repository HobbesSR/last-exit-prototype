import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureJellyWitnesses } from './jelly.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export async function playbackHtml(recording) {
  const source = await readFile(new URL('./jelly-playback.mjs', import.meta.url), 'utf8');
  const data = JSON.stringify(recording).replaceAll('<', '\\u003c');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Jelly and player squish lab</title><style>
body{margin:22px auto;padding:0 20px;max-width:960px;background:#0c1722;color:#e6f3f4;font:16px system-ui}
h1{font-size:26px}button,select,input{font:inherit}button,select{background:#24404d;color:#fff;border:1px solid #75969d;border-radius:5px;padding:5px 9px;cursor:pointer}
.controls{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin:16px 0}#tick{width:min(350px,65vw)}
canvas{width:100%;background:#102333;border:1px solid #47616e;border-radius:8px}output{display:block;color:#9debd4;margin:12px 0}
pre{font:12px/1.4 monospace;white-space:pre-wrap;overflow:auto;max-height:300px;color:#b6d1d6}
</style><h1>Jelly and player squish lab</h1>
<p>Retained geometry and a provisional lab crush signal. This recording does not define gameplay damage or death.</p>
<div class="controls"><label>Witness <select id="witness" aria-label="Witness"></select></label>
<label>Tick <input id="tick" aria-label="Tick" type="range" min="0" value="0"></label>
<button id="play" type="button">Play</button><button id="reset" type="button">Reset</button>
<label>Speed <select id="speed" aria-label="Speed"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="4">4×</option></select></label>
<button id="export" type="button">Export JSON</button></div>
<output></output><canvas width="800" height="420" aria-label="Jelly and compression geometry"></canvas>
<p>Mint: deformable ring and nodes. Gold outline: fixed solid core. Blue: player visual squish. The threshold indicator is lab only.</p>
<pre></pre><script type="module">${source}\nmountPlayback(${data});</script></html>`;
}

export async function writeJellyReport(output = path.join(root, 'test-results/physics-jelly.json')) {
  const recording = await captureJellyWitnesses();
  const sourceSha256 = {};
  for (const file of ['jelly.mjs', 'jelly-playback.mjs', 'jelly-report.mjs', 'rapier.mjs', 'metrics.mjs']) {
    sourceSha256[`tools/physics/${file}`] = digest((await readFile(new URL(file, import.meta.url), 'utf8')).replaceAll('\r\n', '\n'));
  }
  const packageSource = (await readFile(path.join(root, 'package.json'), 'utf8')).replaceAll('\r\n', '\n');
  sourceSha256['package.json'] = digest(packageSource);
  sourceSha256['package-lock.json'] = digest((await readFile(path.join(root, 'package-lock.json'), 'utf8')).replaceAll('\r\n', '\n'));
  const wasm = path.join(root, 'node_modules/@dimforge/rapier2d-compat/dist/rapier_wasm2d_bg.wasm');
  try { sourceSha256['node_modules/@dimforge/rapier2d-compat/dist/rapier_wasm2d_bg.wasm'] = digest(await readFile(wasm)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const report = { ...recording,
    runtime: { node: process.version, platform: process.platform, arch: process.arch,
      rapierVersion: JSON.parse(packageSource).dependencies['@dimforge/rapier2d-compat'] },
    sourceHashEncoding: 'utf8-lf (WASM raw bytes)', sourceSha256,
    traceSha256: digest(JSON.stringify(recording.witnesses)) };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  await writeFile(output.replace(/\.json$/, '') + '.html', await playbackHtml(report));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = path.resolve(process.argv[2] ?? path.join(root, 'test-results/physics-jelly.json'));
  const report = await writeJellyReport(output);
  console.log(`${output}\n${report.witnesses.length} retained witnesses; traceSha256 ${report.traceSha256}`);
}
