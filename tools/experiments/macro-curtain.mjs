/** Isolated #705 macro-boundary experiment; no production registration. */
import { isDeepStrictEqual } from 'node:util';
import { rect } from '../../shared/shape.ts';
import { GAME_ENGINES } from '../../map/engines.ts';
import { builtRegion } from '../../map/micro/result.ts';
import { libraryFingerprint } from '../../map/macro/src/coding.ts';
import { orientDesign, parseKey } from '../../map/macro/src/chain/declared-grid.ts';
import { mapViews } from '../../map/macro/src/chain/map.ts';

const S = 6, CLASS = 'experiment-curtain';
const slotOrder = (a,b) => a.row-b.row || a.col-b.col;
const byId = (a,b) => a.id.localeCompare(b.id);
const keyOf = (axis,x,y) => axis === 'h' ? `h:${y},${x}` : `v:${x},${y}`;

function curtainEngines(beforeBuild) {
  return { version:`experiment-macro-curtain-1+${GAME_ENGINES.version}+input-${beforeBuild}`, compose:GAME_ENGINES.compose, build(brief) {
    if (brief.type !== CLASS) return GAME_ENGINES.build(brief);
    const p=brief.parameters, s=brief.cellSize, wallX=(p.x+1.5)*s;
    const parts=[];
    if (p.gateY>p.y0) parts.push(rect(0,0,s,(p.gateY-p.y0)*s));
    if (p.gateY+4<=p.y1) parts.push(rect(0,(p.gateY+4-p.y0)*s,s,(p.y1+1-p.gateY-4)*s));
    const element={ label:CLASS, x:wallX, y:p.y0*s, template:{w:s,h:(p.y1+1-p.y0)*s,parts:parts.map(shape=>({part:'obstacle',kind:'building',shape}))} };
    return builtRegion(brief,[element],[]);
  } };
}

export function experimentCurtain(before) {
  const original = mapViews(before).resolved, { width, height, cells } = original;
  const x = Math.floor(width / 2) - 2;
  const rows = [];
  for (let y=0; y<height; y++) if (Array.from({length:4},(_,i) => cells[y*width+x+i]).some(Boolean)) rows.push(y);
  const y0 = rows[0], y1 = rows.at(-1);
  const policy = { x, y0, y1, width: 4, gateY: y0 + Math.floor((y1-y0+1)/4), gateHeight: 4 };
  const refusal = reason => ({ map: null, policy, changedIds: [], reusedIds: [], refusal: reason });
  if (x < 0 || x+4 > width || y0 === undefined || y1-y0+1 < 4 || rows.length !== y1-y0+1 || rows.some(y => Array.from({length:4},(_,i) => cells[y*width+x+i]).some(c => !c))) return refusal('nonrectangular-strip');
  if (rows.some(y => Array.from({length:4},(_,i) => before.library.cellClasses[cells[y*width+x+i]]?.coreElements).some(Boolean))) return refusal('core-class-intersection');
  if (before.library.cellClasses[CLASS]) return refusal('class-name-collision');
  const library = structuredClone(before.library), layout = structuredClone(before.layout);
  for (const name of ['tiles','tileSets','setPieces','setPieceClasses']) library[name].sort(byId);
  library.tileSets.forEach(s => s.members.sort());
  library.setPieceClasses.forEach(s => s.setPieces.sort());
  layout.slots.sort(slotOrder); layout.setPieces.sort(byId);
  layout.setPieces.forEach(s => s.slots.sort(slotOrder));
  library.cellClasses[CLASS] = { regionType: CLASS, params: { x, y0, y1, gateY: policy.gateY } };
  const originals = new Map(library.tiles.map(t => [t.id,t]));
  const designs = new Map();
  for (const slot of layout.slots) {
    const oriented = orientDesign(originals.get(slot.design), slot.orientation);
    const id = `experiment-slot-${slot.col}-${slot.row}`;
    if (originals.has(id)) return refusal('design-name-collision');
    const classes = [];
    for (let ly=0;ly<S;ly++) for (let lx=0;lx<S;lx++) {
      const gx=slot.col*S+lx, gy=slot.row*S+ly;
      classes.push(gx>=x && gx<x+4 && gy>=y0 && gy<=y1 ? CLASS : cells[gy*width+gx]);
    }
    // A slot cannot paint an empty class; occupied slots are whole tiles.
    const unique = [...new Set(classes)];
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const marks = new Map(unique.map((c,i) => [c,alphabet[i]]));
    const design = { id, defaultCellClass: unique[0], cells: Array.from({length:S},(_,y) => classes.slice(y*S,y*S+S).map(c => c===unique[0] ? '.' : marks.get(c)).join('')), legend: Object.fromEntries(unique.slice(1).map(c => [marks.get(c),c])), segments: {}, orientations:[0], weight:0 };
    for (const [k,p] of oriented.segments) {
      const {axis,x:lx,y:ly} = parseKey(k), gx=slot.col*S+lx, gy=slot.row*S+ly;
      const touch = axis==='v' ? (gy>=y0 && gy<=y1 && gx>=x && gx<=x+4) : (gy>=y0 && gy<=y1+1 && gx>=x && gx<x+4);
      const value = structuredClone(p);
      if (touch) { delete value.passability; delete value.adjacency; }
      if (Object.keys(value).length) design.segments[keyOf(axis,lx,ly)] = value;
    }
    designs.set(`${slot.col},${slot.row}`,design); library.tiles.push(design);
    slot.design=id; slot.orientation=0;
  }
  // Reauthor each placed instance against the actual slot-specific designs.
  for (const instance of layout.setPieces) {
    const source=library.setPieces.find(p => p.id===instance.setPiece);
    const id=`experiment-piece-${instance.id}`;
    const minCol=Math.min(...instance.slots.map(s=>s.col)), minRow=Math.min(...instance.slots.map(s=>s.row));
    const tiles=instance.slots.map(s => {
      const design=designs.get(`${s.col},${s.row}`), tileSetId=`experiment-set-${s.col}-${s.row}`;
      library.tileSets.push({id:tileSetId,members:[design.id]});
      return {dx:s.col-minCol,dy:s.row-minRow,tileSetId,orientation:0};
    });
    library.setPieces.push({...structuredClone(source),id,tiles});
    library.setPieceClasses.find(c=>c.id===instance.setPieceClass).setPieces.push(id);
    instance.setPiece=id;
  }
  library.tileSets.sort(byId); library.setPieces.sort(byId);
  library.setPieceClasses.forEach(c=>c.setPieces.sort());
  // Write every owning side of a global segment, including both designs on tile seams.
  function guarantee(axis,gx,gy) {
    for (const slot of layout.slots) {
      const lx=gx-slot.col*S, ly=gy-slot.row*S;
      if (axis==='v' ? lx<0 || lx>S || ly<0 || ly>=S : ly<0 || ly>S || lx<0 || lx>=S) continue;
      const d=designs.get(`${slot.col},${slot.row}`), key=keyOf(axis,lx,ly);
      d.segments[key] = { ...d.segments[key], passability:'passable' };
    }
  }
  const provisional = { ...before, layout, library, results: [] };
  for (const {a,b,run} of mapViews(provisional).regions.boundaries) {
    if (!(a.startsWith(`${CLASS}@`) || b.startsWith(`${CLASS}@`)) || run.length<2) continue;
    for (let i=0;i<run.length;i++) guarantee(run.axis,run.x+(run.axis==='h'?i:0),run.y+(run.axis==='v'?i:0));
  }
  // A middle-row crossing guarantees the full gate footprint without requiring a
  // portal inside the single curtain region.
  for (let i=0;i<4;i++) guarantee('v',x+i+1,policy.gateY+1);
  // A cut can leave a formerly valid portal with a one-segment remainder just
  // outside the strip. Remove only newly short portals, once, in authored sides.
  const shortKeys = view => view.regions.portals.filter(p => p.length < 2).flatMap(p =>
    Array.from({length:p.length},(_,i) => `${p.axis}:${p.x+(p.axis==='h'?i:0)},${p.y+(p.axis==='v'?i:0)}`));
  const oldShort = new Set(shortKeys(mapViews(before)));
  const trimmed = shortKeys(mapViews(provisional)).filter(k => !oldShort.has(k)).sort();
  for (const key of trimmed) {
    const {axis,x:gx,y:gy}=parseKey(key);
    for (const slot of layout.slots) {
      const lx=gx-slot.col*S, ly=gy-slot.row*S;
      if (axis==='v' ? lx<0 || lx>S || ly<0 || ly>=S : ly<0 || ly>S || lx<0 || lx>=S) continue;
      const d=designs.get(`${slot.col},${slot.row}`), k=keyOf(axis,lx,ly), p=d.segments[k];
      if (p) { delete p.passability; if (!Object.keys(p).length) delete d.segments[k]; }
    }
  }
  policy.trimmedSegments=trimmed;
  library.tiles.sort(byId); layout.library=libraryFingerprint(library);
  const map = { layout, library, cellSize:before.cellSize, build:curtainEngines(before.build).version, results:[] };
  const old = new Map(before.results.map(r => [r.brief.id,r]));
  const changedIds=[], reusedIds=[];
  map.results = mapViews(map).briefs.map(brief => {
    const prior=old.get(brief.id);
    if (prior && isDeepStrictEqual(prior.brief,brief)) { reusedIds.push(brief.id); return structuredClone(prior); }
    changedIds.push(brief.id);
    return curtainEngines(before.build).build(brief);
  });
  return { map, policy, changedIds, reusedIds };
}
