import { parentPort, workerData } from 'node:worker_threads';
import { createWriteStream } from 'node:fs';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { createHash } from 'node:crypto';

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
const kept = {}, queue = [];
let writing = false, frames = 0, ending = false;
function fail(error) {
  if (failed) return;
  failed = true;
  parentPort.postMessage({ type: 'failure', error });
  gzip.destroy(error); output.destroy(error);
  parentPort.close();
}
recording.catch(fail);
function pump() {
  if (failed || writing) return;
  const message = queue.shift();
  if (!message) { if (ending) gzip.end(); return; }
  let text = message.text;
  if (message.type === 'frame') {
    Object.assign(kept, message.updates);
    const line = message.line ?? `{"state":{${message.parts.map(part => typeof part === 'string' ? part : `"${part.kept}":${kept[part.kept]}`).join(',')}${message.tail}`;
    const comma = frames ? 1 : 0;
    const encoded = Buffer.allocUnsafe(message.bytes);
    if (comma) encoded[0] = 0x2c;
    if (encoded.write(line, comma) !== message.bytes - comma) throw new Error('Replay frame length does not match its encoding');
    hash.update(encoded.subarray(comma)); hash.update('\n'); frames++;
    text = encoded;
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
