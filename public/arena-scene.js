import { visibilityPolygon, sweptClear } from '/shared/movement.ts';
import { playerZoom, markerScale, labelScale, LABEL_FONT_PX, viewBounds, viewRadius, seesActor, observeGates, roofAt, buildingOpenings, INSIDE_ZOOM, LOD_LABEL_ZOOM } from '/shared/view.ts';
import { bodyRadius } from '/shared/physics/presentation-geometry.ts';
import { observe, start, stop, count, frame as endProfileFrame } from '/shared/profiler.ts';
import { noteFrame } from '/diagnostics.js';
import { PREDICTION_LIMITS } from '/physics-prediction-limits.js';
import { DEFAULT_THEME, themeColors, css } from './palette.js';
import { sampleSpatialLight, getCanonicalFields, actorBaseTint, resolveActorTint } from './appearance.js';
import { resolveEventLights, drawEventLights } from './event-light.js';
import { TileCache } from './tile-cache.js';
import { recordStatic } from './static-drawing.js';
import {
  FrameView, fadeRoofs, visibleBodies, drawTethers, drawHookFlights, drawProps, drawGates, drawItems,
  drawSensors, drawTraps, projectShots, drawShots, drawEffects, drawHazard, drawHeardCues,
} from './frame-drawing.js';

// Eye settling time constant, chosen to match the previous `delta / 40` at 60 Hz.
const EYE_TAU_MS = 31;

/**
 * The arena's Phaser scene: lifecycle, input, the camera and its eased eye, sight and shade, and the
 * actors. The map's static drawing is in static-drawing.js, baked by tile-cache.js; the per-frame
 * layers are in frame-drawing.js, drawn by `update` in a fixed order.
 */
export function makeArenaScene(api) {
  return class ArenaScene extends Phaser.Scene {
    constructor() { super('arena'); }
    preload() {
      this.load.svg('contestant', '/assets/contestant-body.svg', { width: 80, height: 80 });
      this.load.svg('contestant-identity', '/assets/contestant-identity.svg', { width: 80, height: 80 });
      this.load.svg('contestant-visor', '/assets/contestant-visor.svg', { width: 80, height: 80 });
      this.load.svg('gladiator', '/assets/warden-body.svg', { width: 100, height: 100 });
      this.load.svg('gladiator-identity', '/assets/warden-identity.svg', { width: 100, height: 100 });
      this.load.svg('gladiator-visor', '/assets/warden-visor.svg', { width: 100, height: 100 });
    }
    create() {
      this.ready = true; this.paletteId = api.palette?.() || DEFAULT_THEME; this.lighting = true; this.wear = true;
      this.colors = themeColors(this.paletteId); this.cameras.main.setBackgroundColor(css(this.colors.background));
      this.world = this.add.container(0, 0);
      // Terrain, structures and fixtures are drawn everywhere and dimmed where they are out of sight,
      // so the arena stays legible instead of being cut away. Only actors, loot, shots and effects are
      // withheld, and they sit above the shade so anything in view reads at full brightness.
      // Ground and static objects share baked tiles in their recorded draw order; actors join the
      // object plane at runtime. The overhead plane has separate tiles so each group owns its alpha.
      this.decor = this.add.container(0, 0);
      this.fixtures = this.add.graphics(); this.shade = this.add.graphics(); this.dynamic = this.add.graphics();
      // Event light (#594) adds onto the ground below the shade, so a glow spilling past a wall dims
      // with the terrain there, and below actors and items, whose identity colors it must not tint.
      this.eventLight = this.add.graphics().setBlendMode('ADD');
      // Static tile textures are inserted at index 0, beneath everything here.
      this.world.add([this.decor, this.fixtures, this.eventLight, this.shade, this.dynamic]);
      this.roofs = new Map(); this.roofMembers = new Map(); this.coveredBuildingIds = new Set(); this.insideBlend = 0;
      this.overheadLayer = this.add.container(0, 0);
      this.overheadCanopies = this.add.container(0, 0); this.overheadRoofs = this.add.container(0, 0);
      this.overheadLayer.add([this.overheadCanopies, this.overheadRoofs]); this.world.add(this.overheadLayer);
      this.tileCache = new TileCache(this, this.world, { canopy: this.overheadCanopies, roof: this.overheadRoofs });
      this.view = new FrameView();
      this.actors = new Map(); this.labels = []; this.eye = null;
      this.marker = 1; this.nameScale = 1 / LABEL_FONT_PX;
      this.vision = this.make.graphics({ x: 0, y: 0, add: false });
      this.shadeMask = this.vision.createGeometryMask();
      this.shadeMask.invertAlpha = true;
      this.shade.setMask(this.shadeMask);
      this.crosshair = this.add.graphics();
      this.input.on('pointerdown', p => {
        if (!p.leftButtonDown()) return;
        if (!api.directed()) { api.onFire(true); return; }
        // Clicking a marker is the fastest way to pick a subject out of a crowd; the roster select
        // covers anyone too small, too distant or not currently on screen to hit. Anywhere else drags.
        const target = this.playerAt(p);
        if (target) api.director.setFollow(target.id);
        else this.drag = { x: p.x, y: p.y };
      });
      this.input.on('pointermove', p => {
        if (!this.drag || !p.isDown || !api.directed()) return;
        const zoom = this.cameras.main.zoom;
        api.director.pan((this.drag.x - p.x) / zoom, (this.drag.y - p.y) / zoom);
        this.drag = { x: p.x, y: p.y };
      });
      this.input.on('pointerup', () => { this.drag = null; api.onFire(false); });
      this.input.on('wheel', (p, _objects, _dx, dy) => {
        if (!api.directed() || !dy) return;
        api.director.zoomAt(Math.exp(-dy / 600), this.cameras.main.getWorldPoint(p.x, p.y));
      });
      this.game.canvas.addEventListener('contextmenu', e => e.preventDefault());
      this.game.canvas.style.cursor = 'crosshair';
      this.scale.on('resize', () => this.updateCamera());
      api.onReady(this); if (api.map()) this.buildMap();
    }
    label(x, y, text, color = '#2c514b', size = 12) {
      const label = this.add.text(x, y, text, { fontFamily: 'Arial', fontSize: size, fontStyle: 'bold', color }).setOrigin(0.5);
      this.labels.push(label); this.decor.add(label);
    }
    buildMap() {
      const map = api.map();
      if (!map?.obstacles) return;
      this.gateMemory = new Map(); this.rememberedGates = []; this.eye = null; this.insideBlend = 0;
      this.sight = null; this.visionPoints = null; this.vision.clear(); this.sightMap = { ...map };
      this.actors.forEach(a => a.container.destroy()); this.actors.clear();
      // Chain starts can be right by the western edge. Follow must still centre on
      // that subject at every viewport/zoom; its authoritative position is bounded.
      this.cameras.main.removeBounds();
      this.recordStatic(map);
      this.updateCamera();
    }
    /** Draw in another palette or static art mode (11.1, 29.4). Only static drawings are recorded again; sight, memory and actors are kept. */
    setPalette(id) {
      this.setArtOptions({ palette: id });
    }
    setArtOptions({ palette = this.paletteId, lighting = this.lighting, wear = this.wear } = {}) {
      this.paletteId = palette; this.lighting = lighting !== false; this.wear = wear !== false;
      this.colors = themeColors(palette); this.cameras.main.setBackgroundColor(css(this.colors.background));
      const map = api.map(); if (map?.obstacles && this.sightMap) this.recordStatic(map, new Map(this.tileCache.groups));
    }
    /**
     * Record the map's static drawings and labels in the current palette, replacing any recorded before.
     * `priorGroups` carries roof and canopy fades over a restyle; a new map starts them afresh.
     */
    recordStatic(map, priorGroups = new Map()) {
      this.tileCache.reset();
      this.labels.forEach(l => l.destroy()); this.labels = [];
      const recorded = recordStatic(this.tileCache, map, { ink: this.colors, palette: this.paletteId, lighting: this.lighting, wear: this.wear },
        priorGroups, (x, y, text, color, size) => this.label(x, y, text, color, size));
      this.roofs = recorded.roofs; this.roofMembers = recorded.roofMembers;
      this.coveredBuildingIds = recorded.coveredBuildingIds; this.buildingsById = recorded.buildingsById;
    }
    makeActor(p) {
      const size = p.role === 'gladiator' ? 65 : 43;
      const sprite = this.add.image(0, 0, p.role).setDisplaySize(size, size);
      const identity = this.add.image(0, 0, `${p.role}-identity`).setDisplaySize(size, size);
      const visor = this.add.image(0, 0, `${p.role}-visor`).setDisplaySize(size, size);
      const baseTint = actorBaseTint(p, api.playerId(), api.kits?.());
      identity.setTint(baseTint);
      const ring = this.add.graphics(), bar = this.add.graphics(), geometry = this.add.graphics().setVisible(false);
      const name = this.add.text(0, -35, p.id === api.playerId() && !api.replay() ? 'YOU' : p.name, { fontFamily: 'Arial', fontSize: LABEL_FONT_PX, fontStyle: 'bold', color: '#f8fce9', stroke: '#294a3e', strokeThickness: 8 }).setOrigin(0.5).setScale(this.nameScale);
      const container = this.add.container(p.x, p.y, [ring, sprite, identity, visor, bar, name, geometry]); this.world.add(container); this.world.bringToTop(this.overheadLayer);
      const actor = { sprite, identity, visor, ring, bar, name, geometry, container, baseTint }; this.actors.set(p.id, actor); return actor;
    }
    /** The active player nearest a pointer, within a fixed screen distance of it, or null. */
    playerAt(pointer) {
      const state = api.state(); if (!state) return null;
      const point = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
      let best = null, nearest = 44 / this.cameras.main.zoom;
      for (const p of state.players) {
        if (p.status !== 'active') continue;
        if (!this.actors.get(p.id)?.container.visible) continue;
        const distance = Math.hypot(p.x - point.x, p.y - point.y);
        if (distance <= nearest) { best = p; nearest = distance; }
      }
      return best;
    }
    /** The world point under the pointer. */
    pointerWorld() { const p = this.input.activePointer; return this.cameras.main.getWorldPoint(p.x, p.y); }
    /** Where the camera is now: its centre and zoom, the shape the director works in. */
    cameraView() {
      const camera = this.cameras.main;
      return { x: camera.scrollX + camera.width / 2, y: camera.scrollY + camera.height / 2, zoom: camera.zoom };
    }
    /** Drop the smoothed eye and the old subject's gate memory, so the next frame cuts to a new subject. */
    cutTo() {
      this.eye = null; this.sight = null; this.visionPoints = null;
      this.gateMemory?.clear(); this.rememberedGates = []; this.vision?.clear(); this.updateCamera();
    }
    updateCamera() {
      const state = api.state(), map = api.map(); if (!state || !map) return;
      // A directed camera is the director's to point: whole arena, a free view, or a followed player.
      const focus = this.eye || api.follow() || api.self() || state.players[0];
      const { x, y, zoom } = api.directed()
        ? api.director.frame({ width: this.scale.width, height: this.scale.height, map, focus: this.eye || api.follow() })
        : { x: focus?.x || map.width / 2, y: focus?.y || map.height / 2, zoom: playerZoom(this.scale.width, this.scale.height) * (1 + (INSIDE_ZOOM - 1) * this.insideBlend) };
      const camera = this.cameras.main; camera.setZoom(zoom);
      // The eye is already smoothed, so the camera tracks it directly rather than easing a second time.
      camera.centerOn(x, y);
      this.marker = api.directed() ? markerScale(zoom) : 1;
      this.nameScale = labelScale(zoom, this.marker);
    }
    /**
     * Ease the eye toward its focus, or cut to it. Camera, own sprite, fog and cover all read this one
     * eased eye: fog sampled from the raw predicted position would lead the world by the easing lag and
     * step at the input tick.
     */
    stepEye(state, map, actorBodies, self, selfBody, rawDelta, delta) {
      // Exponential, so the eye settles on the same time constant whatever the frame rate; a plain
      // fraction of the frame delta eases faster on a slow client than a fast one.
      const ease = 1 - Math.exp(-delta / EYE_TAU_MS);
      // A followed replay subject drives the same eased eye the player's own view uses, so a followed
      // camera glides exactly like a live one and cuts only when the subject changes or teleports.
      // A directed view's eye is the followed player or nobody: never the viewer's own player, whose
      // position would otherwise cull a whole-arena view down to the area around them.
      if (api.directed()) api.director.step(rawDelta ?? delta);
      const rawFollow = api.directed() ? api.follow() : null;
      const followBody = rawFollow && actorBodies.get(rawFollow.id);
      const follow = followBody ? { ...rawFollow, x: followBody.x, y: followBody.y } : rawFollow;
      const focus = api.directed() ? follow : self;
      const focusBody = api.directed() ? followBody : selfBody;
      const eyeBodyKey = focus ? { focusId: focus.id, bodyId: focusBody?.id, generation: focusBody?.generation,
        predictionCut: api.localPhysics?.() ? api.predictionCut?.() : undefined,
        profile: focusBody ? state.physicsProfile : undefined,
        placementTick: focusBody?.discontinuity === 'placed' ? state.tick : null } : null;
      const previousEyeBodyKey = this.eyeBodyKey;
      const bodyCut = eyeBodyKey && previousEyeBodyKey && (focusBody || previousEyeBodyKey.bodyId != null) &&
        (eyeBodyKey.focusId !== previousEyeBodyKey.focusId || eyeBodyKey.bodyId !== previousEyeBodyKey.bodyId ||
          eyeBodyKey.generation !== previousEyeBodyKey.generation || eyeBodyKey.profile !== previousEyeBodyKey.profile || eyeBodyKey.predictionCut !== previousEyeBodyKey.predictionCut ||
          eyeBodyKey.placementTick != null && eyeBodyKey.placementTick !== previousEyeBodyKey.placementTick);
      this.eyeBodyKey = eyeBodyKey;
      if (!focus) this.eye = null;
      else if (!this.eye || bodyCut || Math.hypot(focus.x - this.eye.x, focus.y - this.eye.y) > 150 ||
        api.localPhysics?.() && ((rawDelta ?? delta) > PREDICTION_LIMITS.eyeSnapMs || !sweptClear(map, this.eye, focus, selfBody ? bodyRadius(selfBody.shape) : 12))) this.eye = { x: focus.x, y: focus.y };
      else { this.eye.x = Phaser.Math.Linear(this.eye.x, focus.x, ease); this.eye.y = Phaser.Math.Linear(this.eye.y, focus.y, ease); }
      return this.eye;
    }
    /** Cut the eye's sight and lay the shade outside it; an unfogged view has no sight and no shade. */
    updateSight(state, map, eye, fogged, zoom) {
      this.shade.clear();
      if (!fogged || !eye) {
        this.visionPoints = null; this.sight = null; this.vision.clear();
        // An empty viewport observes nothing but retains known gates and unknown closed silhouettes.
        this.rememberedGates = fogged ? observeGates(map, { x: 0, y: 0 },
          { x: 0, y: 0, width: -1, height: -1 }, this.gateMemory, state.tick) : [];
      }
      else {
        start('render.vision');
        this.viewBounds = viewBounds(eye, this.scale.width, this.scale.height, zoom);
        this.rememberedGates = observeGates(map, eye, this.viewBounds, this.gateMemory, state.tick);
        this.sightMap.obstacles = map.obstacles; this.sightMap.gates = this.rememberedGates;
        this.visionPoints = visibilityPolygon(this.sightMap, eye, viewRadius(this.viewBounds, eye));
        this.sight = { eye, bounds: this.viewBounds, points: this.visionPoints };
        this.vision.clear(); this.vision.fillStyle(0xffffff); this.vision.fillPoints(this.visionPoints, true);
        // Shade covers the whole arena; the inverted mask cuts the lit wedge back out of it.
        this.shade.fillStyle(this.colors.shade, 0.46);
        this.shade.fillRect(-500, -500, map.width + 1000, map.height + 1000);
        stop('render.vision');
      }
      if (fogged && !eye) { this.shade.fillStyle(this.colors.shade, 0.46); this.shade.fillRect(-500, -500, map.width + 1000, map.height + 1000); }
    }
    /** Place, show and mark every player's sprite, making and destroying them as players come and go. */
    drawActors(state, map, actorBodies, eye, viewer, fogged, canonicalFields, artOpts) {
      const actorGeometry = api.geometryOverlay?.();
      const ids = new Set();
      for (const rawPlayer of state.players) {
        const body = actorBodies.get(rawPlayer.id);
        const p = body ? { ...rawPlayer, x: body.x, y: body.y } : rawPlayer;
        ids.add(p.id); const actor = this.actors.get(p.id) || this.makeActor(p); const own = p.id === api.playerId();
        // Own marks the viewer's player in any view; only a live one is steered by local aim and eye.
        const controlled = own && !api.directed();
        // Ordinary dynamic actors, including allies, are occluded. Reveals remain an explicit exception.
        // The player whose sight this is always sees themselves, cloaked or not. In a fogged directed
        // view that is the followed player, not the viewer's own, who is shown only if in their sight.
        const shown = !fogged || p.id === viewer?.id || seesActor(this.sight, map, viewer, p);
        actor.container.setVisible(p.status === 'active' && shown);
        // Everyone but the viewer is drawn where the frame says, with no filter of its own. The
        // position already arrived interpolated between two authoritative states, so easing toward
        // it a second time would only add back the lag the buffer exists to remove.
        if (controlled && eye) { actor.container.x = eye.x; actor.container.y = eye.y; }
        else { actor.container.x = p.x; actor.container.y = p.y; }
        const rot = controlled ? api.aim() : p.heading;
        const alpha = p.cloak ? 0.45 : 1;
        actor.sprite.setRotation(rot); actor.sprite.setAlpha(alpha);
        actor.identity.setRotation(rot); actor.identity.setAlpha(alpha);
        actor.visor.setRotation(rot); actor.visor.setAlpha(alpha);
        const baseTint = actorBaseTint(p, api.playerId(), api.kits?.());
        if (actor.baseTint !== baseTint) { actor.baseTint = baseTint; actor.identity.setTint(baseTint); }
        if (p.status === 'active' && shown) {
          if (artOpts.lighting && canonicalFields.length > 0) {
            const lightSample = sampleSpatialLight(canonicalFields, actor.container.x, actor.container.y, artOpts);
            actor.sprite.setTint(resolveActorTint(0xffffff, lightSample, artOpts));
          } else {
            actor.sprite.setTint(0xffffff);
          }
        }
        // Markers hold their apparent size as the camera pulls back; names hold a fixed pixel height
        // rather than riding that scale, which would leave them unreadable at whole arena zoom.
        actor.container.setScale(this.marker); actor.name.setScale(this.nameScale);
        if (actorGeometry) {
          // The marker may grow as the camera pulls back; these radii remain world distances.
          actor.geometry.clear(); actor.geometry.setVisible(true);
          actor.geometry.setScale(1 / this.marker);
          const { headRadius, bodyRadius, hurtRadius } = actorGeometry[p.role];
          actor.geometry.lineStyle(2, 0x79d7ff, 0.9); actor.geometry.strokeCircle(0, 0, headRadius);
          actor.geometry.lineStyle(2, 0xffd46d, 0.9); actor.geometry.strokeCircle(0, 0, bodyRadius);
          actor.geometry.lineStyle(2, 0xff6d9a, 0.9); actor.geometry.strokeCircle(0, 0, hurtRadius);
        } else if (actor.geometry.visible) { actor.geometry.clear(); actor.geometry.setVisible(false); }
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
    }
    update(now, delta) {
      const rawDelta = noteFrame();
      start('render.frame'); if (rawDelta !== null) observe('render.delta', rawDelta);
      api.onFrame(delta);
      const state = api.state(), map = api.map(), rawSelf = api.self();
      if (!state || !map) { stop('render.frame'); endProfileFrame(); return; }
      const actorBodies = new Map((state.bodies || []).filter(body => body.kind === 'actor' && body.actorId != null).map(body => [body.actorId, body]));
      const itemBodies = new Map((state.bodies || []).filter(body => body.kind === 'prop' && body.itemId != null).map(body => [body.itemId, body]));
      const selfBody = rawSelf && actorBodies.get(rawSelf.id);
      const self = selfBody && !api.localPhysics?.() ? { ...rawSelf, x: selfBody.x, y: selfBody.y } : rawSelf;
      const eye = this.stepEye(state, map, actorBodies, self, selfBody, rawDelta, delta);
      // Whose sight the view is cut to: the player's own, a followed player's in a fogged directed
      // view, or nobody's, which is the unfogged directed view.
      const fogged = !api.directed() || api.director.fog() && !!api.director.followId();
      const rawViewer = api.directed() ? api.director.viewer() : self;
      const viewerBody = rawViewer && actorBodies.get(rawViewer.id);
      const viewer = viewerBody ? { ...rawViewer, x: viewerBody.x, y: viewerBody.y } : rawViewer;
      // Raw frame time, not Phaser's smoothed and clamped delta, so a slow client pans as far as a fast one.
      // Stepping indoors eases the camera a little closer; a directed camera is the director's alone.
      const within = !api.directed() && eye && roofAt(map, eye);
      this.insideBlend += ((within ? 1 : 0) - this.insideBlend) * (1 - Math.exp(-(rawDelta ?? delta) / 250));
      if (Math.abs((within ? 1 : 0) - this.insideBlend) < 0.005) this.insideBlend = within ? 1 : 0;
      start('render.camera'); this.updateCamera(); stop('render.camera');
      const view = this.view, camera = this.cameras.main;
      view.map = map; view.fogged = fogged; view.now = now;
      view.setCamera(this.cameraView(), camera.width, camera.height);
      start('render.roofs'); fadeRoofs(map, this, eye, buildingOpenings(map), rawDelta ?? delta, view); stop('render.roofs');
      start('render.tiles'); this.tileCache.update(camera); stop('render.tiles');
      // Sub-pixel map labels become illegible smudge below LOD_LABEL_ZOOM; hide them until the camera zooms in.
      const showLabels = view.zoom >= LOD_LABEL_ZOOM;
      for (const label of this.labels) label.setVisible(showLabels && view.nearView(label.x, label.y));
      this.updateSight(state, map, eye, fogged, view.zoom);
      view.sight = this.sight;
      api.onSight?.();
      const g = this.dynamic; g.clear();
      const fixed = this.fixtures; fixed.clear();
      const fields = map.appearance?.lighting?.fields || [];
      const canonicalFields = getCanonicalFields(fields);
      const artOpts = { palette: this.paletteId, lighting: this.lighting, wear: this.wear, buildingsById: this.buildingsById };
      start('render.world');
      view.alpha = api.frameAlpha();
      // Event light (#594): only sources that pass the same `lit` rule as the shots and effects drawn
      // below may light anything. Props drawn above the layer take the same lift as the ground beneath.
      const eventLights = resolveEventLights(state, { lighting: this.lighting, lit: view.lit, inView: view.nearView, alpha: view.alpha });
      drawEventLights(this.eventLight, eventLights);
      // An empty additive layer still costs Phaser a blend switch and batch flush each frame.
      this.eventLight.setVisible(eventLights.length > 0);
      count('work.eventLights', eventLights.length);
      const playersById = new Map(state.players.map(player => [player.id, player]));
      const bodies = visibleBodies(state, playersById, viewer, view);
      drawTethers(g, state.tethers || [], bodies, view);
      drawHookFlights(g, state.hookFlights || [], bodies, view);
      drawProps(g, bodies, state.items || [], canonicalFields, artOpts, eventLights, view);
      drawGates(fixed, fogged ? this.rememberedGates : state.gates, view);
      drawItems(g, state.items, itemBodies, view);
      drawSensors(fixed, map.sensors, view);
      drawTraps(g, state.traps || [], view);
      this.shots = projectShots(state.projectiles, view.alpha);
      drawShots(g, this.shots, view);
      drawEffects(g, state.effects, view);
      drawHazard(fixed, state.hazardX, map);
      // Read from the frame's own record: a predicted copy of the player may not carry the latest cues.
      drawHeardCues(g, api.directed() ? [] : playersById.get(api.playerId())?.heard ?? [], state.tick, view);
      stop('render.world');
      start('render.actors'); this.drawActors(state, map, actorBodies, eye, viewer, fogged, canonicalFields, artOpts); stop('render.actors');
      stop('render.frame');
      endProfileFrame();
    }
  };
}
