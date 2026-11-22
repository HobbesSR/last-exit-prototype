import type { ItemRegistry } from '../item-instances.ts';
import type { Game, ItemId } from '../types.ts';
import type { PhysicsRuntime } from './physics-runtime.ts';

// The core's item registry (`rust/core/src/registry.rs`, #1214, docs/27 "The state flip", step 6e.1). Node's registry
// (`s.itemIdentities`) keeps the labels; the core keeps what the rules ask of them: each registered ID with its body
// key (`item:<label>`), and the phases of the `instance-N` labels. The core registers its own allocations as its runs
// make them, so this uploads only what Node registers itself (match setup, scenarios and the retained TypeScript paths):
// the entries added since the last upload, or the whole registry when the game's registry object is new.

/** Words per registration (`registry::REGISTRATION`). */
const REGISTRATION = 3;
const INSTANCE = /^instance-(0|[1-9]\d*)$/;

/** Per runtime: the registry the core follows, and how many of its entries the core holds. */
const synced = new WeakMap<PhysicsRuntime, { root: ItemRegistry; count: number }>();

interface RegistryExports {
  item_registry_add(world: number, count: number, replace: number): void;
  item_registry_dump(world: number): number;
}

const phaseOf = (label: string): number => { const m = INSTANCE.exec(label); return m ? Number(m[1]) : -1; };

/** Make the core's registry follow the game's: the whole of it when the core follows another, else what was added. */
export function syncRegistry(s: Game, r: PhysicsRuntime): void {
  const root = s.itemIdentities ??= { ids: new Map(), labels: new Map() };
  const seen = synced.get(r), replace = !seen || seen.root !== root;
  const from = replace ? 0 : seen.count;
  if (!replace && from === root.labels.size) return;
  // Interning comes before the input is viewed: each label's body key.
  const rows: number[] = [];
  let i = 0;
  for (const [id, label] of root.labels) {
    if (i++ < from) continue;
    rows.push(id, phaseOf(label), r.world.key(`item:${label}`));
  }
  const { core, world } = r.world.boundaryCall();
  // The input is resized first, since resizing can grow the memory; the view is made after.
  const pointer = core.physics_boundary_input(world, rows.length) >>> 0;
  const view = new Float64Array(core.memory.buffer, pointer, rows.length);
  view.set(rows);
  (core as typeof core & RegistryExports).item_registry_add(world, rows.length / REGISTRATION, replace ? 1 : 0);
  synced.set(r, { root, count: root.labels.size });
}

/**
 * Node took the registrations a core run made itself, which the core holds already: they need no upload. `before` is
 * the registry's size before Node applied them.
 */
export function sawCoreRegistrations(s: Game, r: PhysicsRuntime, before: number): void {
  const seen = synced.get(r), root = s.itemIdentities;
  if (seen && root && seen.root === root && seen.count === before) seen.count = root.labels.size;
}

/** Where the core's registry differs from the game's, as lines; empty when they agree. For tests. */
export function registryDrift(s: Game, r: PhysicsRuntime): string[] {
  const root = s.itemIdentities;
  if (!root) return ['the game has no registry'];
  const { core, world } = r.world.boundaryCall();
  const at = (core as typeof core & RegistryExports).item_registry_dump(world) >>> 0;
  const count = new Float64Array(core.memory.buffer, at, 1)[0]!;
  const words = new Float64Array(core.memory.buffer, at + 8, count * 2 + 1).slice();
  const keys = new Map<number, number>();
  for (let k = 0; k < count; k++) keys.set(words[k * 2]!, words[k * 2 + 1]!);
  const reservedCount = new Float64Array(core.memory.buffer, at + 8 + count * 16, 1)[0]!;
  const reserved = new Set(new Float64Array(core.memory.buffer, at + 16 + count * 16, reservedCount));
  const out: string[] = [];
  if (count !== root.labels.size) out.push(`the core holds ${count} registrations, the game ${root.labels.size}`);
  const phases = new Set<number>();
  for (const [id, label] of root.labels) {
    const key = keys.get(id as ItemId);
    if (key === undefined) out.push(`${id} (${label}) is not in the core's registry`);
    else if (!Object.is(key, r.world.key(`item:${label}`))) out.push(`${id} (${label}): key ${key} != ${r.world.key(`item:${label}`)}`);
    const phase = phaseOf(label);
    if (phase >= 0) phases.add(phase);
  }
  for (const phase of phases) if (!reserved.has(phase)) out.push(`instance-${phase} is not reserved in the core`);
  if (reserved.size !== phases.size) out.push(`the core reserves ${reserved.size} phases, the game ${phases.size}`);
  return out;
}
