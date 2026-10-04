import { visibilityPolygon, gateShape, insideMap } from '/shared/movement.ts';
import { playerZoom, markerScale, labelScale, LABEL_FONT_PX, viewBounds, viewRadius, seesPoint, seesActor, observeGates, buildingAt } from '/shared/view.ts';
import { shapeOf, outline, bounds } from '/shared/shape.ts';
import { observe, start, stop, count, frame as endProfileFrame } from '/shared/profiler.ts';
import { noteFrame } from '/diagnostics.js';

const COLORS = { access: 0xf4d26c, med: 0xff8b97, weapon: 0x8bd9f0, shield: 0xa3b9ff, cell: 0xffe98a };
const PALETTE = [0x8d5669, 0x526f80, 0x8c815a];
// Eye settling time constant, chosen to match the previous `delta / 40` at 60 Hz.
const EYE_TAU_MS = 31;
// Static world geometry is recorded once and rasterised into cached tile textures, so a frame blits a
// few quads instead of re-tessellating every shape. Phaser's Graphics replays and re-triangulates its
// whole command list on every render; it is not a cache. Recorded drawings are indexed by CELL squares.
const CELL = 512;
// A tile spans CELL << level world units. The level rises as the camera pulls back, so a tile stays at
// least this many screen pixels across and a whole-arena view needs a handful of tiles, not hundreds.
const MIN_TILE_PIXELS = 256;
// Tiles kept rasterised beyond the view, so walking into a tile rarely has to build it on that frame.
const PREFETCH_TILES = 1, RETAIN_TILES = 3;
// Tile building allowed per frame. At least one tile is built, the most urgent first.
const BUILD_MS = 8;
// Texels per world unit are multiples of 1/16, so a tile is always a whole number of texels.
const MIN_RESOLUTION = 1 / 16, MAX_RESOLUTION = 2;
// Each tile's texture overlaps its neighbours by one texel, or filtering blends its edge with nothing
// and the tile grid shows as faint seams. Drawings this close to a tile are drawn into it.
const SEAM = 1 / MIN_RESOLUTION;
// Each Graphics method the static layer draws with, recorded for replay into the tiles it touches.
const STATIC_DRAWS = ['fillStyle', 'lineStyle', 'fillPoints', 'strokePoints', 'fillRect', 'strokeRect', 'fillRoundedRect', 'strokeRoundedRect', 'lineBetween', 'fillCircle', 'fillEllipse', 'fillTriangle'];
const obstacleFill = o => o.kind === 'fence' ? 0x53636b : o.kind === 'building' ? 0x92929e : PALETTE[o.color || 0];
export function makeArenaScene(api) {
  return class ArenaScene extends Phaser.Scene {
    constructor() { super('arena'); }
    preload() { this.load.svg('contestant', '/assets/contestant.svg', { width: 80, height: 80 }); this.load.svg('gladiator', '/assets/warden.svg', { width: 100, height: 100 }); }
    create() {
      this.ready = true; this.cameras.main.setBackgroundColor('#162a29');
      this.world = this.add.container(0, 0);
      // Terrain, structures and fixtures are drawn everywhere and dimmed where they are out of sight,
      // so the arena stays legible instead of being cut away. Only actors, loot, shots and effects are
      // withheld, and they sit above the shade so anything in view reads at full brightness.
      this.drawings = []; this.drawingsByCell = new Map(); this.tiles = new Map();
      this.scratch = this.make.graphics({ x: 0, y: 0, add: false }); this.decor = this.add.container(0, 0);
      this.fixtures = this.add.graphics(); this.shade = this.add.graphics(); this.dynamic = this.add.graphics();
      // Static tile textures are inserted at index 0, beneath everything here.
      this.world.add([this.decor, this.fixtures, this.shade, this.dynamic]);
      this.roofs = new Map(); this.roofLayer = this.add.container(0, 0); this.world.add(this.roofLayer);
      this.actors = new Map(); this.labels = []; this.eye = null;
      this.marker = 1; this.nameScale = 1 / LABEL_FONT_PX;
      this.vision = this.make.graphics({ x: 0, y: 0, add: false });
      this.shadeMask = this.vision.createGeometryMask();
      this.shadeMask.invertAlpha = true;
      this.shade.setMask(this.shadeMask);
      this.crosshair = this.add.graphics();
      this.input.on('pointerdown', p => {
        if (!p.leftButtonDown()) return;
        if (!api.replay()) { api.onFire(true); return; }
        // Clicking a marker is the fastest way to pick a subject out of a crowd; the roster select
        // covers anyone too small, too distant or not currently on screen to hit.
        const target = this.playerAt(p);
        if (target) api.onFollow(target.id);
      });
      this.input.on('pointerup', () => api.onFire(false));
      this.game.canvas.addEventListener('contextmenu', e => e.preventDefault());
      this.game.canvas.style.cursor = 'crosshair';
      this.scale.on('resize', () => this.updateCamera(true));
      api.onReady(this); if (api.map()) this.buildMap();
    }
    label(x, y, text, color = '#2c514b', size = 12) {
      const label = this.add.text(x, y, text, { fontFamily: 'Arial', fontSize: size, fontStyle: 'bold', color }).setOrigin(0.5);
      this.labels.push(label); this.decor.add(label);
    }
    /**
     * A recorder for one static drawing inside the given world box. Its calls are replayed into every
     * tile the box touches, and each tile's texture clips them to its own square, so a shape that
     * straddles a seam is drawn whole on both sides of it.
     */
    staticAt(left, top, right, bottom) {
      const id = this.drawings.length, calls = [];
      this.drawings.push(calls);
      for (let cy = Math.floor((top - SEAM) / CELL); cy <= Math.floor((bottom + SEAM) / CELL); cy++) for (let cx = Math.floor((left - SEAM) / CELL); cx <= Math.floor((right + SEAM) / CELL); cx++) {
        const key = `${cx},${cy}`;
        if (!this.drawingsByCell.has(key)) this.drawingsByCell.set(key, []);
        this.drawingsByCell.get(key).push(id);
      }
      const recorder = {};
      for (const method of STATIC_DRAWS) recorder[method] = (...args) => { calls.push(method, args); return recorder; };
      return recorder;
    }
    /** Rasterise the drawings that touch a tile, in the order they were recorded. */
    rasterise(tile, resolution) {
      const cells = 1 << tile.level, span = CELL * cells, left = tile.tx * span, top = tile.ty * span;
      const ids = new Set();
      for (let cy = tile.ty * cells; cy < (tile.ty + 1) * cells; cy++) for (let cx = tile.tx * cells; cx < (tile.tx + 1) * cells; cx++)
        for (const id of this.drawingsByCell.get(`${cx},${cy}`) || []) ids.add(id);
      tile.resolution = resolution;
      if (!ids.size) { tile.empty = true; return; }
      // The tile plus one texel of its neighbours on every side; see SEAM.
      const size = span * resolution + 2, texel = 1 / resolution;
      // A new texture rather than resize(), which left content clipped and offset in Phaser 3.90.
      if (tile.texture?.width !== size) {
        tile.texture?.destroy();
        tile.texture = this.add.renderTexture(left - texel, top - texel, size, size).setOrigin(0, 0); this.world.addAt(tile.texture, 0);
      }
      const g = this.scratch.clear().setScale(resolution);
      for (const id of [...ids].sort((a, b) => a - b)) { const calls = this.drawings[id]; for (let i = 0; i < calls.length; i += 2) g[calls[i]](...calls[i + 1]); }
      tile.texture.clear().setScale(texel).draw(g, 1 - left * resolution, 1 - top * resolution);
      g.clear();
      count('work.tileRasterise');
    }
    /**
     * Show the tiles the camera can see, rasterise what they lack within a frame budget, and release
     * textures far from the view or at another level.
     */
    updateTiles() {
      // worldView is only refreshed when the camera renders, a frame behind centerOn, so derive it here.
      const camera = this.cameras.main, zoom = camera.zoom;
      const view = { width: camera.width / zoom, height: camera.height / zoom };
      view.x = camera.scrollX + camera.width / 2 - view.width / 2; view.y = camera.scrollY + camera.height / 2 - view.height / 2;
      // At least one texel per screen pixel, quantised so a window resize does not rebuild every tile.
      const resolution = Math.min(MAX_RESOLUTION, Math.max(MIN_RESOLUTION, Math.ceil(zoom * 16) / 16));
      const level = Math.max(0, Math.ceil(Math.log2(MIN_TILE_PIXELS / (CELL * zoom))));
      const span = CELL << level;
      const range = margin => ({ left: Math.floor(view.x / span) - margin, top: Math.floor(view.y / span) - margin, right: Math.floor((view.x + view.width) / span) + margin, bottom: Math.floor((view.y + view.height) / span) + margin });
      const shown = range(0), wanted = range(PREFETCH_TILES), kept = range(RETAIN_TILES);
      const within = (tile, r) => tile.tx >= r.left && tile.tx <= r.right && tile.ty >= r.top && tile.ty <= r.bottom;
      for (const [key, tile] of this.tiles) if (tile.level !== level || !within(tile, kept)) { tile.texture?.destroy(); this.tiles.delete(key); }
      const centre = { x: (view.x + view.width / 2) / span, y: (view.y + view.height / 2) / span };
      const queue = [];
      for (let ty = wanted.top; ty <= wanted.bottom; ty++) for (let tx = wanted.left; tx <= wanted.right; tx++) {
        const key = `${level}:${tx}:${ty}`;
        let tile = this.tiles.get(key);
        if (!tile) this.tiles.set(key, tile = { level, tx, ty, texture: null, resolution: 0, empty: false });
        const visible = within(tile, shown);
        tile.texture?.setVisible(visible);
        // A visible hole first, then a visible tile at a stale resolution, then prefetch.
        if (!tile.empty && tile.resolution !== resolution) queue.push({ tile, visible, rank: visible ? tile.texture ? 1 : 0 : 2, distance: Math.hypot(tx + 0.5 - centre.x, ty + 0.5 - centre.y) });
      }
      queue.sort((a, b) => a.rank - b.rank || a.distance - b.distance);
      const started = performance.now();
      for (const [index, { tile, visible }] of queue.entries()) {
        if (index && performance.now() - started > BUILD_MS) break;
        this.rasterise(tile, resolution); tile.texture?.setVisible(visible);
      }
    }
    buildMap() {
      const map = api.map(); let g;
      if (!map?.obstacles) return;
      for (const tile of this.tiles.values()) tile.texture?.destroy();
      this.drawings = []; this.drawingsByCell = new Map(); this.tiles = new Map();
      this.labels.forEach(l => l.destroy()); this.labels = [];
      this.gateMemory = new Map(); this.rememberedGates = []; this.eye = null; this.sightMap = { ...map };
      this.actors.forEach(a => a.container.destroy()); this.actors.clear();
      for (const roof of this.roofs.values()) roof.destroy(); this.roofs.clear();
      // Chain starts can be right by the western edge. Follow must still centre on
      // that subject at every viewport/zoom; its authoritative position is bounded.
      if (map.playableArea) this.cameras.main.removeBounds();
      else this.cameras.main.setBounds(-400, -400, map.width + 800, map.height + 800);
      if (map.playableArea) {
        const { cellSize, rows } = map.playableArea;
        for (const row of rows) for (const [start, end] of row.runs)
          this.staticAt(start * cellSize, row.y * cellSize, end * cellSize, (row.y + 1) * cellSize).fillStyle(0x39454c).fillRect(start * cellSize, row.y * cellSize, (end - start) * cellSize, cellSize);
      } else {
        const diamond = [{ x: 40, y: map.height / 2 }, { x: map.width / 2, y: 40 }, { x: map.width - 40, y: map.height / 2 }, { x: map.width / 2, y: map.height - 40 }];
        g = this.staticAt(0, 0, map.width, map.height); g.fillStyle(0x39454c); g.fillPoints(diamond, true);
        g.lineStyle(8, 0x729b9e); g.strokePoints(diamond, true);
      }
      // Broad paths connect generated sections. There are no visible grid cells.
      for (const route of map.streets?.map(st => ({ points: [st.a, st.port, st.b] })) || map.routes || [{ points: [{ x: 160, y: map.height / 2 }, ...map.modules, map.exit] }]) {
        for (let i = 1; i < route.points.length; i++) {
          const a = route.points[i - 1], b = route.points[i], half = map.streets ? 80 : 50;
          g = this.staticAt(Math.min(a.x, b.x) - half, Math.min(a.y, b.y) - half, Math.max(a.x, b.x) + half, Math.max(a.y, b.y) + half);
          g.lineStyle(map.streets ? 160 : 100, 0x596269); g.lineBetween(a.x, a.y, b.x, b.y);
          g.lineStyle(2, 0xa5bbc0, 0.35); g.lineBetween(a.x, a.y, b.x, b.y);
        }
      }
      for (const m of map.modules) {
        g = this.staticAt(m.x - 130, m.y - 270, m.x + 130, m.y - 90);
        // These are ground markings, not fake building silhouettes.
        if (m.kind === 'depot') {
          g.lineStyle(2, 0x9daab0, 0.3);
          for (let dx = -120; dx <= 120; dx += 60) g.lineBetween(m.x + dx, m.y - 130, m.x + dx, m.y - 100);
        } else if (m.kind === 'garden') {
          g.fillStyle(0x44584e, 0.45); g.fillEllipse(m.x, m.y - 210, 220, 100);
        }
        this.label(m.x, m.y - 75, ['SERVICE YARD', 'RUINED DEPOT', 'OVERGROWN BLOCK'][['yard', 'depot', 'garden'].indexOf(m.kind)], '#91b9bc', 13);
        if (m.interior) { g = this.staticAt(m.interior.x, m.interior.y, m.interior.x + m.interior.w, m.interior.y + m.interior.h); g.fillStyle(0x50505d); g.fillRect(m.interior.x, m.interior.y, m.interior.w, m.interior.h); }
      }
      for (let i = 0; i < 430; i++) {
        const x = (i * 479 + map.seed * 7) % map.width, y = (i * 193 + map.seed * 13) % map.height;
        if (map.playableArea ? !insideMap(map, x, y, 5) : Math.abs(x - map.width / 2) / (map.width / 2 - 70) + Math.abs(y - map.height / 2) / (map.height / 2 - 70) > 1 || Math.abs(y - map.height / 2) < 70) continue;
        g = this.staticAt(x - 8, y - 8, x + 4, y + 6);
        g.lineStyle(2, 0x568f60, 0.55); g.lineBetween(x - 3, y + 3, x - 5, y - 3); g.lineBetween(x, y + 3, x + 2, y - 5);
      }
      for (const h of map.hazards) {
        g = this.staticAt(h.x - 4, h.y - 4, h.x + h.w + 4, h.y + h.h + 4);
        g.fillStyle(0x56605a); g.fillRoundedRect(h.x, h.y, h.w, h.h, 10);
        g.lineStyle(3, 0xe9b758); g.strokeRoundedRect(h.x + 4, h.y + 4, h.w - 8, h.h - 8, 7);
        for (let x = h.x + 13; x < h.x + h.w - 12; x += 22) { g.lineStyle(7, 0xe6b357, 0.65); g.lineBetween(x, h.y + 13, x - 4, h.y + h.h - 13); }
      }
      for (const o of map.obstacles) {
        // Wide enough for the drop shadow (+5, +8), the outline stroke and a circle's highlight.
        const box = bounds(shapeOf(o));
        this.obstacle(this.staticAt(box.x - 6, box.y - 6, box.x + box.w + 12, box.y + box.h + 14), o);
      }
      for (const building of map.buildings || []) {
        const floor = this.staticAt(building.x, building.y, building.x + building.w, building.y + building.h); floor.fillStyle(0x77717a); floor.fillRect(building.x + 18, building.y + 18, building.w - 36, building.h - 36);
        const roof = this.add.graphics(); roof.fillStyle(0x323a4b); roof.fillRoundedRect(building.x + 18, building.y + 18, building.w - 36, building.h - 36, 5);
        roof.lineStyle(4, 0x8091a8); roof.strokeRoundedRect(building.x + 20, building.y + 20, building.w - 40, building.h - 40, 4);
        roof.fillStyle(0x4b586b); roof.fillRect(building.x + 35, building.y + 30, building.w - 70, building.h - 60);
        roof.lineStyle(2, 0x748298); for (let y = building.y + 40; y < building.y + building.h - 30; y += 24) roof.lineBetween(building.x + 35, y, building.x + building.w - 35, y);
        roof.fillStyle(0x273240); roof.fillRect(building.x + 70, building.y + 70, 60, 40);
        this.roofLayer.add(roof); this.roofs.set(building.id, roof);
      }
      for (const gap of map.gaps) {
        g = this.staticAt(gap.x - 30, gap.y - 10, gap.x - 15, gap.y + 10);
        g.lineStyle(2, 0xd1f4cd); g.lineBetween(gap.x - 27, gap.y - 8, gap.x - 18, gap.y); g.lineBetween(gap.x - 18, gap.y, gap.x - 27, gap.y + 8);
      }
      for (const st of map.stations) {
        g = this.staticAt(st.x - 43, st.y - 36, st.x + 43, st.y + 36);
        g.fillStyle(0x274c57); g.fillRoundedRect(st.x - 41, st.y - 34, 82, 68, 11);
        g.lineStyle(3, 0x9bd6e6); g.strokeRoundedRect(st.x - 36, st.y - 29, 72, 58, 7);
        g.lineStyle(3, 0x9bd6e6); g.lineBetween(st.x - 12, st.y - 16, st.x - 12, st.y + 16); g.lineBetween(st.x + 12, st.y - 16, st.x + 12, st.y + 16);
        for (let y = -12; y <= 12; y += 12) g.lineBetween(st.x - 12, st.y + y, st.x + 12, st.y + y);
        this.label(st.x, st.y + 48, 'TRANSIT', '#24483e', 10);
      }
      const ex = map.exit;
      for (const st of map.chargers || []) {
        g = this.staticAt(st.x - 37, st.y - 32, st.x + 37, st.y + 32);
        g.fillStyle(0x273947); g.fillRoundedRect(st.x - 35, st.y - 30, 70, 60, 8);
        g.lineStyle(3, 0xffe98a); g.strokeRoundedRect(st.x - 30, st.y - 25, 60, 50, 6);
        g.fillStyle(0xffe98a); g.fillTriangle(st.x + 4, st.y - 19, st.x - 11, st.y + 2, st.x + 6, st.y + 2);
        g.fillTriangle(st.x - 4, st.y + 19, st.x + 11, st.y - 2, st.x - 6, st.y - 2);
        this.label(st.x, st.y + 45, 'CHARGE CELL · E', '#ffe98a', 11);
      }
      g = this.staticAt(ex.x - 46, ex.y - 44, ex.x + 46, ex.y + 44);
      g.fillStyle(0x264f42); g.fillRoundedRect(ex.x - 44, ex.y - 42, 88, 84, 12);
      g.lineStyle(4, 0xe6f59e); g.strokeRoundedRect(ex.x - 38, ex.y - 36, 76, 72, 8);
      g.lineStyle(6, 0xe6f59e); g.lineBetween(ex.x - 12, ex.y, ex.x + 14, ex.y); g.lineBetween(ex.x + 3, ex.y - 12, ex.x + 15, ex.y); g.lineBetween(ex.x + 15, ex.y, ex.x + 3, ex.y + 12);
      this.label(ex.x, ex.y - 60, 'LAST EXIT', '#e6f3a1', 14);
      this.label(map.entry?.x || 340, (map.entry?.y || map.height / 2) - 70, 'CONTESTANT ENTRY', '#b4d6cf', 12);
      this.updateCamera(true);
    }
    obstacle(g, o) {
      // Generated geometry is drawn from the very description the simulation collides with, so a new
      // shape needs no matching renderer branch and cannot be drawn as something other than its body.
      if (o.points?.length) {
        const points = outline(shapeOf(o));
        g.fillStyle(0x264439, 0.3); g.fillPoints(points.map(p => ({ x: p.x + 5, y: p.y + 8 })), true);
        g.fillStyle(obstacleFill(o)); g.fillPoints(points, true);
        g.lineStyle(3, 0x344d48); g.strokePoints(points, true);
        g.lineStyle(2, 0xffffff, 0.22); g.strokePoints(points, true);
        return;
      }
      if (o.kind === 'window') { g.fillStyle(0x77dbe3, 0.65); g.fillRect(o.x, o.y, o.w, o.h); g.lineStyle(2, 0xc1f4f6); g.strokeRect(o.x, o.y, o.w, o.h); return; }
      if (o.kind === 'ruin-wall') { g.fillStyle(0x303740); g.fillRect(o.x + 5, o.y + 6, o.w, o.h); g.fillStyle(0x77828a); g.fillRect(o.x, o.y, o.w, o.h); g.lineStyle(2, 0xa2a9af); g.lineBetween(o.x + 2, o.y + 2, o.x + o.w - 2, o.y + 2); return; }
      if (o.r) {
        g.fillStyle(0x294d39, 0.25); g.fillCircle(o.x + 6, o.y + 8, o.r + 2);
        g.fillStyle(o.kind === 'tree' ? 0x315e46 : 0x5c6e68); g.fillCircle(o.x, o.y, o.r);
        g.fillStyle(o.kind === 'tree' ? 0x4e8b50 : 0x899b91); g.fillCircle(o.x - 3, o.y - 4, o.r - 5);
        g.fillStyle(o.kind === 'tree' ? 0x79a95d : 0xb0bdb0); g.fillEllipse(o.x - 8, o.y - 9, o.r * 0.9, o.r * 0.65);
        return;
      }
      g.fillStyle(0x264439, 0.3); g.fillRoundedRect(o.x + 5, o.y + 8, o.w, o.h, 6);
      const fill = obstacleFill(o);
      g.fillStyle(0x344d48); g.fillRoundedRect(o.x - 2, o.y - 2, o.w + 4, o.h + 4, 6);
      g.fillStyle(fill); g.fillRoundedRect(o.x + 1, o.y + 1, o.w - 2, o.h - 2, 4);
      g.lineStyle(3, 0xffffff, 0.22); g.lineBetween(o.x + 7, o.y + 7, o.x + o.w - 7, o.y + 7);
      if (o.kind === 'fence') {
        for (let y = o.y + 12; y < o.y + o.h - 6; y += 23) { g.lineStyle(2, 0x354c44); g.lineBetween(o.x + 3, y, o.x + o.w - 3, y); }
      } else if (o.kind === 'building') {
        g.fillStyle(0x798d8c); g.fillRoundedRect(o.x + o.w * 0.25, o.y + o.h * 0.25, o.w * 0.5, o.h * 0.5, 4);
        g.lineStyle(2, 0x586b6b); g.lineBetween(o.x + 10, o.y + o.h - 12, o.x + o.w - 10, o.y + o.h - 12);
      } else {
        g.lineStyle(2, 0x354e44, 0.3); for (let x = o.x + 13; x < o.x + o.w - 5; x += 16) g.lineBetween(x, o.y + 11, x, o.y + o.h - 7);
      }
    }
    makeActor(p) {
      const sprite = this.add.image(0, 0, p.role).setDisplaySize(p.role === 'gladiator' ? 65 : 43, p.role === 'gladiator' ? 65 : 43);
      if (p.role === 'gladiator' && p.kit === 'specter') sprite.setTint(0xc5b0ff);
      if (p.role === 'gladiator' && p.kit === 'striker') sprite.setTint(0xffd485);
      if (p.role === 'contestant' && p.id !== api.playerId()) sprite.setTint([0xffffff, 0x9de6df, 0xfbdba2, 0xb9bdff][p.name.length % 4]);
      const ring = this.add.graphics(), bar = this.add.graphics();
      const name = this.add.text(0, -35, p.id === api.playerId() && !api.replay() ? 'YOU' : p.name, { fontFamily: 'Arial', fontSize: LABEL_FONT_PX, fontStyle: 'bold', color: '#f8fce9', stroke: '#294a3e', strokeThickness: 8 }).setOrigin(0.5).setScale(this.nameScale);
      const container = this.add.container(p.x, p.y, [ring, sprite, bar, name]); this.world.add(container); this.world.bringToTop(this.roofLayer);
      const actor = { sprite, ring, bar, name, container }; this.actors.set(p.id, actor); return actor;
    }
    /** The active player nearest a pointer, within a fixed screen distance of it, or null. */
    playerAt(pointer) {
      const state = api.state(); if (!state) return null;
      const point = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
      let best = null, nearest = 44 / this.cameras.main.zoom;
      for (const p of state.players) {
        if (p.status !== 'active') continue;
        const distance = Math.hypot(p.x - point.x, p.y - point.y);
        if (distance <= nearest) { best = p; nearest = distance; }
      }
      return best;
    }
    // A directed camera frames the whole arena unless it has been given a subject to follow, which it
    // shows at the zoom that player had in the match.
    wideView() { return api.directed() && !api.follow(); }
    /** Drop the smoothed eye so the next frame cuts to a new subject instead of gliding across the map. */
    cutTo() { this.eye = null; this.updateCamera(true); }
    updateCamera(snap = false) {
      const state = api.state(), map = api.map(); if (!state || !map) return;
      const wide = this.wideView();
      const focus = this.eye || api.follow() || api.self() || state.players[0];
      const zoom = wide ? Math.min((this.scale.width - 40) / map.width, (this.scale.height - 150) / map.height) : playerZoom(this.scale.width, this.scale.height, api.overview());
      const camera = this.cameras.main; camera.setZoom(zoom);
      const x = wide ? map.width / 2 : focus?.x || map.width / 2;
      const y = wide ? map.height / 2 : focus?.y || map.height / 2;
      // The eye is already smoothed, so the camera tracks it directly rather than easing a second time.
      camera.centerOn(x, y);
      this.marker = api.directed() ? markerScale(zoom) : 1;
      this.nameScale = labelScale(zoom, this.marker);
    }
    update(now, delta) {
      const rawDelta = noteFrame();
      start('render.frame'); if (rawDelta !== null) observe('render.delta', rawDelta);
      api.onFrame(delta);
      const state = api.state(), map = api.map(), self = api.self();
      if (!state || !map) { stop('render.frame'); endProfileFrame(); return; }
      // Camera, own sprite, fog and cover all read one eased eye. Previously the fog sampled the raw
      // predicted position while the camera and sprite eased toward it, so the shadows led the world
      // by the easing lag and stepped at the 20 Hz input tick instead of gliding with the frame.
      // Exponential, so the eye settles on the same time constant whatever the frame rate. A plain
      // fraction of the frame delta eases faster on a slow client than a fast one, which is the same
      // frame-rate dependence the remote-actor filter had before the receive buffer replaced it.
      const ease = 1 - Math.exp(-delta / EYE_TAU_MS);
      // A followed replay subject drives the same eased eye the player's own view uses, so a followed
      // camera glides exactly like a live one and cuts only when the subject changes or teleports.
      const focus = api.follow() || self;
      if (!focus) this.eye = null;
      else if (!this.eye || Math.hypot(focus.x - this.eye.x, focus.y - this.eye.y) > 150) this.eye = { x: focus.x, y: focus.y };
      else { this.eye.x = Phaser.Math.Linear(this.eye.x, focus.x, ease); this.eye.y = Phaser.Math.Linear(this.eye.y, focus.y, ease); }
      const eye = this.eye;
      start('render.camera'); this.updateCamera(); stop('render.camera');
      const halfWidth = this.scale.width / this.cameras.main.zoom / 2;
      const halfHeight = this.scale.height / this.cameras.main.zoom / 2;
      const nearView = (x, y, margin = 400) => this.wideView() || !eye || Math.abs(x - eye.x) < halfWidth + margin && Math.abs(y - eye.y) < halfHeight + margin;
      start('render.tiles'); this.updateTiles(); stop('render.tiles');
      for (const label of this.labels) label.setVisible(nearView(label.x, label.y));
      this.shade.clear();
      if (api.directed() || !eye) { this.visionPoints = null; this.sight = null; }
      else {
        start('render.vision');
        this.viewBounds = viewBounds(eye, this.scale.width, this.scale.height, this.cameras.main.zoom);
        this.rememberedGates = observeGates(map, eye, this.viewBounds, this.gateMemory, state.tick);
        this.sightMap.obstacles = map.obstacles; this.sightMap.gates = this.rememberedGates;
        this.visionPoints = visibilityPolygon(this.sightMap, eye, viewRadius(this.viewBounds, eye));
        this.sight = { eye, bounds: this.viewBounds, points: this.visionPoints };
        this.vision.clear(); this.vision.fillStyle(0xffffff); this.vision.fillPoints(this.visionPoints, true);
        // Shade covers the whole arena; the inverted mask cuts the lit wedge back out of it.
        this.shade.fillStyle(0x123330, 0.46);
        this.shade.fillRect(-500, -500, map.width + 1000, map.height + 1000);
        stop('render.vision');
      }
      // The server now sends a wider set than the eye can reach, so the renderer resolves the geometry.
      // Sight itself is a shared rule; a directed view opts out of it rather than reimplementing it.
      const lit = (x, y) => api.directed() || seesPoint(this.sight, map, x, y);
      const inside = eye && buildingAt(map, eye);
      for (const building of map.buildings || []) this.roofs.get(building.id).setVisible(!api.directed() && building.id !== inside?.id && nearView(building.x + building.w / 2, building.y + building.h / 2));
      const g = this.dynamic; g.clear();
      const fixed = this.fixtures; fixed.clear();
      start('render.world');
      for (const gate of api.directed() ? state.gates : this.rememberedGates) {
        if (!nearView(gate.x, gate.y)) continue;
        if (gate.kind === 'door') {
          const box = gateShape(gate); fixed.lineStyle(3, gate.stale ? 0x687789 : 0xe8bc74);
          if (gate.open) fixed.strokeRect(box.x, box.y - 55, 12, 70);
          else { fixed.fillStyle(gate.stale ? 0x494451 : 0xa07952); fixed.fillRect(box.x, box.y, box.w, box.h); fixed.strokeRect(box.x, box.y, box.w, box.h); }
          continue;
        }
        if (gate.open) {
          fixed.lineStyle(3, gate.stale ? 0x758583 : 0xa6e5dc, gate.stale ? 0.55 : 1);
          fixed.strokeRoundedRect(gate.x - 15, gate.y - 29, 30, 58, 3);
          continue;
        }
        fixed.fillStyle(0x304e44); fixed.fillRoundedRect(gate.x - 13, gate.y - 27, 26, 54, 3);
        fixed.lineStyle(3, 0xf5cf76); fixed.strokeRoundedRect(gate.x - 10, gate.y - 24, 20, 48, 2);
        fixed.fillStyle(0xf5cf76); fixed.fillCircle(gate.x, gate.y - 3, 4); fixed.fillRect(gate.x - 2, gate.y, 4, 9);
        if (gate.stale) {
          fixed.fillStyle(0x263c43, 0.65); fixed.fillRoundedRect(gate.x - 13, gate.y - 27, 26, 54, 3);
          fixed.lineStyle(2, 0xb2c4c9, 0.8); fixed.strokeCircle(gate.x, gate.y, 7);
          if (!gate.known) { fixed.lineBetween(gate.x, gate.y - 4, gate.x, gate.y + 1); fixed.fillStyle(0xb2c4c9); fixed.fillCircle(gate.x, gate.y + 4, 1); }
        }
      }
      for (const item of state.items) {
        if (!lit(item.x, item.y)) continue;
        const y = item.y + Math.sin(now / 340 + item.x) * 2;
        g.fillStyle(0x284735, 0.2); g.fillEllipse(item.x + 2, y + 10, 26, 11);
        g.fillStyle(0x28473f); g.fillRoundedRect(item.x - 12, y - 12, 24, 24, 5);
        g.lineStyle(2, COLORS[item.kind]); g.strokeRoundedRect(item.x - 12, y - 12, 24, 24, 5); g.fillStyle(COLORS[item.kind]);
        if (item.kind === 'med') { g.fillRect(item.x - 2, y - 7, 4, 14); g.fillRect(item.x - 7, y - 2, 14, 4); }
        else if (item.kind === 'access') { g.strokeCircle(item.x - 2, y - 2, 4); g.lineBetween(item.x, y, item.x + 6, y + 6); }
        else if (item.kind === 'weapon') { g.fillRect(item.x - 7, y - 3, 14, 4); g.fillRect(item.x - 3, y, 4, 6); }
        else if (item.kind === 'cell') { g.strokeRect(item.x - 5, y - 7, 10, 14); g.fillRect(item.x - 2, y - 10, 4, 3); if (item.charge > 0) g.fillRect(item.x - 3, y - 3, 6, 8); }
        else g.fillTriangle(item.x - 7, y - 5, item.x + 7, y - 5, item.x, y + 8);
      }
      for (const sensor of map.sensors) {
        if (!nearView(sensor.x, sensor.y)) continue;
        fixed.fillStyle(0xf2df82, 0.08); fixed.fillCircle(sensor.x, sensor.y, 180); fixed.lineStyle(1, 0xe6d174, 0.5); fixed.strokeCircle(sensor.x, sensor.y, 180);
        fixed.fillStyle(0x355749); fixed.fillCircle(sensor.x, sensor.y, 11); fixed.fillStyle(0xffeaa0); fixed.fillCircle(sensor.x, sensor.y, 4);
        fixed.lineStyle(2, 0xe6d174, 0.5); fixed.lineBetween(sensor.x, sensor.y, sensor.x + Math.cos(now / 1200) * 174, sensor.y + Math.sin(now / 1200) * 174);
      }
      const alpha = api.frameAlpha();
      for (const trap of state.traps || []) {
        if (trap.spent || !lit(trap.x, trap.y)) continue;
        const heading = trap.heading || 0;
        if (trap.kind === 'mine') {
          g.fillStyle(0x282c39); g.fillCircle(trap.x, trap.y, 15); g.lineStyle(2, 0xff778c); g.strokeCircle(trap.x, trap.y, 12);
          g.fillStyle(Math.floor(now / 400) % 2 ? 0xff778c : 0x583c48); g.fillCircle(trap.x, trap.y, 4);
        } else if (trap.kind === 'spider') {
          g.lineStyle(1, 0xc5aecf, 0.25); g.strokeCircle(trap.homeX, trap.homeY, 240);
          for (let i = 0; i < 8; i++) {
            const a = i * Math.PI / 4;
            g.lineBetween(trap.homeX, trap.homeY, trap.homeX + Math.cos(a) * 240, trap.homeY + Math.sin(a) * 240);
            g.lineStyle(3, 0xb297c1); g.lineBetween(trap.x + Math.cos(a) * 10, trap.y + Math.sin(a) * 10, trap.x + Math.cos(a + 0.25) * 25, trap.y + Math.sin(a + 0.25) * 25);
          }
          g.fillStyle(0x574d6b); g.fillCircle(trap.x, trap.y, 13); g.fillStyle(0xff879f); g.fillCircle(trap.x + Math.cos(heading) * 8, trap.y + Math.sin(heading) * 8, 4);
        } else {
          g.fillStyle(0x282c39); g.fillRoundedRect(trap.x - 19, trap.y - 19, 38, 38, 6);
          g.lineStyle(3, trap.kind === 'flame' ? 0xffba62 : 0xff879f); g.strokeCircle(trap.x, trap.y, 15);
          g.lineStyle(8, 0xadb8c2); g.lineBetween(trap.x, trap.y, trap.x + Math.cos(heading) * 28, trap.y + Math.sin(heading) * 28);
          if (trap.kind === 'flame' && (trap.warning || trap.firing)) {
            g.fillStyle(trap.firing ? 0xff873e : 0xffd36c, trap.firing ? 0.65 : 0.18);
            g.fillTriangle(trap.x, trap.y, trap.x + Math.cos(heading - 0.64) * 240, trap.y + Math.sin(heading - 0.64) * 240, trap.x + Math.cos(heading + 0.64) * 240, trap.y + Math.sin(heading + 0.64) * 240);
          }
        }
      }
      this.shots = state.projectiles.map(b => ({ id: b.id, x: b.x + b.dx * alpha, y: b.y + b.dy * alpha, dx: b.dx, dy: b.dy }));
      for (const b of this.shots) {
        if (!lit(b.x, b.y)) continue;
        g.lineStyle(3, 0xffffd8); g.lineBetween(b.x, b.y, b.x - b.dx * 0.7, b.y - b.dy * 0.7);
      }
      for (const e of state.effects) {
        if (!lit(e.x, e.y)) continue;
        const a = Math.max(0, e.life - alpha) / 12; g.lineStyle(3, ['shock', 'slash'].includes(e.kind) ? 0xff777e : ['scan', 'rail'].includes(e.kind) ? 0x96dcf4 : 0xeafdc1, a); g.strokeCircle(e.x, e.y, e.radius * (1 - a * 0.7));
        if (e.kind === 'smoke') { g.fillStyle(0xeaf4de, a * 0.45); g.fillCircle(e.x, e.y, e.radius * (1 - a * 0.6)); }
      }
      fixed.fillStyle(0xd65065, 0.68); fixed.fillRect(-80, -80, Math.max(0, state.hazardX + 80), map.height + 160);
      fixed.lineStyle(4, 0xffaaa1); fixed.lineBetween(state.hazardX, -80, state.hazardX, map.height + 80);
      stop('render.world');
      start('render.actors');
      const ids = new Set();
      for (const p of state.players) {
        ids.add(p.id); const actor = this.actors.get(p.id) || this.makeActor(p); const own = p.id === api.playerId();
        // Own marks the viewer's player in any view; only a live one is steered by local aim and eye.
        const controlled = own && !api.replay();
        // Ordinary dynamic actors, including allies, are occluded. Reveals remain an explicit exception.
        const shown = api.directed() || own || seesActor(this.sight, map, self, p);
        actor.container.setVisible(p.status === 'active' && shown);
        // Everyone but the viewer is drawn where the frame says, with no filter of its own. The
        // position already arrived interpolated between two authoritative states, so easing toward
        // it a second time would only add back the lag the buffer exists to remove — and the filter
        // this replaced converted every irregular arrival into a velocity spike besides.
        if (controlled && eye) { actor.container.x = eye.x; actor.container.y = eye.y; }
        else { actor.container.x = p.x; actor.container.y = p.y; }
        actor.sprite.setRotation(controlled ? api.aim() : p.heading); actor.sprite.setAlpha(p.cloak ? 0.45 : 1);
        // Markers hold their apparent size as the camera pulls back; names hold a fixed pixel height
        // rather than riding that scale, which would leave them unreadable at whole arena zoom.
        actor.container.setScale(this.marker); actor.name.setScale(this.nameScale);
        actor.ring.clear(); actor.bar.clear();
        if (own) { actor.ring.lineStyle(2, 0xf8ffd0, 0.8); actor.ring.strokeCircle(0, 0, p.role === 'gladiator' ? 34 : 25); }
        // A directed view carries no fog to separate the roster by, so role reads from a ring instead.
        if (api.directed()) {
          const followed = p.id === api.follow()?.id;
          actor.ring.lineStyle(followed ? 5 : 3, p.role === 'gladiator' ? 0xff7d8a : 0xc5f16f, followed ? 1 : 0.8);
          actor.ring.strokeCircle(0, 0, p.role === 'gladiator' ? 42 : 31);
        }
        if (p.revealed) { actor.ring.lineStyle(2, 0xff7769); actor.ring.strokeCircle(0, 0, 29); }
        if (p.shield) { actor.ring.lineStyle(2, 0x98ddff, 0.7); actor.ring.strokeCircle(0, 0, 23); }
        actor.bar.fillStyle(0x254939); actor.bar.fillRect(-18, 29, 36, 4); actor.bar.fillStyle(p.role === 'gladiator' ? 0xff8185 : 0xc5f16f); actor.bar.fillRect(-18, 29, 36 * p.hp / p.maxHp, 4);
        if (p.weapon && p.role === 'contestant') {
          const angle = controlled ? api.aim() : p.heading;
          actor.ring.lineStyle(7, 0x344b4f); actor.ring.lineBetween(Math.cos(angle) * 15, Math.sin(angle) * 15, Math.cos(angle) * 34, Math.sin(angle) * 34);
        }
      }
      for (const [id, actor] of this.actors) if (!ids.has(id)) { actor.container.destroy(); this.actors.delete(id); }
      stop('render.actors');
      stop('render.frame');
      endProfileFrame();
    }
  };
}
