import { bounds, rect, type Shape } from '../../../shared/shape.ts';
import type { Vec2 } from '../../../shared/types.ts';
import { assemblyFootprints, createBuilderCanvas, type CanvasAssembly } from '../canvas.ts';
import { areaContains } from '../parcel-area.ts';
import { shapesOverlap } from '../geometry.ts';
import { discoverCordWitness } from '../cord-witness.ts';
import { createProspectiveParcels } from '../prospective-parcels.ts';
import type { RegionBrief } from '../types.ts';

type Operation = { kind: 'assembly'; assembly: CanvasAssembly } | { kind: 'empty'; area: Shape[] };
const envelopes = (assembly: CanvasAssembly): Shape[] => assembly.elements.map(e => rect(e.x, e.y, e.template.w, e.template.h));

/** Every whole-cell hunter standing block in a doorstep becomes a terminal. */
function terminalsFor(shapes: readonly Shape[], size: number): Vec2[] {
  return shapes.flatMap(shape => {
    const b = bounds(shape), points: Vec2[] = [];
    for (let y = b.y + size; y <= b.y + b.h - size + 1e-7; y += size)
      for (let x = b.x + size; x <= b.x + b.w - size + 1e-7; x += size) points.push({ x, y });
    return points.length ? points : [{ x: b.x + b.w / 2, y: b.y + b.h / 2 }];
  });
}

/** Route against whole template boxes, keeping actual geometry private to the preview. */
function proxy(assembly: CanvasAssembly): CanvasAssembly {
  return { ...assembly, areas: envelopes(assembly), elements: assembly.elements.map(e => ({ label: e.label, x: e.x, y: e.y,
    template: { w: e.template.w, h: e.template.h, parts: [{ part: 'obstacle' as const, kind: 'building' as const,
      shape: rect(0, 0, e.template.w, e.template.h) }] } })) };
}

/** Experimental comparison: real geometry is preflighted before any live routing write. */
export function createDepotExperimentCanvas(input: RegionBrief, mode: 'fixed' | 'movable', protectedShapes: readonly Shape[]) {
  const brief = structuredClone(input), fixed = mode === 'fixed' ? structuredClone([...protectedShapes]) : [];
  let operations: Operation[] = [], attempts = 0;
  const refusals: Record<string, number> = {};
  const refuse = (reason: string) => { refusals[reason] = (refusals[reason] ?? 0) + 1; return false; };
  const allAccess = (ops: Operation[]) => ops.flatMap(op => op.kind === 'assembly' ? [...(op.assembly.access ?? [])] : []);
  const allEnvelopes = (ops: Operation[]) => ops.flatMap(op => op.kind === 'assembly' ? envelopes(op.assembly) : []);
  const preview = (ops: Operation[]) => {
    const c = createBuilderCanvas(brief, fixed), prior: Shape[] = [];
    for (const op of ops) {
      if (op.kind === 'empty') { if (!c.markEmpty(op.area)) return null; continue; }
      const area = envelopes(op.assembly);
      if ((op.assembly.access ?? []).some(a => prior.some(e => shapesOverlap(a, e)))
        || !areaContains(area, [...(op.assembly.areas ?? area), ...assemblyFootprints(op.assembly)])
        || area.some(s => !c.fits(s)) || !c.commit({ ...op.assembly, areas: area })) return null;
      prior.push(...area);
    }
    return c;
  };
  const rebuild = (ops: Operation[]) => {
    const made = createProspectiveParcels(brief, { terminals: terminalsFor(allAccess(ops), brief.cellSize) });
    if (!made.ok) return { ok: false as const, reason: made.reason };
    const coordinator = made.coordinator;
    for (const op of ops) {
      const accepted = op.kind === 'empty' ? coordinator.markEmpty(op.area) : coordinator.commit(proxy(op.assembly));
      if (!accepted) return { ok: false as const, reason: 'routing-or-canvas' };
    }
    return { ok: true as const, coordinator };
  };
  const made = mode === 'movable' ? rebuild([]) : null;
  if (made && !made.ok) return { ok: false as const, reason: made.reason, canvas: undefined };
  const initial = mode === 'fixed' ? discoverCordWitness(brief, []) : null;
  if (initial && !initial.ok) return { ok: false as const, reason: initial.reason, canvas: undefined };
  let actual = preview([])!;
  let coordinator = made?.ok ? made.coordinator : undefined;
  let witness = coordinator?.witness ?? initial!.witness;
  const initialWitness = structuredClone(witness);
  const canvas = {
    get fill() { return actual.fill; },
    get access() { return actual.access; },
    get addressed() { return actual.addressed; },
    get elements() { return actual.elements; },
    fits(shape: Shape) { return actual.fits(shape) && (mode === 'fixed' || !allEnvelopes(operations).some(e => shapesOverlap(shape, e))); },
    spaced(shape: Shape, clearance = 0) { return actual.spaced(shape, clearance); },
    commit(assembly: CanvasAssembly) {
      attempts++;
      const owned = structuredClone(assembly), next: Operation[] = [...operations, { kind: 'assembly', assembly: owned }];
      const trial = preview(next);
      if (!trial) return refuse('canvas');
      if (mode === 'fixed') {
        const found = discoverCordWitness(brief, allEnvelopes(next), terminalsFor(allAccess(next), brief.cellSize), witness);
        if (!found.ok) return refuse(found.reason);
        witness = found.witness;
      } else if (owned.access?.length) {
        const rebuilt = rebuild(next);
        if (!rebuilt.ok) return refuse(rebuilt.reason);
        coordinator = rebuilt.coordinator; witness = coordinator.witness;
      } else {
        if (!coordinator!.commit(proxy(owned))) return refuse('routing-or-canvas');
        witness = coordinator!.witness;
      }
      actual = trial; operations = next; return true;
    },
    markEmpty(shapes: readonly Shape[]) {
      attempts++;
      const next: Operation[] = [...operations, { kind: 'empty', area: structuredClone([...shapes]) }];
      const trial = preview(next);
      if (!trial) return refuse('canvas');
      if (coordinator && !coordinator.markEmpty(shapes)) return refuse('canvas');
      actual = trial; operations = next; return true;
    },
    get diagnostics() { return { attempts, refusals: { ...refusals }, emptyAreas: structuredClone(operations.flatMap(op => op.kind === 'empty' ? op.area : [])), initialWitness: structuredClone(initialWitness), finalWitness: structuredClone(witness) }; },
  };
  return { ok: true as const, canvas };
}
