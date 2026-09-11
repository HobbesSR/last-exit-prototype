import { createHash } from 'node:crypto';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

// The writer owns encoding, integrity and stream lifetime. It never receives a room.
export function createReplayWriter({ header, output, publish, onError = error => console.error('Replay write failed:', error.message) }) {
  const hash = createHash('sha256'), recorder = createGzip();
  const recording = pipeline(recorder, output);
  let frames = 0, completion;
  recording.catch(onError); // Observe early disk failures before finalization is requested.
  recorder.write(JSON.stringify(header).slice(0, -1) + ',"frames":[');
  return {
    get blocked() { return recorder.writableNeedDrain; },
    append(state, commands) {
      if (completion) throw new Error('Cannot append to a finalized replay');
      const line = JSON.stringify({ state, commands });
      hash.update(line + '\n'); recorder.write((frames ? ',' : '') + line); frames++;
    },
    finish({ ticks, escaped }) {
      if (!completion) {
        recorder.end(']}');
        completion = (async () => {
          await recording;
          const meta = { id: header.id, seed: header.seed, createdAt: header.createdAt, ticks, frames, sha256: hash.digest('hex'), escaped };
          await publish(meta);
          return meta;
        })();
      }
      return completion;
    }
  };
}
