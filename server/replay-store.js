import { mkdir, readdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { createReplayWriter } from './replay-writer.js';

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
    start(header) {
      return createReplayWriter({ header, output: createWriteStream(path.join(directory, `${header.id}.partial`)),
        async publish(meta) {
          await rename(path.join(directory, `${header.id}.partial`), path.join(directory, `${header.id}.json.gz`));
          await writeFile(path.join(directory, `${header.id}.meta.json`), JSON.stringify(meta));
          archives.set(header.id, meta);
        }
      });
    }
  };
}
