import { mkdir, readdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { createReplayWriter } from './replay-writer.js';

const throwIfAborted = signal => {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Replay publication was aborted');
};

/**
 * The writing half of the file archive: recordings into `directory`, each announced to `onPublished` with
 * its metadata once published. A room on its own thread (#1089) records through one of these, and its
 * thread tells the host's store, which lists and serves the archive, through `published`.
 */
export function fileReplayWriters(directory, onPublished = () => {}) {
  return {
    start(header, { onError } = {}) {
      return createReplayWriter({ header, onError, outputPath: path.join(directory, `${header.id}.partial`),
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
            onPublished(meta);
          } catch (error) {
            if (signal?.aborted) await Promise.all([rm(metaPath, { force: true }), rm(partialMetaPath, { force: true })]);
            throw error;
          }
        }
      });
    }
  };
}

// Filesystem-specific archive adapter. Room code sees writers and metadata only.
export async function createFileReplayStore(directory) {
  await mkdir(directory, { recursive: true });
  const archives = new Map();
  for (const file of await readdir(directory)) {
    if (!file.endsWith('.meta.json')) continue;
    try { const data = JSON.parse(await readFile(path.join(directory, file), 'utf8')); archives.set(data.id, data); }
    catch { /* Ignore incomplete metadata from interrupted writes. */ }
  }
  const published = meta => { archives.set(meta.id, meta); };
  return {
    list: () => structuredClone([...archives.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 30)),
    // Keep Express sendFile's existing range/cache/error behavior at the HTTP delivery edge.
    // Every archive keeps the `.json.gz` name; a schema 17+ one (`frameEncoding`) is lines of JSON (26).
    download: id => archives.has(id) ? { path: path.join(directory, `${id}.json.gz`), lines: !!archives.get(id).frameEncoding } : null,
    start: fileReplayWriters(directory, published).start,
    /** A recording another thread's writers published here (#1089). */
    published,
    /** How a room on another thread records into this archive: plain data, for `fileReplayWriters`. */
    threadOptions: { directory },
  };
}
