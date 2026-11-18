// Engine-free joins shared by projections, discovery, live drawing and replay.
// Captured records are immutable: unchanged values keep their source identity.
type Id = string | number;
type Owner = { kind: 'actor'; playerIdx: number } | { kind: 'item'; itemId: Id } | { kind: 'prop'; propId: Id };
type Row = Record<string, unknown> & {
  id?: Id | undefined; playerIdx?: number | undefined; gateIdx?: number | undefined; owner?: Owner | undefined; actorId?: Id | undefined; itemId?: Id | undefined;
  x?: number | undefined; y?: number | undefined; a?: Id | undefined; b?: Id | undefined; casterId?: Id | undefined; casterIdx?: number | undefined;
};
type Frame = Record<string, unknown> & {
  self?: Row; players?: Row[]; items?: Row[]; gates?: Row[]; bodies?: Row[];
  roster?: Row[]; tethers?: Row[]; hookFlights?: Row[];
};
const EMPTY: Row[] = [], NONE = {};
const rows = (list: readonly object[]) => list as Row[];

const relationsCache = new WeakMap<readonly object[], ReturnType<typeof indexBodies>>();
function indexBodies(bodies: readonly Row[]) {
  const byId = new Map<Id, Row>(), actors = new Map<Id, Row>(), items = new Map<Id, Row>(), props = new Map<Id, Row>();
  for (const body of bodies) {
    byId.set(body.id!, body);
    if (body.owner?.kind === 'actor') actors.set(body.owner.playerIdx, body);
    else if (body.owner?.kind === 'item') items.set(body.owner.itemId, body);
    else if (body.owner?.kind === 'prop') props.set(body.owner.propId, body);
    else if (body.actorId != null) actors.set(body.actorId, body);
    else if (body.itemId != null) items.set(body.itemId, body);
  }
  return { byId, actors, items, props, byActor: (idx: Id) => actors.get(idx), byItem: (id: Id) => items.get(id), byProp: (id: Id) => props.get(id) };
}
export function bodyRelations(bodies: readonly object[] = EMPTY) {
  let value = relationsCache.get(bodies);
  if (!value || value.byId.size !== bodies.length) { value = indexBodies(rows(bodies)); relationsCache.set(bodies, value); }
  return value;
}

const poseCache = new WeakMap<Row, WeakMap<Row, Row>>(), compactCache = new WeakMap<object, object>();
const expandedRecords = new WeakMap<Row, Row>(), expandedLists = new WeakMap<readonly object[], Row[]>();
function atBody(record: Row, body: Row | undefined): Row {
  if (!body || record.x === body.x && record.y === body.y) return record;
  const original = expandedRecords.get(record);
  if (original && original.x === body.x && original.y === body.y) return original;
  let byBody = poseCache.get(record);
  if (!byBody) poseCache.set(record, byBody = new WeakMap());
  let posed = byBody.get(body);
  if (!posed) { posed = { ...record, x: body.x, y: body.y }; if (Object.isFrozen(record)) Object.freeze(posed); byBody.set(body, posed); }
  return posed;
}
export function omitBodyPose<T extends object>(record: T): Omit<T, 'x' | 'y'> {
  let copy = Object.isFrozen(record) ? compactCache.get(record) : undefined;
  if (!copy) {
    const { x, y, ...rest } = record as T & { x?: number; y?: number };
    copy = rest;
    if (Object.isFrozen(record)) {
      compactCache.set(record, copy = Object.freeze(copy));
      expandedRecords.set(copy as Row, record as Row);
    }
  }
  return copy as Omit<T, 'x' | 'y'>;
}
const compactLists = new WeakMap<readonly object[], { ids: Set<Id>; list: object[] }>();
export function compactItems<T extends object>(items: readonly T[], bodies: readonly object[] = EMPTY): Array<Omit<T, 'x' | 'y'>> {
  const physical = bodyRelations(bodies).items;
  const was = compactLists.get(items);
  if (was && was.ids.size === physical.size && [...physical.keys()].every(id => was.ids.has(id))) return was.list as T[];
  const list = physical.size ? items.map(item => physical.has((item as Row).id!) ? omitBodyPose(item) : item) : items;
  if (list !== items) expandedLists.set(list, rows(items));
  compactLists.set(items, { ids: new Set(physical.keys()), list: list as object[] });
  return list as T[];
}

function sameBodies(a: ReadonlyMap<Id, Row>, b: ReadonlyMap<Id, Row>) {
  return a.size === b.size && [...a].every(([id, body]) => b.get(id) === body);
}
const itemLists = new WeakMap<readonly object[], { bodies: ReadonlyMap<Id, Row>; list: Row[] }>();
function poseItems(items: Row[], bodies: ReadonlyMap<Id, Row>) {
  const was = itemLists.get(items);
  if (was && sameBodies(was.bodies, bodies)) return was.list;
  let changed = false;
  const list = items.map(item => { const posed = atBody(item, bodies.get(item.id!)); changed ||= posed !== item; return posed; });
  const original = expandedLists.get(items);
  const result = original && list.every((row, i) => row === original[i]) ? original : changed ? list : items;
  itemLists.set(items, { bodies, list: result });
  return result;
}

const gateRecords = new WeakMap<Row, WeakMap<Row, Row>>();
const gateLists = new WeakMap<readonly object[], WeakMap<readonly object[], Row[]>>();
export function mergeGateGeometry<T extends object>(map: { gates?: readonly T[] } | undefined, gates: readonly object[] = EMPTY): T[] {
  const geometry = map?.gates;
  if (!geometry) return gates as T[];
  let byStates = gateLists.get(geometry);
  if (!byStates) gateLists.set(geometry, byStates = new WeakMap());
  const held = byStates.get(gates);
  if (held) return held as T[];
  const states = rows(gates), byIndex = new Map(states.filter(g => g.gateIdx != null).map(g => [g.gateIdx!, g]));
  const byLabel = new Map(states.filter(g => g.id != null).map(g => [g.id!, g]));
  const list = rows(geometry).map((gate, idx) => {
    const gateIdx = gate.gateIdx ?? idx, state = byIndex.get(gateIdx) ?? byLabel.get(gate.id!);
    if (!state && gate.gateIdx === gateIdx) return gate;
    const source = state ?? gate;
    if (source.gateIdx === gateIdx && Object.keys(gate).every(key => Object.is(source[key], gate[key]) || key === 'open' || key === 'locked')) return source;
    let byState = gateRecords.get(gate);
    if (!byState) gateRecords.set(gate, byState = new WeakMap());
    let result = byState.get(source);
    if (!result) { result = { ...gate, ...state, gateIdx }; byState.set(source, result); }
    return result;
  });
  byStates.set(gates, list);
  return list as T[];
}

type Hydrated = { refs: unknown[]; frame: Frame };
const capturedFrames = new WeakMap<object, Hydrated>();
/** Join a numeric captured frame once; metadata already on recorded players is preserved. */
export function hydrateFrame<T extends object>(source: T, map?: { gates?: readonly object[] }): T {
  const frame = source as Frame, refs = [frame.players, frame.items, frame.bodies, frame.gates, map?.gates];
  const was = capturedFrames.get(source);
  if (was && refs.every((value, i) => value === was.refs[i])) return was.frame as T;
  const relations = bodyRelations(frame.bodies);
  const players = frame.players?.map(p => atBody(p, relations.byActor(p.playerIdx ?? p.id!)));
  const items = frame.items && poseItems(frame.items, relations.items);
  const gates = rows(mergeGateGeometry(map, frame.gates));
  const result = { ...frame, ...(players ? { players: players.every((p, i) => p === frame.players![i]) ? frame.players : players } : {}),
    ...(items ? { items } : {}), gates };
  capturedFrames.set(source, { refs, frame: result });
  return result as T;
}

/** Stateful only for a connection/archive's legacy labels and out-of-band seat metadata. */
/** A map's prediction constants as a welcome or ready carries them (24.3 proposal 3, PredictionConstants). */
type Constants = { physicsProfile: string; predictionMotor: object } | null | undefined;
/**
 * A live frame with its connection's match constants back where the projection used to put them: the profile on
 * a frame with bodies, the motor on one the viewer predicts in (it has `self`). A frame that carries its own, as
 * a recorded one does, keeps them; without constants the frame is returned as it is.
 */
export function withMatchConstants<T extends object>(source: T, constants: Constants): T {
  const frame = source as Frame;
  if (!constants || !frame.bodies) return source;
  const profile = frame.physicsProfile === undefined, motor = !!frame.self && frame.predictionMotor === undefined;
  if (!profile && !motor) return source;
  return { ...frame, ...(profile ? { physicsProfile: constants.physicsProfile } : {}), ...(motor ? { predictionMotor: constants.predictionMotor } : {}) } as T;
}
export function createFrameNormalizer(initialMap?: { gates?: readonly object[] }, initialRoster: readonly object[] = EMPTY) {
  // `revision` counts this normalizer's own roster changes, for its frame cache. `heldRevision` is the wire's
  // roster revision (#1131) that the last `seats` named; every live frame names the one it was projected against.
  let map = initialMap, roster = new Map<number, Row>(), revision = 0, constants: Constants, heldRevision: number | undefined;
  // Labels a `seats` roster taught, pruned when a later one no longer names them; labels learned from legacy
  // recorded frames, which carry no roster, are kept.
  let seatLabels = new Set<Id>();
  const nextSlot = () => roster.size ? Math.max(...roster.keys()) + 1 : 0;
  const labels = new Map<Id, number>(), bodyIds = new Map<Id, number>(), tetherIds = new Map<Id, number>(), itemIds = new Map<Id, number>(), propIds = new Map<Id, number>();
  const bodiesCache = new WeakMap<Row, { owner: Id | undefined; row: Row }>();
  const metadataCache = new WeakMap<Row, Row>(), playerCache = new WeakMap<Row, WeakMap<object, Row>>(), itemCache = new WeakMap<Row, Row>();
  const lists = new WeakMap<readonly object[], Row[]>(), tetherCache = new WeakMap<Row, Row>(), flightCache = new WeakMap<Row, Row>();
  const frames = new WeakMap<object, { revision: number; map: unknown; constants: Constants; result: object }>();
  const numeric = (table: Map<Id, number>, id: Id): number => {
    if (typeof id === 'number') return id;
    if (!table.has(id)) table.set(id, table.size + 1);
    return table.get(id)!;
  };
  function metadata(p: Row, idx: number): Row {
    const current = roster.get(idx);
    if (current && ['id', 'name', 'role', 'kit', 'seat'].every(key => current[key] === p[key])) return current;
    let record = metadataCache.get(p);
    if (!record || record.playerIdx !== idx) {
      const { id, name, role, kit, seat } = p;
      record = { id, name, role, kit, ...(seat == null ? {} : { seat }), playerIdx: idx };
      metadataCache.set(p, record);
    }
    return record;
  }
  function seats(value: readonly object[] = EMPTY, wireRevision?: number) {
    // Keyed by slot: a yard roster has gaps where people left (24.4).
    const next = new Map<number, Row>(), named = new Set<Id>();
    rows(value).forEach((p, i) => {
      const idx = p.playerIdx ?? i; next.set(idx, metadata(p, idx));
      if (p.id != null) { labels.set(p.id, idx); named.add(p.id); }
    });
    for (const id of seatLabels) if (!named.has(id)) labels.delete(id);
    seatLabels = named;
    let changed = next.size !== roster.size;
    for (const [idx, row] of next) if (changed || roster.get(idx) !== row) { changed = true; break; }
    if (changed) revision++;
    roster = next; heldRevision = wireRevision;
  }
  seats(initialRoster);
  const convertList = (list: Row[] | undefined, cache: WeakMap<Row, Row>, convert: (row: Row) => Row) => {
    if (!list) return undefined;
    const held = lists.get(list);
    if (held) return held;
    const out = list.map(row => { let value = cache.get(row); if (!value) { value = convert(row); cache.set(row, value); } return value; });
    const result = out.every((row, i) => row === list[i]) ? list : out;
    lists.set(list, result);
    return result;
  };
  function normalize<T extends object>(source: T): T {
    if (!source) return source;
    const frame = source as Frame;
    // Never draw a frame against another roster than it names (#1131). One ordered socket always sends `seats`
    // first; what a client does without it on a lossy transport is #1094's to decide.
    if (typeof frame.rosterRevision === 'number' && heldRevision !== undefined && frame.rosterRevision !== heldRevision) {
      throw new Error(`a frame names roster revision ${frame.rosterRevision}, but revision ${heldRevision} is held`);
    }
    if (frame.roster) seats(frame.roster);
    const players = frame.self ? [frame.self, ...(frame.players ?? [])] : frame.players ?? EMPTY;
    for (const p of players) if (p.id != null) {
      const idx = p.playerIdx ?? labels.get(p.id) ?? nextSlot();
      const record = metadata(p, idx);
      if (record !== roster.get(idx)) { roster.set(idx, record); revision++; }
      labels.set(p.id, idx);
    }
    const held = frames.get(source);
    if (held?.revision === revision && held.map === map?.gates && held.constants === constants) return held.result as T;
    const mappedBodies = frame.bodies?.map(body => {
      if (body.owner) return body;
      const actor = body.actorId != null ? labels.get(body.actorId) : undefined;
      const held = bodiesCache.get(body), relation = body.actorId != null ? actor : body.itemId;
      if (held && held.owner === relation) return held.row;
      const { actorId, itemId, ...rest } = body;
      const owner: Owner = actorId != null ? { kind: 'actor', playerIdx: actor! }
        : itemId != null ? { kind: 'item', itemId: numeric(itemIds, itemId) } : { kind: 'prop', propId: numeric(propIds, body.id!) };
      const row = { ...rest, id: numeric(bodyIds, body.id!), owner };
      bodiesCache.set(body, { owner: relation, row }); return row;
    });
    const bodies = mappedBodies?.every((body, i) => body === frame.bodies![i]) ? frame.bodies : mappedBodies;
    const joined = players.map(p => {
      const playerIdx = p.playerIdx ?? labels.get(p.id!)!, meta = roster.get(playerIdx);
      if (p.playerIdx === playerIdx && (!meta || Object.keys(meta).every(key => Object.is(p[key], meta[key])))) return p;
      let byMeta = playerCache.get(p); if (!byMeta) playerCache.set(p, byMeta = new WeakMap());
      const key = meta ?? NONE;
      let row = byMeta.get(key); if (!row) { row = { ...meta, ...p, playerIdx }; byMeta.set(key, row); } return row;
    });
    joined.sort((a, b) => a.playerIdx! - b.playerIdx!);
    const items = convertList(frame.items, itemCache, item => typeof item.id === 'number' ? item : { ...item, id: numeric(itemIds, item.id!) });
    const relations = bodyRelations(bodies);
    const tethers = convertList(frame.tethers, tetherCache, t => typeof t.id === 'number' && typeof t.a === 'number' && typeof t.b === 'number' ? t
      : { ...t, id: numeric(tetherIds, t.id!), a: numeric(bodyIds, t.a!), b: numeric(bodyIds, t.b!) });
    const hookFlights = convertList(frame.hookFlights, flightCache, f => {
      const a = numeric(bodyIds, f.a!), caster = relations.byId.get(a)?.owner;
      const casterIdx = f.casterIdx ?? labels.get(f.casterId!) ?? (caster?.kind === 'actor' ? caster.playerIdx : undefined);
      if (typeof f.id === 'number' && f.a === a && f.casterIdx === casterIdx) return f;
      const { casterId, ...rest } = f;
      return { ...rest, id: numeric(tetherIds, f.id!), a, casterIdx };
    });
    // The revision is the transport's: the rebuilt frame is the projection, without it.
    const { rosterRevision: _transport, ...projected } = frame;
    const numericFrame = withMatchConstants({ ...projected, players: joined, ...(items ? { items } : {}),
      ...(bodies ? { bodies, tethers: tethers ?? EMPTY, hookFlights: hookFlights ?? EMPTY } : {}) }, constants);
    const result = hydrateFrame(numericFrame, map);
    frames.set(source, { revision, map: map?.gates, constants, result });
    return result as T;
  }
  /** What a welcome or ready says about the frames that follow it: their roster, map and match constants. A
   * welcome's roster names no revision, so the next `seats` (which the server always sends first) sets it. */
  function envelope(message: { roster?: readonly object[]; map?: { gates?: readonly object[] } | null; constants?: Constants }) {
    seats(message.roster); map = message.map ?? undefined; constants = message.constants;
  }
  return { normalize, seats, envelope, setMap(value: { gates?: readonly object[] } | undefined) { map = value; } };
}
