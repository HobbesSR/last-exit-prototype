// Private preparation of the immutable part of a match map. The live map never
// crosses this boundary: consumers receive detached, immutable values and JSON.
// Keep unknown fields on the uncached path until their ownership is established.
const STATIC = new Set(['seed', 'generator', 'width', 'height', 'playableArea', 'modules', 'buildings',
  'roofs', 'decals', 'appearance', 'obstacles', 'hazards', 'gaps', 'stations', 'chargers', 'sensors',
  'routes', 'nodes', 'streets', 'entry', 'exit', 'spawns', 'hunterSpawns', 'physicsProps', 'motorSurfaces']);
const encodedMaps = new WeakMap();
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

// Arrays dominate the map. Copy/encode at most 128 records before yielding;
// nested map objects (notably playableArea.rows) take the same path. One record
// is the minimum unit, so an exceptionally large individual record can still stall.
async function prepare(value, pause) {
  if (Array.isArray(value)) {
    const copy = [], parts = [];
    for (let i = 0; i < value.length; i += 128) {
      const batch = structuredClone(value.slice(i, i + 128));
      parts.push(JSON.stringify(batch).slice(1, -1));
      for (const record of batch) copy.push(freeze(record));
      await pause();
    }
    return { value: Object.freeze(copy), json: `[${parts.join(',')}]` };
  }
  if (value && typeof value === 'object') {
    const copy = {}, parts = [];
    for (const key of Object.keys(value)) {
      const prepared = await prepare(value[key], pause);
      Object.defineProperty(copy, key, { value: prepared.value, enumerable: true });
      if (prepared.json !== undefined) parts.push(`${JSON.stringify(key)}:${prepared.json}`);
    }
    return { value: Object.freeze(copy), json: `{${parts.join(',')}}` };
  }
  return { value, json: JSON.stringify(value) };
}

export async function prepareMapPayload(map, pause) {
  const fixed = new Map();
  for (const key of Object.keys(map)) if (STATIC.has(key)) {
    fixed.set(key, await prepare(map[key], pause));
    await pause();
  }
  return {
    // items/gates are detached published lists supplied by the match boundary.
    // Their owners supply the JSON; traps and unknown fields are copied afresh.
    read(source, { publicMap = false, itemsJson, gatesJson } = {}) {
      const copy = {}, parts = [];
      for (const key of Object.keys(source)) {
        if (publicMap && key === 'physicsProps') continue;
        const prepared = fixed.get(key);
        const value = prepared ? prepared.value : key === 'items' || key === 'gates'
          ? Object.freeze(source[key].slice()) : freeze(structuredClone(source[key]));
        const json = prepared ? prepared.json : key === 'items' ? itemsJson(source[key])
          : key === 'gates' ? gatesJson(source[key]) : JSON.stringify(value);
        Object.defineProperty(copy, key, { value, enumerable: true });
        if (json !== undefined) parts.push(`${JSON.stringify(key)}:${json}`);
      }
      Object.freeze(copy);
      encodedMaps.set(copy, `{${parts.join(',')}}`);
      return copy;
    }
  };
}

// Welcome/ready envelopes and recording headers keep their ordinary JSON shape
// and field order. Only maps prepared here can bypass ordinary serialization.
export function stringifyWithMap(value) {
  const map = value?.map && encodedMaps.get(value.map);
  if (map === undefined) return JSON.stringify(value);
  const parts = [];
  for (const key of Object.keys(value)) {
    const json = key === 'map' ? map : JSON.stringify(value[key]);
    if (json !== undefined) parts.push(`${JSON.stringify(key)}:${json}`);
  }
  return `{${parts.join(',')}}`;
}
