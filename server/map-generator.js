import { Worker } from 'node:worker_threads';

// The room service's asynchronous map source: one worker, started on first use and reused, taking
// requests in order. A worker that dies fails what it held and is replaced by the next request.
export function createMapGenerator() {
  let worker = null, next = 0;
  const waiting = new Map();
  const failAll = error => { for (const { reject } of waiting.values()) reject(error); waiting.clear(); };
  function start() {
    const started = new Worker(new URL('./map-worker.js', import.meta.url));
    started.on('message', ({ id, map, error }) => {
      const request = waiting.get(id); waiting.delete(id);
      if (error) request?.reject(new Error(error)); else request?.resolve(map);
      // Idle workers must not keep the process alive.
      if (!waiting.size) started.unref();
    });
    started.on('error', error => { if (worker === started) worker = null; failAll(error); });
    started.on('exit', code => { if (worker === started) { worker = null; failAll(new Error(`Map worker exited with code ${code}`)); } });
    return started;
  }
  return {
    generate(seed, size) {
      worker ??= start();
      worker.ref();
      return new Promise((resolve, reject) => {
        const id = next++;
        waiting.set(id, { resolve, reject });
        worker.postMessage({ id, seed, size });
      });
    },
    close() { const stopping = worker; worker = null; failAll(new Error('Map generator closed')); return stopping ? stopping.terminate().then(() => undefined) : Promise.resolve(); },
  };
}
