import { Worker } from 'node:worker_threads';
import { itemsJson } from '../shared/simulation/ground-items.ts';
import { gatesJson } from '../shared/simulation/frame-gates.ts';

// Without an explicit budget the queue holds the larger of 8 MiB and the header (which carries the map) plus four frames
// of the size being appended, so a larger map's frames are not all dropped (a 72x36 frame is about 3.3 MiB, 42.22); see 26.
const DEFAULT_QUEUE_BYTES = 8 * 1024 * 1024, DEFAULT_QUEUE_FRAMES = 4;
const DEFAULT_FINALIZE_TIMEOUT_MS = 5000;
// Diagnostic markers ride in a trailer, bounded like the frame queue; see docs/26.
export const MAX_DIAGNOSTIC_MARKS = 512;
const asError = error => error instanceof Error ? error : new Error(String(error));
const aborted = signal => { if (signal?.aborted) throw asError(signal.reason || 'Replay recording was aborted'); };

// `JSON.stringify({ state, commands })` and its UTF-8 length, with the ground items and gates taken from the JSON their
// owners keep (#655): they are most of each frame and nearly always unchanged. `kept(key, list)` gives that JSON and its
// length for a list under a key in KEPT. Keys go in the same order and undefined values are left out, as
// JSON.stringify does, so the bytes and the digest are unchanged (26).
const KEPT = new Set(['items', 'gates']);
function frameParts(state, commands, kept, referenceKept = false) {
  if (state === null || typeof state !== 'object' || 'toJSON' in state) {
    const line = JSON.stringify({ state, commands });
    return { line, bytes: Buffer.byteLength(line) };
  }
  const parts = [];
  let bytes = 0;
  for (const key of Object.keys(state)) {
    // Kept keys are plain ASCII words, so the key and its quotes and colon are 3 + length bytes.
    if (KEPT.has(key) && Array.isArray(state[key])) { const list = kept(key, state[key]); parts.push(referenceKept ? { kept: key } : `"${key}":${list.json}`); bytes += 3 + key.length + list.bytes; continue; }
    const json = JSON.stringify(state[key]);
    if (json === undefined) continue;
    const part = `${JSON.stringify(key)}:${json}`;
    parts.push(part); bytes += Buffer.byteLength(part);
  }
  const commandsJson = JSON.stringify(commands), tail = commandsJson === undefined ? '}}' : `},"commands":${commandsJson}}`;
  bytes += 10 + Math.max(0, parts.length - 1) + Buffer.byteLength(tail);
  return { parts, tail, bytes };
}

// Compatibility helper for callers that explicitly need a complete line. The live
// writer sends fragments instead, so assembly and UTF-8 encoding belong to the worker.
export function frameLine(state, commands, kept) {
  const frame = frameParts(state, commands, kept);
  return { line: frame.line ?? `{"state":{${frame.parts.join(',')}${frame.tail}`, bytes: frame.bytes };
}

// The writer owns admission and publication; its worker owns bytes and stream lifetime.
export function createReplayWriter({ header, output, outputPath, publish, onError = error => console.error('Replay write failed:', error.message), queueBytes, finalizeTimeoutMs = DEFAULT_FINALIZE_TIMEOUT_MS, setTimer = setTimeout, clearTimer = clearTimeout, gzipOptions }) {
  if (queueBytes !== undefined && (!Number.isSafeInteger(queueBytes) || queueBytes < 1)) throw new RangeError('queueBytes must be a positive integer');
  if (!Number.isFinite(finalizeTimeoutMs) || finalizeTimeoutMs < 0) throw new RangeError('finalizeTimeoutMs must be non-negative');
  const controller = new AbortController();
  let worker, queuedBytes = 0, headerBytes = 0, frames = 0, droppedFrames = 0, marks = [], droppedMarks = 0, ending = false, completion, failed = null, reported = false, workerDone = false;
  let resolveRecording, rejectRecording;
  const recording = new Promise((resolve, reject) => { resolveRecording = resolve; rejectRecording = reject; });
  recording.catch(() => {});
  function fail(error) {
    if (failed) return failed;
    failed = asError(error); controller.abort(failed); rejectRecording(failed);
    if (!reported) { reported = true; try { onError(failed); } catch { /* Observer failures cannot break cleanup. */ } }
    if (output && !output.destroyed && typeof output.destroy === 'function') output.destroy(failed);
    worker?.terminate().catch(() => {});
    return failed;
  }
  function send(message) {
    try { worker.postMessage(message); return true; }
    catch (error) { fail(error); return false; }
  }
  // Retained bytes stay charged until the worker's gzip write acknowledges them.
  // The changed-list payload alone is smaller than this full-frame byte budget.
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
    const text = `${JSON.stringify(header).slice(0, -1)},"frames":[`;
    headerBytes = Buffer.byteLength(text);
    worker = new Worker(new URL('./replay-worker.js', import.meta.url), { workerData: { outputPath, gzipOptions } });
    worker.on('error', fail);
    worker.on('exit', code => { if (!workerDone && !failed) fail(new Error(`Replay worker exited before completion (${code})`)); });
    worker.on('message', message => {
      if (failed) return;
      if (message.type === 'failure') fail(message.error);
      else if (message.type === 'ack') queuedBytes -= message.bytes;
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
    append(state, commands) {
      if (completion || ending) throw new Error('Cannot append to a finalized replay');
      if (failed) return false;
      let frame;
      try { frame = frameParts(state, commands, keptText, true); }
      catch (error) { fail(error); return false; }
      const bytes = frame.bytes + (frames ? 1 : 0);
      if (!fits(bytes)) { droppedFrames++; return false; }
      const updates = {};
      for (const part of frame.parts ?? []) {
        if (typeof part !== 'string' && last[part.kept].json !== sent[part.kept]) updates[part.kept] = last[part.kept].json;
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
    finish(result) {
      if (completion) return completion;
      if (failed) return rejectedCompletion();
      if (!frames) { fail(new Error('Replay has no retained frames')); return rejectedCompletion(); }
      ending = true;
      const endTick = result?.ticks;
      let trailer = ']';
      if (droppedFrames) trailer += `,"recording":${JSON.stringify({ complete: false, droppedFrames, endTick })}`;
      if (marks.length || droppedMarks) {
        try { trailer += `,"diagnostics":${JSON.stringify(droppedMarks ? { marks, dropped: droppedMarks } : { marks })}`; }
        catch { /* A marker that cannot serialize must not cost the recording. */ }
      }
      const text = `${trailer}}`, bytes = Buffer.byteLength(text);
      queuedBytes += bytes; send({ type: 'finish', text, bytes });
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimer(() => reject(fail(new Error(`Replay finalization exceeded ${finalizeTimeoutMs}ms`))), finalizeTimeoutMs);
      });
      completion = (async () => {
        try {
          const sha256 = await Promise.race([recording, timeout]);
          if (failed) throw failed;
          const meta = { id: header.id, seed: header.seed, createdAt: header.createdAt, ticks: result?.ticks, frames, sha256, escaped: result?.escaped };
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
