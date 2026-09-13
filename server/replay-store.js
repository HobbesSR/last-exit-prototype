import { mkdir, readdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { createReplayWriter } from './replay-writer.js';

const throwIfAborted = signal => {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Replay publication was aborted');
};

// Filesystem-specific archive adapter. Room code sees writers and metadata only.
export async function createFileReplayStore(directory) {
  await mkdir(directory, { recursive: true });
  const archives = new Map();
  for (const file of await readdir(directory)) {
    if (!file.endsWith('.meta.json')) continue;
    try { const data = JSON.parse(await readFile(path.join(directory, file), 'utf8')); archives.set(data.id, data); }
    catch { /* Ignore incomplete metadata from interrupted writes. */ }
  }
  return {
    list: () => structuredClone([...archives.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 30)),
    // Keep Express sendFile's existing range/cache/error behavior at the HTTP delivery edge.
    download: id => archives.has(id) ? { path: path.join(directory, `${id}.json.gz`) } : null,
    start(header, { onError } = {}) {
      return createReplayWriter({ header, onError, output: createWriteStream(path.join(directory, `${header.id}.partial`)),
        async publish(meta, { signal } = {}) {
          const metaPath = path.join(directory, `${header.id}.meta.json`);
          const partialMetaPath = path.join(directory, `${header.id}.meta.partial`);
          try {
            throwIfAborted(signal);
            await rename(path.join(directory, `${header.id}.partial`), path.join(directory, `${header.id}.json.gz`));
            throwIfAborted(signal);
            // A timeout may arrive while metadata is being written. Keep the restart scanner
            // from promoting that incomplete publication by using the same partial convention.
            await writeFile(partialMetaPath, JSON.stringify(meta));
            throwIfAborted(signal);
            await rename(partialMetaPath, metaPath);
            throwIfAborted(signal);
            archives.set(header.id, meta);
          } catch (error) {
            if (signal?.aborted) {
              archives.delete(header.id);
              await Promise.all([rm(metaPath, { force: true }), rm(partialMetaPath, { force: true })]);
            }
            throw error;
          }
        }
      });
    }
  };
}
