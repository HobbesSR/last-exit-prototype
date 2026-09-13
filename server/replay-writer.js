import { createHash } from 'node:crypto';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

const DEFAULT_QUEUE_BYTES = 8 * 1024 * 1024;
const DEFAULT_FINALIZE_TIMEOUT_MS = 5000;
const asError = error => error instanceof Error ? error : new Error(String(error));
const aborted = signal => { if (signal?.aborted) throw asError(signal.reason || 'Replay recording was aborted'); };

// The writer owns encoding, integrity and stream lifetime. It never receives a room.
export function createReplayWriter({ header, output, publish, onError = error => console.error('Replay write failed:', error.message), queueBytes = DEFAULT_QUEUE_BYTES, finalizeTimeoutMs = DEFAULT_FINALIZE_TIMEOUT_MS, setTimer = setTimeout, clearTimer = clearTimeout, gzipOptions }) {
  if (!Number.isSafeInteger(queueBytes) || queueBytes < 1) throw new RangeError('queueBytes must be a positive integer');
  if (!Number.isFinite(finalizeTimeoutMs) || finalizeTimeoutMs < 0) throw new RangeError('finalizeTimeoutMs must be non-negative');
  const hash = createHash('sha256'), recorder = createGzip(gzipOptions), controller = new AbortController();
  const recording = pipeline(recorder, output), queue = [];
  let queuedBytes = 0, writing = null, frames = 0, droppedFrames = 0, ending = false, completion, failed = null, reported = false;
  // Observe this independently of finish(), because a live sink can fail mid-match.
  recording.catch(error => fail(error));

  function fail(error) {
    if (failed) return failed;
    failed = asError(error); controller.abort(failed);
    if (!reported) { reported = true; try { onError(failed); } catch { /* Observer failures cannot break cleanup. */ } }
    if (!recorder.destroyed) recorder.destroy(failed);
    if (output && !output.destroyed && typeof output.destroy === 'function') output.destroy(failed);
    return failed;
  }
  function pump() {
    if (failed || writing || !queue.length) return;
    writing = queue.shift();
    recorder.write(writing.text, error => {
      queuedBytes -= writing.bytes; writing = null;
      if (error) fail(error); else pump();
      endWhenDrained();
    });
  }
  function enqueue(text, countsAgainstFrameBudget = false) {
    const bytes = Buffer.byteLength(text);
    if (countsAgainstFrameBudget && queuedBytes + bytes > queueBytes) return false;
    queuedBytes += bytes; queue.push({ text, bytes }); pump(); return true;
  }
  function endWhenDrained() {
    if (ending && !failed && !writing && !queue.length && !recorder.writableEnded) recorder.end();
  }
  // Keep the old header bytes exactly, including its key order and compact JSON form.
  try { enqueue(`${JSON.stringify(header).slice(0, -1)},"frames":[`); }
  catch (error) { fail(error); }
  function rejectedCompletion() {
    if (!completion) { completion = Promise.reject(failed || new Error('Replay recording failed')); completion.catch(() => {}); }
    return completion;
  }

  return {
    // Diagnostic only. Match advancement must never depend on this state.
    get blocked() { return queuedBytes > 0 || recorder.writableNeedDrain; },
    get pendingBytes() { return queuedBytes; },
    get droppedFrames() { return droppedFrames; },
    get failed() { return failed; },
    append(state, commands) {
      if (completion || ending) throw new Error('Cannot append to a finalized replay');
      if (failed) return false;
      let line;
      try { line = JSON.stringify({ state, commands }); }
      catch (error) { fail(error); return false; }
      const text = `${frames ? ',' : ''}${line}`;
      if (!enqueue(text, true)) { droppedFrames++; return false; }
      hash.update(`${line}\n`); frames++; return true;
    },
    abort(error = new Error('Replay recording was aborted')) { fail(error); return failed; },
    finish(result) {
      if (completion) return completion;
      if (failed) return rejectedCompletion();
      if (!frames) { fail(new Error('Replay has no retained frames')); return rejectedCompletion(); }
      ending = true;
      const endTick = result?.ticks;
      enqueue(droppedFrames ? `],"recording":${JSON.stringify({ complete: false, droppedFrames, endTick })}}` : ']}');
      endWhenDrained();
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimer(() => reject(fail(new Error(`Replay finalization exceeded ${finalizeTimeoutMs}ms`))), finalizeTimeoutMs);
      });
      completion = (async () => {
        try {
          await Promise.race([recording, timeout]);
          if (failed) throw failed;
          const meta = { id: header.id, seed: header.seed, createdAt: header.createdAt, ticks: result?.ticks, frames, sha256: hash.digest('hex'), escaped: result?.escaped };
          if (droppedFrames) meta.recording = { complete: false, droppedFrames, endTick };
          aborted(controller.signal);
          await Promise.race([publish(meta, { signal: controller.signal }), timeout]);
          aborted(controller.signal);
          return meta;
        } catch (error) { throw fail(error); }
        finally { clearTimer(timer); }
      })();
      // A failed fire-and-forget finalization must not become an unhandled rejection.
      completion.catch(() => {});
      return completion;
    }
  };
}
