import assert from 'node:assert/strict';
import os from 'node:os';
import { portalGraphOf } from '../shared/navigation/portal-graph.ts';

// Each section has an offset and length in the runtime navigation header. This layout measures
// only the new navigation payload, with the numeric widths from the runtime map contract.
export function packRuntimeNavigation(map, layers) {
  const gateSlots = new Map(map.gates.map(({ id }, slot) => [id, slot]));
  const graph = portalGraphOf(map);
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
  for (const { clearance, size, cols, index, floats, ints, gates } of layers) {
    const gateSets = JSON.parse(gates), tileInts = [], tileGeometry = [], setRows = [], members = [];
    const fields = 16;
    assert.equal(index.length % fields, 0);
    for (let at = 0; at < index.length; at += fields) {
      const sets = gateSets[at / fields] ?? [];
      tileInts.push(...index.subarray(at, at + 6), index[at + 9], index[at + 10], setRows.length / 2, sets.length);
      tileGeometry.push(...index.subarray(at + 6, at + 9), ...index.subarray(at + 11, at + fields));
      for (const set of sets) {
        setRows.push(members.length, set.length);
        for (const gate of set) {
          assert.ok(gateSlots.has(gate), `unknown gate ${gate}`);
          members.push(gateSlots.get(gate));
        }
      }
    }
    sections.push(Float64Array.of(clearance, size), Uint32Array.of(cols, index.length / fields),
      Uint32Array.from(tileInts), Float64Array.from(tileGeometry), floats, ints,
      Uint32Array.from(setRows), Uint32Array.from(members));
  }
  const directory = new Uint32Array(2 + sections.length * 2);
  directory.set([1, sections.length]);
  let bytes = directory.byteLength;
  for (const [i, section] of sections.entries()) {
    bytes = Math.ceil(bytes / 8) * 8;
    directory.set([bytes, section.byteLength], 2 + i * 2);
    bytes += section.byteLength;
  }
  assert.equal(os.endianness(), 'LE');
  const packed = new Uint8Array(bytes);
  packed.set(new Uint8Array(directory.buffer));
  for (const [i, section] of sections.entries()) {
    packed.set(new Uint8Array(section.buffer, section.byteOffset, section.byteLength), directory[2 + i * 2]);
  }
  return packed;
}
