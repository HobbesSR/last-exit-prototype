import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureWitnesses } from './ballistic-witness.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
export async function playbackHtml(recording) {
  const module = await readFile(new URL('./ballistic-playback.mjs', import.meta.url), 'utf8');
  const data = JSON.stringify(recording).replaceAll('<', '\\u003c');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Thrown-item ballistic lab</title><style>
body{margin:24px auto;padding:0 20px;max-width:900px;background:#101923;color:#e6eeef;font:16px system-ui}
h1{font-size:26px}select,input{margin:8px;font:inherit}canvas{width:100%;background:#101923;border:1px solid #39505c;border-radius:8px}
output{display:block;color:#ffd36b;margin:12px 0}pre{font:13px monospace;white-space:pre-wrap;color:#a7becb}
</style><h1>Thrown-item ballistic lab</h1><p>Retained trajectory playback · provisional lab profile · no live gameplay</p>
<label>Witness <select aria-label="Witness"></select></label><label>Tick <input aria-label="Tick" type="range" min="0" value="0"></label>
<output></output><canvas width="800" height="420" aria-label="Thrown cube above its ground shadow"></canvas>
<p>Gold: thrown cube. Dark oval: ground shadow. Teal: height. Brown: explicit solid height interval. Dashed outline: decorative roof.</p>
<pre></pre><script type="module">${module}\nmountPlayback(${data});</script></html>`;
}

export async function writeBallisticReport(output) {
  const recording = captureWitnesses();
  const sourceSha256 = {};
  for (const file of ['ballistics.mjs', 'ballistic-witness.mjs', 'ballistic-playback.mjs', 'ballistic-report.mjs'])
    sourceSha256[`tools/physics/${file}`] = createHash('sha256')
      .update((await readFile(new URL(file, import.meta.url), 'utf8')).replaceAll('\r\n', '\n')).digest('hex');
  const report = { ...recording, sourceHashEncoding: 'utf8-lf', sourceSha256,
    traceSha256: createHash('sha256').update(JSON.stringify(recording.witnesses)).digest('hex') };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  await writeFile(output.replace(/\.json$/, '') + '.html', await playbackHtml(report));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = path.resolve(process.argv[2] ?? path.join(root, 'test-results/physics-p7.json'));
  const report = await writeBallisticReport(output);
  console.log(`${output}\n${report.witnesses.length} retained witnesses; traceSha256 ${report.traceSha256}`);
}
