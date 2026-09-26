import { generateMap } from "../core.ts";
import type { MapParams, Library } from "../types.ts";

self.onmessage = (event: MessageEvent<{ seed: string | number; params: Partial<MapParams>; library: Library }>) => {
  const { seed, params, library } = event.data;
  try {
    const map = generateMap(seed, params, library, (status: string, progress: number) => {
      self.postMessage({ type: 'progress', status, progress });
    });
    self.postMessage({ type: 'done', map });
  } catch (error: any) {
    self.postMessage({ type: 'error', error: error.message || String(error) });
  }
};
