import { parentPort, workerData } from 'node:worker_threads';
import { createWriteStream } from 'node:fs';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createFrameEncoder } from '../shared/recording-format.ts';

// Production owns its file here. Injected Writable streams stay in the caller's
// thread; their bridge allows only one compressed chunk awaiting acknowledgement.
let bridgeWrite, bridgeFinish, failed = false;
const output = workerData.outputPath !== undefined ? createWriteStream(workerData.outputPath) : new Writable({
  write(chunk, _encoding, next) {
    bridgeWrite = next;
    const bytes = Uint8Array.from(chunk);
    parentPort.postMessage({ type: 'chunk', bytes }, [bytes.buffer]);
  },
  final(next) { bridgeFinish = next; parentPort.postMessage({ type: 'output-end' }); }
});
const gzip = createGzip(workerData.gzipOptions), hash = createHash('sha256');
const recording = pipeline(gzip, output);
// The worker owns the stored form (26, shared/recording-format.ts): each frame becomes a keyframe or a
// delta against the previous stored frame, and every few keyframes a checkpoint of a rebuilt frame.
const encoder = createFrameEncoder(workerData.keyframeEvery ? { keyframeEvery: workerData.keyframeEvery } : {});
const kept = {}, queue = [], checkpoints = [];
let writing = false, ending = false;
const sha256 = text => createHash('sha256').update(text).digest('hex');
function fail(error) {
  if (failed) return;
  failed = true;
  parentPort.postMessage({ type: 'failure', error });
  gzip.destroy(error); output.destroy(error);
  parentPort.close();
}
recording.catch(fail);
function stored(encoded) {
  if (encoded.checkpoint) checkpoints.push({ frame: encoded.checkpoint.frame, sha256: sha256(encoded.checkpoint.line) });
  hash.update(encoded.text); hash.update('\n');
  return `${encoded.text}\n`;
}
function pump() {
  if (failed || writing) return;
  const message = queue.shift();
  if (!message) { if (ending) gzip.end(); return; }
  let text = message.text;
  if (message.type === 'frame') {
    Object.assign(kept, message.updates);
    text = stored(message.line !== undefined ? encoder.whole(message.line)
      : encoder.encode({ entries: message.entries.map(([key, json]) => [key, json ?? kept[key]]), commands: message.commands }));
  } else if (message.type === 'finish') {
    const last = encoder.close();
    if (last) checkpoints.push({ frame: last.frame, sha256: sha256(last.line) });
    text = `{"end":{"checkpoints":${JSON.stringify(checkpoints)}${message.fields ? `,${message.fields}` : ''}}}\n`;
  }
  writing = true;
  gzip.write(text, error => {
    writing = false;
    if (error) { fail(error); return; }
    parentPort.postMessage({ type: 'ack', bytes: message.bytes });
    try { pump(); } catch (error) { fail(error); }
  });
}
parentPort.on('message', message => {
  if (failed) return;
  try {
    if (message.type === 'chunk-ack') { const next = bridgeWrite; bridgeWrite = null; next?.(); }
    else if (message.type === 'output-finished') { const next = bridgeFinish; bridgeFinish = null; next?.(); }
    else if (message.type === 'finish') { queue.push(message); ending = true; pump(); }
    else { queue.push(message); pump(); }
  } catch (error) { fail(error); }
});
recording.then(() => {
  if (failed) return;
  parentPort.postMessage({ type: 'done', sha256: hash.digest('hex') });
  parentPort.close();
}, () => {});
