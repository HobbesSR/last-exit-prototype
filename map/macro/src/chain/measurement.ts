/**
 * Measurement (51 stage 8), a view: the Report on a built map. It is the first point at
 * which a set piece class's promise of core elements can be seen, so it counts core
 * element sites per set piece instance, assigning each by the slot its cell lies in. It
 * checks the proof against the regions that were built, and each builder's sites against
 * its own brief. It reads sites and briefs, never geometry: the game diagnoses portal
 * promises from geometry (`map/micro/diagnose.ts`).
 *
 * The report diagnoses; it never rejects or repairs a map (51 principle 9). A defect names
 * an author or a builder to look at.
 */
import { CORE_ELEMENT_KINDS } from "../../../kernel/contract.ts";
import type { CoreElementKind, CoreElementSite, RegionResult } from "../../../kernel/contract.ts";
import { CHAIN_TILE_SIZE } from "./library.ts";
import { unprovenComponents } from "./proof.ts";
import type { Defect, InstanceCoreElementCount, MacroStages, SetPieceInstance } from "./types.ts";

const cellKey = (x: number, y: number): string => `${x},${y}`;
const slotKey = (col: number, row: number): string => `${col},${row}`;

export const measurement: MacroStages["measurement"] = (built, reachability, layout, library) => {
  const { cellSize, regions } = built;
  const defects: Defect[] = [];

  // ── The proof against what was built ──
  const builtIds = new Set(regions.map((region) => region.brief.id));
  const provenIds = new Set(reachability.components.flat());
  for (const id of provenIds) if (!builtIds.has(id))
    defects.push({ kind: "unbuilt-region", regions: [id], message: `the proof names region ${id}, which the built map doesn't hold` });
  for (const id of builtIds) if (!provenIds.has(id))
    defects.push({ kind: "unproven-region", regions: [id], message: `region ${id} was built, but the proof doesn't name it` });
  // A brief lists the core elements its class rule does, so the spawn region is the one whose brief asks for a spawn.
  const spawn = regions.find((region) => region.brief.coreElements?.spawn !== undefined && provenIds.has(region.brief.id));
  for (const { regions: left, message } of unprovenComponents(reachability, spawn?.brief.id))
    defects.push({ kind: "unproven-region", regions: left, message });

  // ── Each builder against its own brief ──
  const sited: { site: CoreElementSite; region: RegionResult }[] = [];
  for (const region of regions) {
    const { brief } = region, own = new Set(brief.cells.map(({ x, y }) => cellKey(x, y)));
    const asked = brief.coreElements ?? {}, found = new Map<CoreElementKind, number>();
    for (const site of region.coreElements) {
      sited.push({ site, region });
      found.set(site.kind, (found.get(site.kind) ?? 0) + 1);
      if (!own.has(cellKey(Math.floor(site.x / cellSize), Math.floor(site.y / cellSize))))
        defects.push({ kind: "broken-promise", regions: [brief.id], site,
          message: `region ${brief.id} sited a ${site.kind} at ${site.x},${site.y}, outside its own cells` });
    }
    for (const kind of CORE_ELEMENT_KINDS) {
      const want = asked[kind] ?? 0, got = found.get(kind) ?? 0;
      if (want !== got) defects.push({ kind: "broken-promise", regions: [brief.id],
        message: `region ${brief.id} sited ${got} ${kind} where its brief asked for ${want}` });
    }
  }

  // ── Core elements per set piece instance ──
  const classes = new Map(library.setPieceClasses.map((setPieceClass) => [setPieceClass.id, setPieceClass]));
  const promises = (instance: SetPieceInstance): Partial<Record<CoreElementKind, number>> => {
    const setPieceClass = classes.get(instance.setPieceClass);
    if (!setPieceClass) throw new Error(`instance ${instance.id} has set piece class ${instance.setPieceClass}, which the library doesn't register`);
    return Object.fromEntries(Object.entries(setPieceClass.coreElements ?? {}).map(([kind, count]) =>
      [kind, count === "exitCount" ? layout.params.exitCount : count]));
  };
  // Instances never share a slot, so each cell assigns a site to one instance at most.
  const instanceAt = new Map<string, SetPieceInstance>();
  for (const instance of layout.setPieces) for (const { col, row } of instance.slots) instanceAt.set(slotKey(col, row), instance);
  const assigned = new Map<SetPieceInstance, Map<CoreElementKind, number>>();
  for (const { site, region } of sited) {
    const col = Math.floor(Math.floor(site.x / cellSize) / CHAIN_TILE_SIZE), row = Math.floor(Math.floor(site.y / cellSize) / CHAIN_TILE_SIZE);
    const instance = instanceAt.get(slotKey(col, row));
    if (!instance) {
      defects.push({ kind: "stray-site", regions: [region.brief.id], site,
        message: `a ${site.kind} at ${site.x},${site.y}, in region ${region.brief.id}, lies in no set piece instance` });
    } else if (promises(instance)[site.kind] === undefined) {
      defects.push({ kind: "stray-site", instance: instance.id, regions: [region.brief.id], site,
        message: `a ${site.kind} at ${site.x},${site.y}, in region ${region.brief.id}, lies in instance ${instance.id}, whose class ${instance.setPieceClass} doesn't own it` });
    } else {
      const counts = assigned.get(instance) ?? new Map<CoreElementKind, number>();
      counts.set(site.kind, (counts.get(site.kind) ?? 0) + 1);
      assigned.set(instance, counts);
    }
  }
  const coreElements: InstanceCoreElementCount[] = [];
  for (const instance of layout.setPieces) {
    const promised = promises(instance);
    for (const element of CORE_ELEMENT_KINDS) {
      const want = promised[element];
      if (want === undefined) continue;
      const found = assigned.get(instance)?.get(element) ?? 0;
      coreElements.push({ instance: instance.id, element, promised: want, found });
      if (found !== want) defects.push({ kind: found < want ? "missing-core-element" : "extra-core-element", instance: instance.id,
        message: `instance ${instance.id} of class ${instance.setPieceClass} has ${found} ${element} where its class promises ${want}` });
    }
  }

  return {
    coreElements,
    defects,
    // Counted from the built map, not from a tile graph.
    metrics: {
      regions: regions.length,
      cells: regions.reduce((n, region) => n + region.brief.cells.length, 0),
      portals: built.pairs.length,
      elements: regions.reduce((n, region) => n + region.elements.length, 0),
      coreElementSites: sited.length,
      loot: regions.reduce((n, region) => n + region.loot.length, 0),
    },
  };
};
