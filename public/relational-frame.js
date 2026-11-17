// Numeric relations stay numeric through buffering and drawing. Legacy recordings are adapted once
// when loaded; UI labels come from the captured roster, never from a body identifier.
export function bodyRelations(bodies = []) {
  const byId = new Map(), actors = new Map(), items = new Map(), props = new Map();
  for (const body of bodies) {
    byId.set(body.id, body);
    if (body.owner?.kind === 'actor') actors.set(body.owner.playerIdx, body);
    else if (body.owner?.kind === 'item') items.set(body.owner.itemId, body);
    else if (body.owner?.kind === 'prop') props.set(body.owner.propId, body);
    // Standalone diagnostic callers may still supply a pre-schema-20 frame.
    else if (body.actorId != null) actors.set(body.actorId, body);
    else if (body.itemId != null) items.set(body.itemId, body);
  }
  return { byId, byActor: idx => actors.get(idx), byItem: id => items.get(id), byProp: id => props.get(id) };
}

export function mergeGateGeometry(map, gates = []) {
  if (!map?.gates) return gates.map(g => ({ ...g }));
  const byIndex = new Map(gates.filter(g => g.gateIdx != null).map(g => [g.gateIdx, g]));
  const byLabel = new Map(gates.filter(g => g.id != null).map(g => [g.id, g]));
  return (map?.gates || []).map((gate, gateIdx) => ({ ...gate,
    ...(byIndex.get(gate.gateIdx ?? gateIdx) ?? byLabel.get(gate.id)), gateIdx: gate.gateIdx ?? gateIdx }));
}

export function createFrameNormalizer(initialMap, initialRoster = []) {
  let map = initialMap, roster = [];
  const labels = new Map(), bodyIds = new Map(), tetherIds = new Map(), itemIds = new Map(), propIds = new Map();
  const numeric = (table, id) => {
    if (typeof id === 'number') return id;
    if (!table.has(id)) table.set(id, table.size + 1);
    return table.get(id);
  };
  function seats(value = []) {
    roster = [];
    value.forEach((p, i) => { const idx = p.playerIdx ?? i; roster[idx] = { ...p, playerIdx: idx }; if (p.id != null) labels.set(p.id, idx); });
  }
  seats(initialRoster);
  function normalize(frame) {
    if (!frame) return frame;
    if (frame.roster) seats(frame.roster);
    const source = [...(frame.self ? [frame.self] : []), ...(frame.players || [])];
    // Schemas 10..19 and early full snapshots retain their metadata on each actor.
    for (const p of source) {
      if (p.id == null) continue;
      const idx = p.playerIdx ?? labels.get(p.id) ?? roster.length;
      labels.set(p.id, idx);
      const { id, name, role, kit, seat } = p;
      roster[idx] = { id, name, role, kit, ...(seat == null ? {} : { seat }), playerIdx: idx };
    }
    const bodies = frame.bodies?.map(body => {
      if (body.owner) return body;
      const { actorId, itemId, ...rest } = body;
      const owner = actorId != null ? { kind: 'actor', playerIdx: labels.get(actorId) }
        : itemId != null ? { kind: 'item', itemId: numeric(itemIds, itemId) } : { kind: 'prop', propId: numeric(propIds, body.id) };
      return { ...rest, id: numeric(bodyIds, body.id), owner };
    });
    const relations = bodyRelations(bodies);
    const players = source.map(p => {
      const playerIdx = p.playerIdx ?? labels.get(p.id);
      const metadata = roster[playerIdx] || {};
      const body = relations.byActor(playerIdx);
      return { ...metadata, ...p, playerIdx, ...(body ? { x: body.x, y: body.y } : {}) };
    });
    players.sort((a, b) => a.playerIdx - b.playerIdx);
    const items = frame.items?.map(item => {
      const id = numeric(itemIds, item.id), body = relations.byItem(id);
      return { ...item, id, ...(body ? { x: body.x, y: body.y } : {}) };
    });
    return { ...frame, players, ...(items ? { items } : {}), gates: mergeGateGeometry(map, frame.gates),
      ...(bodies ? { bodies,
        tethers: (frame.tethers || []).map(t => ({ ...t, id: numeric(tetherIds, t.id), a: numeric(bodyIds, t.a), b: numeric(bodyIds, t.b) })),
        hookFlights: (frame.hookFlights || []).map(f => {
          const { casterId, ...rest } = f;
          const a = numeric(bodyIds, f.a), source = relations.byId.get(a);
          const casterIdx = f.casterIdx ?? labels.get(casterId) ?? (source?.owner.kind === 'actor' ? source.owner.playerIdx : undefined);
          return { ...rest, id: numeric(tetherIds, f.id), a, casterIdx };
        }) } : {}) };
  }
  return { normalize, seats, setMap(value) { map = value; } };
}
