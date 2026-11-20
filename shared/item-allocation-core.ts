import { initCore, type CoreExports } from './core.ts';
import type { Game, InventoryItem, ItemId, ItemLabel } from './types.ts';

// Item counter ownership after initItemAllocation is Rust's (27, D6). The synchronous
// setup APIs may run before a core is bound; undefined asks their caller to use its
// existing setup path. Labels and registry parent layers remain JS compatibility metadata.
interface ItemAllocationExports {
  item_allocation_new(): number;
  item_allocation_input(state: number, len: number): number;
  item_allocation_run(state: number): number;
}
let bound: { core: CoreExports & ItemAllocationExports; state: number } | undefined;
let loading: Promise<void> | undefined;
export const initItemAllocation = (): Promise<void> => loading ??= initCore().then(loaded => {
  const core = loaded as CoreExports & ItemAllocationExports;
  bound = { core, state: core.item_allocation_new() >>> 0 };
});

function labelKnown(s: Game, label: string): boolean {
  for (let r = s.itemIdentities; r; r = r.parent) if (r.ids.has(label)) return true;
  return false;
}
function idKnown(s: Game, id: ItemId | undefined): boolean {
  if (id === undefined) return false;
  for (let r = s.itemIdentities; r; r = r.parent) if (r.labels.has(id)) return true;
  return false;
}
function validMetadata(item: InventoryItem): boolean {
  return (item.quality === undefined || Number.isInteger(item.quality) && item.quality >= 1 && item.quality <= 5)
    && (item.instanceId === undefined || Number.isSafeInteger(item.instanceId) && item.instanceId > 0)
    && (item.lineageId === undefined || Number.isSafeInteger(item.lineageId) && item.lineageId > 0);
}

/** Mirrors item_allocation.rs's seventeen-word input and sixteen-word output. */
function run(s: Game, mode: number, item?: InventoryItem): number | undefined {
  if (!bound) return undefined;
  const { core, state } = bound;
  const numericSerial = s.itemSerial ?? 1, numericScatter = s.scatterSerial ?? 0;
  const serial = typeof numericSerial === 'number' ? numericSerial : NaN;
  const scatter = typeof numericScatter === 'number' ? numericScatter : NaN;
  const valid = !item || validMetadata(item);
  let phase = scatter;
  if (mode !== 2 && valid && (!item || item.instanceId === undefined)
    && Number.isSafeInteger(phase) && phase >= 0) {
    while (phase < Number.MAX_SAFE_INTEGER && labelKnown(s, `instance-${phase}`)) phase++;
  }
  const input = core.item_allocation_input(state, 17) >>> 0;
  new Float64Array(core.memory.buffer, input, 17).set([
    mode, serial, scatter, phase, +valid, +(!!item && idKnown(s, item.instanceId)), +(!!item && idKnown(s, item.lineageId)),
    NaN, NaN, NaN, NaN, NaN, item?.instanceId ?? NaN, item?.lineageId ?? NaN, item?.quality ?? NaN, NaN,
    (item?.instanceId === undefined ? 4 : 0) | (item?.lineageId === undefined ? 8 : 0) | (item?.quality === undefined ? 16 : 0),
  ]);
  const output = core.item_allocation_run(state) >>> 0;
  const result = new Float64Array(core.memory.buffer, output, 16);
  // Publish even on failure: ensureItemIdentity may allocate and fill lineage
  // before discovering that an existing metadata root is unregistered.
  if (!Object.is(result[1], serial)) s.itemSerial = result[1];
  if (!Object.is(result[2], scatter)) s.scatterSerial = result[2];
  if (!Number.isNaN(result[14])) {
    const id = result[14] as ItemId, label = `instance-${result[15]}` as ItemLabel;
    const registry = s.itemIdentities ??= { ids: new Map(), labels: new Map() };
    registry.ids.set(label, id); registry.labels.set(id, label);
  }
  if (item && result[0] !== 3) {
    if (!Object.is(result[9], item.instanceId ?? NaN)) item.instanceId = result[9] as ItemId;
    if (!Object.is(result[10], item.lineageId ?? NaN)) item.lineageId = result[10] as ItemId;
  }
  switch (result[0]) {
    case 1: throw new Error('Invalid item scatter counter');
    case 2: throw new Error('Item instance counter exhausted');
    case 3: throw new Error('Invalid carried item identity');
    case 4: throw new Error(`Unregistered item identity ${result[9]}`);
    case 5: throw new Error(`Unregistered item identity ${result[10]}`);
  }
  return result[3];
}

export const allocateInCore = (s: Game): ItemId | undefined => run(s, 0) as ItemId | undefined;
export function ensureInCore(s: Game, item: InventoryItem): true | undefined {
  if (!bound) return undefined;
  run(s, 1, item);
  return true;
}
/** Called after the caller has checked whether the explicit label already exists. */
export const nextItemIdInCore = (s: Game): ItemId | undefined => run(s, 2) as ItemId | undefined;
