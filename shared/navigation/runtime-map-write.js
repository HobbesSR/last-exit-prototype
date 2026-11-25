import { portalGraphOf } from './portal-graph.ts';
import { CLIP_SCALE } from '../shape-construction.ts';

const DIRECTORY_HEADER_WORDS = 2;
const SECTION_WORDS = 2;
const sectionEntry = section => DIRECTORY_HEADER_WORDS + section * SECTION_WORDS;

/** Borrow the five graph sections of a validated primary package, or null for a graphless package. */
export function runtimePortalGraphSections(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const readWord = word => view.getUint32(word * Uint32Array.BYTES_PER_ELEMENT, true);
  // Both versions use the same graph flag, geometry, rows, owner grid, adjacency and stands.
  if (!view.getUint32(readWord(sectionEntry(0)), true)) return null;
  const sections = [];
  for (let section = 1; section <= 5; section++) {
    const entry = sectionEntry(section);
    const offset = readWord(entry);
    sections.push(bytes.subarray(offset, offset + readWord(entry + 1)));
  }
  return sections;
}

// The directory describes 8-byte-aligned sections. Version 2 stores points as unsigned
// offsets from the discovery-tile origin in units of the Clipper grid.
export function packRuntimeNavigation(map, layers, { compact = false, includeGraph = true } = {}) {
  if (layers.length !== 2 && !(compact && layers.length === 1)) throw new RangeError('Invalid navigation layers');
  const gateSlots = new Map(map.gates.map(({ id }, slot) => [id, slot]));
  const graph = includeGraph ? portalGraphOf(map) : undefined;
  const Points = compact ? Uint16Array : Float64Array;
  const sections = [Uint32Array.of(+!!graph, layers.length)];
  if (graph) {
    const geometry = [graph.cellSize], rows = [graph.cols, graph.rows, graph.regions.length, graph.portals.length];
    const adjacency = [], stands = [];
    for (const region of graph.regions) {
      const { x, y, w, h } = region.box;
      geometry.push(x, y, w, h);
      rows.push(adjacency.length, region.portals.length);
      for (const portal of region.portals) adjacency.push(portal);
    }
    for (const portal of graph.portals) {
      geometry.push(portal.x, portal.y);
      rows.push(...portal.regions, ...portal.slots, stands.length / 2, portal.stands.length);
      for (const { x, y } of portal.stands) stands.push(x, y);
    }
    sections.push(Float64Array.from(geometry), Uint32Array.from(rows), graph.owner,
      Uint32Array.from(adjacency), Float64Array.from(stands));
  }
  const layerStart = sections.length;
  for (const { tiles } of layers) {
    let floats = 0, ints = 0, sets = 0, members = 0;
    for (const tile of tiles) {
      floats += tile.points.length;
      ints += tile.triangles.length * 2 + tile.locator.starts.length + tile.locator.items.length + tile.gateSet.length;
      sets += tile.gateSets.length;
      for (const set of tile.gateSets) members += set.length;
    }
    // A number describes a section to fill directly after allocating the final buffer.
    sections.push(16, 8, tiles.length * 10 * 4, tiles.length * 8 * 8,
      floats * Points.BYTES_PER_ELEMENT, ints * 4, sets * 2 * 4, members * 4);
  }
  const directory = new Uint32Array(sectionEntry(sections.length));
  directory.set([compact ? 2 : 1, sections.length]);
  let bytes = directory.byteLength;
  for (const [i, section] of sections.entries()) {
    bytes = Math.ceil(bytes / 8) * 8;
    const length = typeof section === 'number' ? section : section.byteLength;
    directory.set([bytes, length], sectionEntry(i));
    bytes += length;
  }
  if (new Uint8Array(Uint16Array.of(1).buffer)[0] !== 1) throw new Error('Runtime navigation requires little-endian byte order');
  const packed = new Uint8Array(bytes);
  packed.set(new Uint8Array(directory.buffer));
  for (let i = 0; i < layerStart; i++) {
    const section = sections[i];
    packed.set(new Uint8Array(section.buffer, section.byteOffset, section.byteLength), directory[sectionEntry(i)]);
  }
  const view = (i, Type) => {
    const entry = sectionEntry(i);
    return new Type(packed.buffer, directory[entry], directory[entry + 1] / Type.BYTES_PER_ELEMENT);
  };
  for (const [layerIndex, { clearance, size, cols, tiles }] of layers.entries()) {
    const s = layerStart + layerIndex * 8;
    view(s, Float64Array).set([clearance, size]);
    view(s + 1, Uint32Array).set([cols, tiles.length]);
    const rows = view(s + 2, Uint32Array), geometry = view(s + 3, Float64Array);
    const floats = view(s + 4, Points), ints = view(s + 5, Int32Array);
    const setRows = view(s + 6, Uint32Array), members = view(s + 7, Uint32Array);
    let floatAt = 0, intAt = 0, setAt = 0, memberAt = 0;
    for (const [i, tile] of tiles.entries()) {
      const { x, y, size: bucket, cols: across, rows: down, starts, items } = tile.locator;
      const { box } = tile;
      rows.set([floatAt, tile.points.length, intAt, tile.triangles.length, starts.length, items.length,
        across, down, setAt, tile.gateSets.length], i * 10);
      geometry.set([x, y, bucket, box.x, box.y, box.w, box.h, tile.reach], i * 8);
      if (compact) {
        const maxX = Math.round(box.w * CLIP_SCALE), maxY = Math.round(box.h * CLIP_SCALE);
        for (let j = 0; j < tile.points.length; j++) {
          const origin = j % 2 ? box.y : box.x;
          const limit = j % 2 ? maxY : maxX;
          const point = tile.points[j], offset = (point - origin) * CLIP_SCALE;
          if (!Number.isInteger(offset) || offset < 0 || offset > 0xffff || offset > limit ||
              !Object.is(origin + offset / CLIP_SCALE, point)) {
            throw new RangeError('Runtime navigation point is outside the tile coordinate grid');
          }
          floats[floatAt + j] = offset;
        }
      } else floats.set(tile.points, floatAt);
      floatAt += tile.points.length;
      for (const part of [tile.triangles, tile.twins, starts, items, tile.gateSet]) {
        ints.set(part, intAt); intAt += part.length;
      }
      for (const set of tile.gateSets) {
        setRows.set([memberAt, set.length], setAt * 2); setAt++;
        for (const gate of set) {
          if (!gateSlots.has(gate)) throw new RangeError(`unknown gate ${gate}`);
          members[memberAt++] = gateSlots.get(gate);
        }
      }
    }
  }
  return packed;
}
