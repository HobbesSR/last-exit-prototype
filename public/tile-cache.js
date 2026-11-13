import { count } from '/shared/profiler.ts';

// Static drawings are recorded once and rasterised into cached tile textures, so a frame blits a few
// quads instead of re-tessellating every shape. Phaser's Graphics replays and re-triangulates its
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
// Each Graphics method a recorder accepts, recorded for replay into the tiles it touches.
const STATIC_DRAWS = ['fillStyle', 'lineStyle', 'fillPoints', 'strokePoints', 'fillRect', 'strokeRect', 'fillRoundedRect', 'strokeRoundedRect', 'lineBetween', 'fillCircle', 'fillEllipse', 'fillTriangle', 'beginPath', 'arc', 'strokePath'];

/**
 * A cache of baked static drawings. The base plane's tiles go beneath everything in `world`; each
 * overhead group (a roof, the tree canopy) has tiles of its own in its layer's container, so the group
 * owns its alpha and visibility. It knows nothing of maps: it is handed boxes and draw calls.
 */
export class TileCache {
  /** `layers` maps an overhead group's layer name to the container its tiles join. */
  constructor(scene, world, layers) {
    this.scene = scene; this.world = world; this.layers = layers;
    this.scratch = scene.make.graphics({ x: 0, y: 0, add: false });
    this.groups = new Map();
    this.reset();
  }
  /** Destroy every texture and forget every drawing and group. */
  reset() {
    for (const cache of [this.tiles, this.overheadTiles]) for (const tile of cache?.values() || []) tile.texture?.destroy();
    this.drawings = []; this.drawingsByCell = new Map(); this.tiles = new Map();
    this.overheadDrawings = []; this.overheadByCell = new Map(); this.overheadTiles = new Map(); this.groups.clear();
  }
  /**
   * A recorder for one static drawing inside the given world box. Its calls are replayed into every
   * tile the box touches, and each tile's texture clips them to its own square, so a shape that
   * straddles a seam is drawn whole on both sides of it. `group` names an overhead group, or null
   * for the base plane.
   */
  record(left, top, right, bottom, group = null) {
    const drawings = group === null ? this.drawings : this.overheadDrawings;
    const byCell = group === null ? this.drawingsByCell : this.overheadByCell;
    const id = drawings.length, calls = [];
    drawings.push(calls);
    for (let cy = Math.floor((top - SEAM) / CELL); cy <= Math.floor((bottom + SEAM) / CELL); cy++) for (let cx = Math.floor((left - SEAM) / CELL); cx <= Math.floor((right + SEAM) / CELL); cx++) {
      const key = `${cx},${cy}`;
      if (!byCell.has(key)) byCell.set(key, group === null ? [] : new Map());
      if (group === null) byCell.get(key).push(id);
      else {
        if (!byCell.get(key).has(group)) byCell.get(key).set(group, []);
        byCell.get(key).get(group).push(id);
      }
    }
    const recorder = {};
    for (const method of STATIC_DRAWS) recorder[method] = (...args) => { calls.push(method, args); return recorder; };
    return recorder;
  }
  /**
   * Declare an overhead group drawn in `layer` within `bounds`. The returned state's `visible` and
   * `alpha` are read on every `update`.
   */
  group(id, layer, bounds, prior = null) {
    // A restyled roof keeps the fade it was part way through rather than flashing back to opaque.
    const group = { layer, bounds, visible: prior?.visible ?? true, alpha: prior?.alpha ?? 1, textures: new Set() };
    this.groups.set(id, group);
    return group;
  }
  setGroup(id, visible, alpha = this.groups.get(id)?.alpha ?? 1) {
    const group = this.groups.get(id);
    if (!group) return;
    group.visible = visible; group.alpha = alpha;
    for (const texture of group.textures) texture.setVisible(visible && texture.overheadShown).setAlpha(alpha);
  }
  /** Rasterise the drawings that touch a tile, in the order they were recorded. */
  rasterise(tile, resolution) {
    const cells = 1 << tile.level, span = CELL * cells, tileLeft = tile.tx * span, tileTop = tile.ty * span;
    const overhead = tile.group !== null;
    const drawings = overhead ? this.overheadDrawings : this.drawings;
    const byCell = overhead ? this.overheadByCell : this.drawingsByCell;
    const ids = new Set();
    for (let cy = tile.ty * cells; cy < (tile.ty + 1) * cells; cy++) for (let cx = tile.tx * cells; cx < (tile.tx + 1) * cells; cx++)
      for (const id of (overhead ? byCell.get(`${cx},${cy}`)?.get(tile.group) : byCell.get(`${cx},${cy}`)) || []) ids.add(id);
    tile.resolution = resolution;
    if (!ids.size) { tile.empty = true; return; }
    // The tile plus one texel of its neighbours on every side; see SEAM.
    // An overhead group gets only the texels in its footprint, not a full tile's worth of transparent space.
    const box = overhead ? this.groups.get(tile.group).bounds : null;
    const pixelLeft = Math.floor(Math.max(tileLeft, box?.x ?? tileLeft) * resolution);
    const pixelTop = Math.floor(Math.max(tileTop, box?.y ?? tileTop) * resolution);
    const pixelRight = Math.ceil(Math.min(tileLeft + span, box ? box.x + box.w : tileLeft + span) * resolution);
    const pixelBottom = Math.ceil(Math.min(tileTop + span, box ? box.y + box.h : tileTop + span) * resolution);
    if (pixelRight <= pixelLeft || pixelBottom <= pixelTop) { tile.empty = true; return; }
    const rawWidth = pixelRight - pixelLeft + 2, rawHeight = pixelBottom - pixelTop + 2, texel = 1 / resolution;
    // Phaser 3.90 RenderTexture defaults to forceEven=true, which rounds the frame to even without
    // resizing its RenderTarget (autoResize=false) and stretches odd-sized cropped overhead textures.
    const width = rawWidth + (rawWidth & 1), height = rawHeight + (rawHeight & 1);
    // A new texture rather than resize(), which left content clipped and offset in Phaser 3.90.
    if (tile.texture?.width !== width || tile.texture?.height !== height) {
      if (overhead && tile.texture) this.groups.get(tile.group).textures.delete(tile.texture);
      tile.texture?.destroy();
      tile.texture = this.scene.add.renderTexture((pixelLeft - 1) * texel, (pixelTop - 1) * texel, width, height).setOrigin(0, 0);
      if (overhead) {
        const group = this.groups.get(tile.group);
        this.layers[group.layer].add(tile.texture);
        group.textures.add(tile.texture);
      }
      else this.world.addAt(tile.texture, 0);
    }
    const g = this.scratch.clear().setScale(resolution);
    for (const id of [...ids].sort((a, b) => a - b)) { const calls = drawings[id]; for (let i = 0; i < calls.length; i += 2) g[calls[i]](...calls[i + 1]); }
    tile.texture.clear().setScale(texel).draw(g, 1 - pixelLeft, 1 - pixelTop);
    g.clear();
    count('work.tileRasterise');
  }
  /**
   * Show the tiles the camera can see, rasterise what they lack within a frame budget, and release
   * textures far from the view or at another level.
   */
  update(camera) {
    // worldView is only refreshed when the camera renders, a frame behind centerOn, so derive it here.
    const zoom = camera.zoom;
    const view = { width: camera.width / zoom, height: camera.height / zoom };
    view.x = camera.scrollX + camera.width / 2 - view.width / 2; view.y = camera.scrollY + camera.height / 2 - view.height / 2;
    // At least one texel per screen pixel, quantised so a window resize does not rebuild every tile.
    const resolution = Math.min(MAX_RESOLUTION, Math.max(MIN_RESOLUTION, Math.ceil(zoom * 16) / 16));
    const level = Math.max(0, Math.ceil(Math.log2(MIN_TILE_PIXELS / (CELL * zoom))));
    const span = CELL << level;
    const range = margin => ({ left: Math.floor(view.x / span) - margin, top: Math.floor(view.y / span) - margin, right: Math.floor((view.x + view.width) / span) + margin, bottom: Math.floor((view.y + view.height) / span) + margin });
    const shown = range(0), wanted = range(PREFETCH_TILES), kept = range(RETAIN_TILES);
    const within = (tile, r) => tile.tx >= r.left && tile.tx <= r.right && tile.ty >= r.top && tile.ty <= r.bottom;
    for (const cache of [this.tiles, this.overheadTiles]) for (const [key, tile] of cache) {
      if (tile.level !== level || !within(tile, kept)) {
        if (tile.group !== null && tile.texture) this.groups.get(tile.group).textures.delete(tile.texture);
        tile.texture?.destroy(); cache.delete(key);
      } else if (tile.texture) {
        const visible = within(tile, shown);
        if (tile.group === null) tile.texture.setVisible(visible);
        else {
          const group = this.groups.get(tile.group);
          tile.texture.overheadShown = visible;
          tile.texture.setVisible(visible && group.visible).setAlpha(group.alpha);
        }
      }
    }
    const centre = { x: (view.x + view.width / 2) / span, y: (view.y + view.height / 2) / span };
    const queue = [];
    for (let ty = wanted.top; ty <= wanted.bottom; ty++) for (let tx = wanted.left; tx <= wanted.right; tx++) {
      const key = `${level}:${tx}:${ty}`;
      let tile = this.tiles.get(key);
      if (!tile) this.tiles.set(key, tile = { level, tx, ty, group: null, texture: null, resolution: 0, empty: false });
      const visible = within(tile, shown);
      tile.texture?.setVisible(visible);
      // A visible hole first, then a visible tile at a stale resolution, then prefetch.
      if (!tile.empty && tile.resolution !== resolution) queue.push({ tile, visible, rank: visible ? tile.texture ? 1 : 0 : 2, distance: Math.hypot(tx + 0.5 - centre.x, ty + 0.5 - centre.y) });
      // Only materialise overhead groups that actually have art in this tile.
      const groups = new Set(), cells = 1 << level;
      for (let cy = ty * cells; cy < (ty + 1) * cells; cy++) for (let cx = tx * cells; cx < (tx + 1) * cells; cx++)
        for (const group of this.overheadByCell.get(`${cx},${cy}`)?.keys() || []) groups.add(group);
      for (const group of groups) {
        const overheadKey = `${group}:${key}`;
        let overheadTile = this.overheadTiles.get(overheadKey);
        if (!overheadTile) this.overheadTiles.set(overheadKey, overheadTile = { level, tx, ty, group, texture: null, resolution: 0, empty: false });
        const groupState = this.groups.get(group);
        if (overheadTile.texture) overheadTile.texture.overheadShown = visible;
        overheadTile.texture?.setVisible(visible && groupState.visible).setAlpha(groupState.alpha);
        if (groupState.visible && !overheadTile.empty && overheadTile.resolution !== resolution)
          queue.push({ tile: overheadTile, visible, rank: visible ? overheadTile.texture ? 1 : 0 : 2, distance: Math.hypot(tx + 0.5 - centre.x, ty + 0.5 - centre.y) });
      }
    }
    queue.sort((a, b) => a.rank - b.rank || a.distance - b.distance);
    const started = performance.now();
    for (const [index, { tile, visible }] of queue.entries()) {
      if (index && performance.now() - started > BUILD_MS) break;
      this.rasterise(tile, resolution);
      if (tile.group === null) tile.texture?.setVisible(visible);
      else {
        const group = this.groups.get(tile.group);
        if (tile.texture) {
          tile.texture.overheadShown = visible;
          tile.texture.setVisible(visible && group.visible).setAlpha(group.alpha);
        }
      }
    }
  }
}
