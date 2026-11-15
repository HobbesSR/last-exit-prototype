import { Worker } from 'node:worker_threads';
import { itemsJson } from '../shared/simulation/ground-items.ts';
import { gatesJson } from '../shared/simulation/frame-gates.ts';
import { stringifyWithMap } from './map-payload.js';
import { FRAME_ENCODING, KEYFRAME_EVERY, frameText } from '../shared/recording-format.ts';

// Without an explicit budget the queue holds the larger of 8 MiB and the header (which carries the map) plus four frames
// of the size being appended, so a larger map's frames are not all dropped (a 72x36 frame is about 3.3 MiB, 42.22); see 26.
const DEFAULT_QUEUE_BYTES = 8 * 1024 * 1024, DEFAULT_QUEUE_FRAMES = 4;
const DEFAULT_FINALIZE_TIMEOUT_MS = 5000;
// Diagnostic markers ride in a trailer, bounded like the frame queue; see docs/26.
export const MAX_DIAGNOSTIC_MARKS = 512;
const asError = error => error instanceof Error ? error : new Error(String(error));
const aborted = signal => { if (signal?.aborted) throw asError(signal.reason || 'Replay recording was aborted'); };

// A frame as its state's top-level keys with their JSON, and its commands' JSON, from which the worker
// stores a keyframe or a delta (26, shared/recording-format.ts). The ground items and gates come from the
// JSON their owners keep (#655): they are most of each frame and nearly always unchanged. `kept(key, list)`
// gives that JSON and its length for a list under a key in KEPT; the worker is sent it only when it changed,
// so an entry for a kept list carries `null` for its JSON. Keys go in the same order and undefined values are
// left out, as JSON.stringify does. `bytes` is the UTF-8 length of the frame's full line, which the queue
// charges whatever the worker stores.
const KEPT = new Set(['items', 'gates']);
function frameParts(state, commands, kept, referenceKept = false) {
  if (state === null || typeof state !== 'object' || 'toJSON' in state) {
    const line = JSON.stringify({ state, commands });
    return { line, bytes: Buffer.byteLength(line) };
  }
  const entries = [];
  let bytes = 0;
  for (const key of Object.keys(state)) {
    // Kept keys are plain ASCII words, so the key and its quotes and colon are 3 + length bytes.
    if (KEPT.has(key) && Array.isArray(state[key])) { const list = kept(key, state[key]); entries.push([key, referenceKept ? null : list.json]); bytes += 3 + key.length + list.bytes; continue; }
    const json = JSON.stringify(state[key]);
    if (json === undefined) continue;
    entries.push([key, json]); bytes += Buffer.byteLength(JSON.stringify(key)) + 1 + Buffer.byteLength(json);
  }
  const commandsJson = JSON.stringify(commands), tail = commandsJson === undefined ? '}}' : `},"commands":${commandsJson}}`;
  bytes += 10 + Math.max(0, entries.length - 1) + Buffer.byteLength(tail);
  return { entries, commands: commandsJson, bytes };
}

// A frame's full line, `JSON.stringify({ state, commands })`, and its byte count, for checking the byte
// contract (26) without a worker. Keyframes are stored as exactly this line; deltas rebuild it.
export function frameLine(state, commands, kept) {
  const frame = frameParts(state, commands, kept);
  return { line: frame.line ?? frameText(frame), bytes: frame.bytes };
}

// The header line: the caller's header, then the stored form's own facts.
function headerLine(header, keyframeEvery) {
  const text = stringifyWithMap(header), fields = `"frameEncoding":${JSON.stringify(FRAME_ENCODING)},"keyframeEvery":${keyframeEvery}`;
  if (typeof text !== 'string' || !text.startsWith('{') || !text.endsWith('}')) throw new TypeError('A replay header must be an object');
  return `${text === '{}' ? '{' : `${text.slice(0, -1)},`}${fields}}\n`;
}

// The writer owns admission and publication; its worker owns bytes and stream lifetime.
export function createReplayWriter({ header, output, outputPath, publish, onError = error => console.error('Replay write failed:', error.message), queueBytes, finalizeTimeoutMs = DEFAULT_FINALIZE_TIMEOUT_MS, setTimer = setTimeout, clearTimer = clearTimeout, gzipOptions, keyframeEvery = KEYFRAME_EVERY }) {
  if (queueBytes !== undefined && (!Number.isSafeInteger(queueBytes) || queueBytes < 1)) throw new RangeError('queueBytes must be a positive integer');
  if (!Number.isFinite(finalizeTimeoutMs) || finalizeTimeoutMs < 0) throw new RangeError('finalizeTimeoutMs must be non-negative');
  if (!Number.isSafeInteger(keyframeEvery) || keyframeEvery < 1) throw new RangeError('keyframeEvery must be a positive integer');
  const controller = new AbortController();
  let worker, queuedBytes = 0, headerBytes = 0, frames = 0, droppedFrames = 0, marks = [], droppedMarks = 0, ending = false, completion, failed = null, reported = false, workerDone = false;
  let resolveRecording, rejectRecording;
  const recording = new Promise((resolve, reject) => { resolveRecording = resolve; rejectRecording = reject; });
  recording.catch(() => {});
  // Settles once the worker has taken the header into gzip, or the recording failed; it never rejects (26, #1088).
  let resolveOpened;
  const opened = new Promise(resolve => { resolveOpened = resolve; });
  function fail(error) {
    if (failed) return failed;
    failed = asError(error); controller.abort(failed); rejectRecording(failed); resolveOpened();
    if (!reported) { reported = true; try { onError(failed); } catch { /* Observer failures cannot break cleanup. */ } }
    if (output && !output.destroyed && typeof output.destroy === 'function') output.destroy(failed);
    worker?.terminate().catch(() => {});
    return failed;
  }
  function send(message) {
    try { worker.postMessage(message); return true; }
    catch (error) { fail(error); return false; }
  }
  // Retained bytes stay charged until the worker's gzip write acknowledges them: a frame's full line,
  // which bounds both the message the worker holds and the record it stores.
  const fits = bytes => queuedBytes + bytes <= (queueBytes ?? Math.max(DEFAULT_QUEUE_BYTES, headerBytes + DEFAULT_QUEUE_FRAMES * bytes));
  const last = { items: { json: undefined, bytes: 0 }, gates: { json: undefined, bytes: 0 } }, sent = {};
  const keptText = (key, list) => {
    const json = key === 'items' ? itemsJson(list) : gatesJson(list), text = last[key];
    if (json !== text.json) { text.json = json; text.bytes = Buffer.byteLength(json); }
    return text;
  };
  // Install observers before serializing the header: even a synchronous header
  // failure destroys the injected stream, which may emit its error later.
  output?.on('error', fail);
  output?.on('close', () => { if (!output.writableFinished && !failed) fail(new Error('Replay output closed before completion')); });
  try {
    // Preserve header order and compact JSON. No mutable caller-owned data crosses the boundary.
    const text = headerLine(header, keyframeEvery);
    headerBytes = Buffer.byteLength(text);
    worker = new Worker(new URL('./replay-worker.js', import.meta.url), { workerData: { outputPath, gzipOptions, keyframeEvery } });
    worker.on('error', fail);
    worker.on('exit', code => { if (!workerDone && !failed) fail(new Error(`Replay worker exited before completion (${code})`)); });
    worker.on('message', message => {
      if (failed) return;
      if (message.type === 'failure') fail(message.error);
      // The first acknowledgement is the header's: the worker writes in the order it was sent.
      else if (message.type === 'ack') { queuedBytes -= message.bytes; resolveOpened(); }
      else if (message.type === 'done') { workerDone = true; resolveRecording(message.sha256); }
      else if (message.type === 'chunk') {
        try { output.write(message.bytes, error => { if (error) fail(error); else if (!failed) send({ type: 'chunk-ack' }); }); }
        catch (error) { fail(error); }
      } else if (message.type === 'output-end') {
        try { output.end(error => { if (error) fail(error); else if (!failed) send({ type: 'output-finished' }); }); }
        catch (error) { fail(error); }
      }
    });
    queuedBytes += headerBytes; send({ type: 'header', text, bytes: headerBytes });
  } catch (error) { fail(error); }
  function rejectedCompletion() {
    if (!completion) { completion = Promise.reject(failed || new Error('Replay recording failed')); completion.catch(() => {}); }
    return completion;
  }
  return {
    get blocked() { return queuedBytes > 0; },
    get pendingBytes() { return queuedBytes; },
    get droppedFrames() { return droppedFrames; },
    get failed() { return failed; },
    opened,
    append(state, commands) {
      if (completion || ending) throw new Error('Cannot append to a finalized replay');
      if (failed) return false;
      let frame;
      try { frame = frameParts(state, commands, keptText, true); }
      catch (error) { fail(error); return false; }
      const bytes = frame.bytes + 1;
      if (!fits(bytes)) { droppedFrames++; return false; }
      const updates = {};
      for (const [key, json] of frame.entries ?? []) {
        if (json === null && last[key].json !== sent[key]) updates[key] = last[key].json;
      }
      queuedBytes += bytes;
      if (!send({ ...frame, type: 'frame', bytes, updates })) return false;
      Object.assign(sent, updates); frames++; return true;
    },
    mark(marker) {
      if (completion || ending || failed) return false;
      if (marks.length >= MAX_DIAGNOSTIC_MARKS) { droppedMarks++; return false; }
      marks.push(marker); return true;
    },
    abort(error = new Error('Replay recording was aborted')) { fail(error); return failed; },
    // Gives up a recording that never retained a frame, without reporting it as a failure: a room that
    // retires or closes before its start (#1088). A file store has not yet created the file (replay-worker.js).
    discard() {
      if (frames || ending || completion) return false;
      reported = true; fail(new Error('Replay recording was discarded'));
      return true;
    },
    finish(result) {
      if (completion) return completion;
      if (failed) return rejectedCompletion();
      if (!frames) { fail(new Error('Replay has no retained frames')); return rejectedCompletion(); }
      ending = true;
      const endTick = result?.ticks;
      // The worker writes the trailer line around these fields, with the checkpoints it took.
      const fields = [];
      if (droppedFrames) fields.push(`"recording":${JSON.stringify({ complete: false, droppedFrames, endTick })}`);
      if (marks.length || droppedMarks) {
        try { fields.push(`"diagnostics":${JSON.stringify(droppedMarks ? { marks, dropped: droppedMarks } : { marks })}`); }
        catch { /* A marker that cannot serialize must not cost the recording. */ }
      }
      const text = fields.join(','), bytes = Buffer.byteLength(text);
      queuedBytes += bytes; send({ type: 'finish', fields: text, bytes });
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimer(() => reject(fail(new Error(`Replay finalization exceeded ${finalizeTimeoutMs}ms`))), finalizeTimeoutMs);
      });
      completion = (async () => {
        try {
          const sha256 = await Promise.race([recording, timeout]);
          if (failed) throw failed;
          const meta = { id: header.id, seed: header.seed, createdAt: header.createdAt, ticks: result?.ticks, frames, sha256, escaped: result?.escaped, frameEncoding: FRAME_ENCODING };
          if (droppedFrames) meta.recording = { complete: false, droppedFrames, endTick };
          aborted(controller.signal);
          await Promise.race([publish(meta, { signal: controller.signal }), timeout]);
          aborted(controller.signal);
          return meta;
        } catch (error) { throw fail(error); }
        finally { clearTimer(timer); }
      })();
      completion.catch(() => {});
      return completion;
    }
  };
}
