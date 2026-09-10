import { visibilityPolygon, litPoint, gateShape } from '/shared/movement.js';
import { playerZoom, viewBounds, viewRadius, inViewport, observeGates, buildingAt, roofConceals } from '/shared/view.js';
import { observe, start, stop, frame as endProfileFrame } from '/shared/profiler.js';

const COLORS = { access: 0xf4d26c, med: 0xff8b97, weapon: 0x8bd9f0, shield: 0xa3b9ff, cell: 0xffe98a };
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
      this.floor = this.add.graphics(); this.decor = this.add.container(0, 0);
      this.fixtures = this.add.graphics(); this.shade = this.add.graphics(); this.dynamic = this.add.graphics();
      this.world.add([this.floor, this.decor, this.fixtures, this.shade, this.dynamic]);
      this.roofs = new Map(); this.roofLayer = this.add.container(0, 0); this.world.add(this.roofLayer);
      this.actors = new Map(); this.labels = []; this.eye = null;
      this.vision = this.make.graphics({ x: 0, y: 0, add: false });
      this.shadeMask = this.vision.createGeometryMask();
      this.shadeMask.invertAlpha = true;
      this.shade.setMask(this.shadeMask);
      this.crosshair = this.add.graphics();
      this.input.on('pointerdown', p => { if (p.leftButtonDown() && !api.replay()) api.onFire(true); });
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
    chunkAt(x, y) {
      const key = `${Math.floor(x / 1024)},${Math.floor(y / 1024)}`;
      if (!this.chunks.has(key)) { const graphics = this.add.graphics(); this.world.addAt(graphics, 1); this.chunks.set(key, graphics); }
      return this.chunks.get(key);
    }
    buildMap() {
      const map = api.map(); let g = this.floor;
      if (!map?.obstacles) return;
      for (const chunk of this.chunks?.values() || []) chunk.destroy(); this.chunks = new Map();
      g.clear(); this.labels.forEach(l => l.destroy()); this.labels = [];
      this.gateMemory = new Map(); this.rememberedGates = []; this.eye = null; this.sightMap = { ...map };
      this.actors.forEach(a => a.container.destroy()); this.actors.clear();
      for (const roof of this.roofs.values()) roof.destroy(); this.roofs.clear();
      this.cameras.main.setBounds(-400, -400, map.width + 800, map.height + 800);
      const diamond = [{ x: 40, y: map.height / 2 }, { x: map.width / 2, y: 40 }, { x: map.width - 40, y: map.height / 2 }, { x: map.width / 2, y: map.height - 40 }];
      g.fillStyle(0x39454c); g.fillPoints(diamond, true);
      g.lineStyle(8, 0x729b9e); g.strokePoints(diamond, true);
      // Broad paths connect generated sections. There are no visible grid cells.
      for (const route of map.streets?.map(st => ({ points: [st.a, st.port, st.b] })) || map.routes || [{ points: [{ x: 160, y: map.height / 2 }, ...map.modules, map.exit] }]) {
        for (let i = 1; i < route.points.length; i++) {
          const a = route.points[i - 1], b = route.points[i]; g = this.chunkAt((a.x + b.x) / 2, (a.y + b.y) / 2);
          g.lineStyle(map.streets ? 160 : 100, 0x596269); g.lineBetween(a.x, a.y, b.x, b.y);
          g.lineStyle(2, 0xa5bbc0, 0.35); g.lineBetween(a.x, a.y, b.x, b.y);
        }
      }
      for (const m of map.modules) {
        g = this.chunkAt(m.x, m.y);
        // These are ground markings, not fake building silhouettes.
        if (m.kind === 'depot') {
          g.lineStyle(2, 0x9daab0, 0.3);
          for (let dx = -120; dx <= 120; dx += 60) g.lineBetween(m.x + dx, m.y - 130, m.x + dx, m.y - 100);
        } else if (m.kind === 'garden') {
          g.fillStyle(0x44584e, 0.45); g.fillEllipse(m.x, m.y - 210, 220, 100);
        }
        this.label(m.x, m.y - 75, ['SERVICE YARD', 'RUINED DEPOT', 'OVERGROWN BLOCK'][['yard', 'depot', 'garden'].indexOf(m.kind)], '#91b9bc', 13);
        if (m.interior) { g.fillStyle(0x50505d); g.fillRect(m.interior.x, m.interior.y, m.interior.w, m.interior.h); }
      }
      for (let i = 0; i < 430; i++) {
        const x = (i * 479 + map.seed * 7) % map.width, y = (i * 193 + map.seed * 13) % map.height;
        if (Math.abs(x - map.width / 2) / (map.width / 2 - 70) + Math.abs(y - map.height / 2) / (map.height / 2 - 70) > 1 || Math.abs(y - map.height / 2) < 70) continue;
        g = this.chunkAt(x, y);
        g.lineStyle(2, 0x568f60, 0.55); g.lineBetween(x - 3, y + 3, x - 5, y - 3); g.lineBetween(x, y + 3, x + 2, y - 5);
      }
      for (const h of map.hazards) {
        g = this.chunkAt(h.x, h.y);
        g.fillStyle(0x56605a); g.fillRoundedRect(h.x, h.y, h.w, h.h, 10);
        g.lineStyle(3, 0xe9b758); g.strokeRoundedRect(h.x + 4, h.y + 4, h.w - 8, h.h - 8, 7);
        for (let x = h.x + 13; x < h.x + h.w - 12; x += 22) { g.lineStyle(7, 0xe6b357, 0.65); g.lineBetween(x, h.y + 13, x - 4, h.y + h.h - 13); }
      }
      for (const o of map.obstacles) this.obstacle(this.chunkAt(o.x, o.y), o);
      for (const building of map.buildings || []) {
        const floor = this.chunkAt(building.x, building.y); floor.fillStyle(0x77717a); floor.fillRect(building.x + 18, building.y + 18, building.w - 36, building.h - 36);
        const roof = this.add.graphics(); roof.fillStyle(0x323a4b); roof.fillRoundedRect(building.x + 18, building.y + 18, building.w - 36, building.h - 36, 5);
        roof.lineStyle(4, 0x8091a8); roof.strokeRoundedRect(building.x + 20, building.y + 20, building.w - 40, building.h - 40, 4);
        roof.fillStyle(0x4b586b); roof.fillRect(building.x + 35, building.y + 30, building.w - 70, building.h - 60);
        roof.lineStyle(2, 0x748298); for (let y = building.y + 40; y < building.y + building.h - 30; y += 24) roof.lineBetween(building.x + 35, y, building.x + building.w - 35, y);
        roof.fillStyle(0x273240); roof.fillRect(building.x + 70, building.y + 70, 60, 40);
        this.roofLayer.add(roof); this.roofs.set(building.id, roof);
      }
      for (const gap of map.gaps) {
        g = this.chunkAt(gap.x, gap.y);
        g.lineStyle(2, 0xd1f4cd); g.lineBetween(gap.x - 27, gap.y - 8, gap.x - 18, gap.y); g.lineBetween(gap.x - 18, gap.y, gap.x - 27, gap.y + 8);
      }
      for (const st of map.stations) {
        g = this.chunkAt(st.x, st.y);
        g.fillStyle(0x274c57); g.fillRoundedRect(st.x - 41, st.y - 34, 82, 68, 11);
        g.lineStyle(3, 0x9bd6e6); g.strokeRoundedRect(st.x - 36, st.y - 29, 72, 58, 7);
        g.lineStyle(3, 0x9bd6e6); g.lineBetween(st.x - 12, st.y - 16, st.x - 12, st.y + 16); g.lineBetween(st.x + 12, st.y - 16, st.x + 12, st.y + 16);
        for (let y = -12; y <= 12; y += 12) g.lineBetween(st.x - 12, st.y + y, st.x + 12, st.y + y);
        this.label(st.x, st.y + 48, 'TRANSIT', '#24483e', 10);
      }
      const ex = map.exit;
      for (const st of map.chargers || []) {
        g = this.chunkAt(st.x, st.y);
        g.fillStyle(0x273947); g.fillRoundedRect(st.x - 35, st.y - 30, 70, 60, 8);
        g.lineStyle(3, 0xffe98a); g.strokeRoundedRect(st.x - 30, st.y - 25, 60, 50, 6);
        g.fillStyle(0xffe98a); g.fillTriangle(st.x + 4, st.y - 19, st.x - 11, st.y + 2, st.x + 6, st.y + 2);
        g.fillTriangle(st.x - 4, st.y + 19, st.x + 11, st.y - 2, st.x - 6, st.y - 2);
        this.label(st.x, st.y + 45, 'CHARGE CELL · E', '#ffe98a', 11);
      }
      g = this.chunkAt(ex.x, ex.y);
      g.fillStyle(0x264f42); g.fillRoundedRect(ex.x - 44, ex.y - 42, 88, 84, 12);
      g.lineStyle(4, 0xe6f59e); g.strokeRoundedRect(ex.x - 38, ex.y - 36, 76, 72, 8);
      g.lineStyle(6, 0xe6f59e); g.lineBetween(ex.x - 12, ex.y, ex.x + 14, ex.y); g.lineBetween(ex.x + 3, ex.y - 12, ex.x + 15, ex.y); g.lineBetween(ex.x + 15, ex.y, ex.x + 3, ex.y + 12);
      this.label(ex.x, ex.y - 60, 'LAST EXIT', '#e6f3a1', 14);
      this.label(map.entry?.x || 340, (map.entry?.y || map.height / 2) - 70, 'CONTESTANT ENTRY', '#b4d6cf', 12);
      this.updateCamera(true);
    }
    obstacle(g, o) {
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
      const palette = [0x8d5669, 0x526f80, 0x8c815a];
      const fill = o.kind === 'fence' ? 0x53636b : o.kind === 'building' ? 0x92929e : palette[o.color || 0];
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
      const name = this.add.text(0, -35, p.id === api.playerId() ? 'YOU' : p.name, { fontFamily: 'Arial', fontSize: 9, fontStyle: 'bold', color: '#f8fce9', stroke: '#294a3e', strokeThickness: 3 }).setOrigin(0.5);
      const container = this.add.container(p.x, p.y, [ring, sprite, bar, name]); this.world.add(container); this.world.bringToTop(this.roofLayer);
      const actor = { sprite, ring, bar, name, container }; this.actors.set(p.id, actor); return actor;
    }
    updateCamera(snap = false) {
      const state = api.state(), map = api.map(); if (!state || !map) return;
      const focus = this.eye || api.self() || state.players[0];
      const zoom = api.directed() ? Math.min((this.scale.width - 40) / map.width, (this.scale.height - 150) / map.height) : playerZoom(this.scale.width, this.scale.height, api.overview());
      const camera = this.cameras.main; camera.setZoom(zoom);
      const x = api.directed() ? map.width / 2 : focus?.x || map.width / 2;
      const y = api.directed() ? map.height / 2 : focus?.y || map.height / 2;
      // The eye is already smoothed, so the camera tracks it directly rather than easing a second time.
      camera.centerOn(x, y);
    }
    update(now, delta) {
      start('render.frame'); observe('render.delta', delta);
      api.onFrame(delta);
      const state = api.state(), map = api.map(), self = api.self();
      if (!state || !map) { stop('render.frame'); endProfileFrame(); return; }
      // Camera, own sprite, fog and cover all read one eased eye. Previously the fog sampled the raw
      // predicted position while the camera and sprite eased toward it, so the shadows led the world
      // by the easing lag and stepped at the 20 Hz input tick instead of gliding with the frame.
      const ease = Math.min(1, delta / 40);
      if (!self) this.eye = null;
      else if (!this.eye || Math.hypot(self.x - this.eye.x, self.y - this.eye.y) > 150) this.eye = { x: self.x, y: self.y };
      else { this.eye.x = Phaser.Math.Linear(this.eye.x, self.x, ease); this.eye.y = Phaser.Math.Linear(this.eye.y, self.y, ease); }
      const eye = this.eye;
      start('render.camera'); this.updateCamera(); stop('render.camera');
      const halfWidth = this.scale.width / this.cameras.main.zoom / 2;
      const halfHeight = this.scale.height / this.cameras.main.zoom / 2;
      const nearView = (x, y, margin = 400) => api.directed() || !eye || Math.abs(x - eye.x) < halfWidth + margin && Math.abs(y - eye.y) < halfHeight + margin;
      for (const [key, chunk] of this.chunks) {
        const [cx, cy] = key.split(',').map(Number);
        // Geometry can extend one block beyond its anchor; preserve that margin at chunk seams.
        chunk.setVisible(nearView(cx * 1024 + 512, cy * 1024 + 512, 1500));
      }
      for (const label of this.labels) label.setVisible(nearView(label.x, label.y));
      this.shade.clear();
      if (api.directed() || !eye) this.visionPoints = null;
      else {
        start('render.vision');
        this.viewBounds = viewBounds(eye, this.scale.width, this.scale.height, this.cameras.main.zoom);
        this.rememberedGates = observeGates(map, eye, this.viewBounds, this.gateMemory, state.tick);
        this.sightMap.obstacles = map.obstacles; this.sightMap.gates = this.rememberedGates;
        this.visionPoints = visibilityPolygon(this.sightMap, eye, viewRadius(this.viewBounds, eye));
        this.vision.clear(); this.vision.fillStyle(0xffffff); this.vision.fillPoints(this.visionPoints, true);
        // Shade covers the whole arena; the inverted mask cuts the lit wedge back out of it.
        this.shade.fillStyle(0x123330, 0.46);
        this.shade.fillRect(-500, -500, map.width + 1000, map.height + 1000);
        stop('render.vision');
      }
      // The server now sends a wider set than the eye can reach, so the renderer resolves the geometry.
      const points = this.visionPoints;
      const lit = (x, y) => !points || !roofConceals(map, eye, { x, y }) && inViewport(this.viewBounds, x, y, 30) && litPoint(points, eye, x, y);
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
        // Ordinary dynamic actors, including allies, are occluded. Reveals remain an explicit exception.
        const known = api.directed() || own || self?.role === 'gladiator' && p.revealed > 0;
        actor.container.setVisible(p.status === 'active' && (known || lit(p.x, p.y)) && (known || !p.cloak));
        if (own && !api.replay() && eye) { actor.container.x = eye.x; actor.container.y = eye.y; }
        else {
          const blend = api.replay() || Math.hypot(p.x - actor.container.x, p.y - actor.container.y) > 150 ? 1 : ease;
          actor.container.x = Phaser.Math.Linear(actor.container.x, p.x, blend); actor.container.y = Phaser.Math.Linear(actor.container.y, p.y, blend);
        }
        actor.sprite.setRotation(own && !api.replay() ? api.aim() : p.heading); actor.sprite.setAlpha(p.cloak ? 0.45 : 1);
        actor.ring.clear(); actor.bar.clear();
        if (own) { actor.ring.lineStyle(2, 0xf8ffd0, 0.8); actor.ring.strokeCircle(0, 0, p.role === 'gladiator' ? 34 : 25); }
        if (p.revealed) { actor.ring.lineStyle(2, 0xff7769); actor.ring.strokeCircle(0, 0, 29); }
        if (p.shield) { actor.ring.lineStyle(2, 0x98ddff, 0.7); actor.ring.strokeCircle(0, 0, 23); }
        actor.bar.fillStyle(0x254939); actor.bar.fillRect(-18, 29, 36, 4); actor.bar.fillStyle(p.role === 'gladiator' ? 0xff8185 : 0xc5f16f); actor.bar.fillRect(-18, 29, 36 * p.hp / p.maxHp, 4);
        if (p.weapon && p.role === 'contestant') {
          const angle = own && !api.replay() ? api.aim() : p.heading;
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
