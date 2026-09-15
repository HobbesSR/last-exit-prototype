import {
  DEFAULT_LIBRARY,
  generateMap,
  validateLibrary,
  findPath,
  canOccupy,
  gridViews,
  cellIndexAt,
  OUTSIDE_CLASS,
  cellClassNames,
  tileZone,
} from "/src/core.ts";
import { artifactToBson, artifactToJson } from "/src/artifact.ts";
import type {
  GeneratedMap,
  Library,
  MapEdge,
  MapFeature,
  PlacedTile,
  Point,
  Side,
  TileDesign,
  SegmentDeclaration,
} from "/src/types.ts";
import {
  segmentPlace,
  tilePrimitives,
  segmentDeclaration,
  cellAt,
  hSeg,
  vSeg,
  SEGMENT_COUNT,
} from "/src/primitives.ts";

const $ = (id: string): HTMLElement => document.getElementById(id)!;
const input = (id: string) => $(id) as HTMLInputElement;
const select = (id: string) => $(id) as HTMLSelectElement;
const area = (id: string) => $(id) as HTMLTextAreaElement;
const canvas = $("map") as HTMLCanvasElement,
  ctx = canvas.getContext("2d")!;

interface Bullet {
  x: number;
  y: number;
  dx: number;
  dy: number;
  life: number;
}
interface Pursuer {
  x: number;
  y: number;
  respawn: number;
  path: string[];
  repath: number;
  target?: Point | null;
}
interface LootItem {
  x: number;
  y: number;
  taken: boolean;
}
interface Run {
  x: number;
  y: number;
  radius: number;
  body: string;
  health: number;
  score: number;
  charge: number;
  time: number;
  shootCd: number;
  hitCd: number;
  warpCd: number;
  bullets: Bullet[];
  loot: LootItem[];
  hunters: Pursuer[];
}
let library: Library = structuredClone(DEFAULT_LIBRARY),
  // build() runs during module init and reassigns both before any read.
  map!: GeneratedMap,
  cellRegion!: Int32Array,
  selected: PlacedTile | null = null,
  zoom = 1,
  pan = { x: 0, y: 0 },
  dragging: { x: number; y: number; px: number; py: number } | null = null,
  moved = false,
  playing = false,
  run: Run | null = null,
  last = 0,
  mouse = { x: 0, y: 0 },
  keys = new Set<string>(),
  routes: string[][] = [];
let libraryOrigin = "shipped library",
  libraryRevision = 0,
  builtLibraryRevision = 0;
const colors = ["#254e54", "#426254", "#6d704c", "#8b6545", "#884b48"];
const hash = (s: unknown): number =>
  [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 0);
function download(name: string, body: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function center(tile: PlacedTile): Point {
  return tile.anchor ?? { x: tile.x + 3, y: tile.y + 3 };
}
function regionIndexOf(cellIndex: number): number {
  return cellRegion?.[cellIndex] ?? -1;
}
const regionColor = (i: number) => `hsl(${(i * 137.508) % 360} 45% 30%)`;
function tileAt(x: number, y: number): PlacedTile | undefined {
  return map?.tiles.find(
    (t) => x >= t.x && x < t.x + 6 && y >= t.y && y < t.y + 6,
  );
}
function point(e: { clientX: number; clientY: number }): Point {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
function world(p: Point): Point {
  return { x: (p.x - pan.x) / zoom, y: (p.y - pan.y) / zoom };
}
function fit() {
  if (!map) return;
  zoom = Math.min(
    (canvas.clientWidth - 70) / map.width,
    (canvas.clientHeight - 105) / map.height,
  );
  pan = {
    x: (canvas.clientWidth - map.width * zoom) / 2,
    y: (canvas.clientHeight - map.height * zoom) / 2 - 10,
  };
}
function resize() {
  const r = canvas.getBoundingClientRect(),
    d = window.devicePixelRatio || 1;
  canvas.width = r.width * d;
  canvas.height = r.height * d;
  ctx.setTransform(d, 0, 0, d, 0, 0);
  if (!playing) fit();
}
new ResizeObserver(resize).observe(canvas);
function build() {
  try {
    const next = generateMap(
      input("seed").value,
      {
        zoneWidth: Number(input("zoneWidth").value),
        zoneHeight: Number(input("zoneHeight").value),
        exitCount: Number(input("exits").value),
      },
      library,
    );
    if (!next.validation.valid) throw Error(next.validation.errors.join("\n"));
    map = next;
    builtLibraryRevision = libraryRevision;
    const index = new Int32Array(map.grid.width * map.grid.height).fill(-1);
    map.regions.forEach((region, position) => {
      for (const cellIndex of region.cells) index[cellIndex] = position;
    });
    cellRegion = index;
    stop();
    selected = null;
    routes = routePaths();
    fit();
    $("status").textContent =
      `Validated · ${map.tiles.length} tiles · ${map.zones.length} zones · seed ${map.seed}`;
    $("extent").textContent =
      `${map.params.columns} × ${map.params.rows} tiles, ${map.width} × ${map.height} cells`;
    showMetrics();
    $("inspector").textContent = "Select a tile.";
    renderLibraryMeta();
  } catch (e) {
    $("status").textContent = `Build failed: ${(e as Error).message}`;
  }
}
function routePaths(
  exit: MapFeature | undefined = map.features.find((f) => f.kind === "exit"),
): string[][] {
  const spawn = map.features.find((f) => f.kind === "spawn")!;
  return (["contestant", "hunter"] as const).map((a) =>
    findPath(map, spawn.tileId, exit!.tileId, a),
  );
}
function showMetrics(): void {
  const m = map.metrics;
  const pairs = [
    ["Tiles", map.tiles.length],
    ["Tile-graph leaves", m.deadEnds],
    ["Contestant-only seams", m.squeezes],
    ["Sealed seams", m.sealedSeams ?? 0],
    ["Regions", map.regions.length],
    ["Zones", map.zones.length],
    ["Solid cells", `${Math.round((m.solidFraction || 0) * 100)}%`],
    ["Route / direct", Number(m.detourRatio || 0).toFixed(2)],
    ["Hunter distance", Math.round(m.hunterDistance || 0)],
  ];
  $("metrics").replaceChildren(
    ...pairs.map(([label, value]) => {
      const el = document.createElement("div");
      el.className = "metric";
      const strong = document.createElement("strong"),
        span = document.createElement("span");
      strong.textContent = String(value ?? "—");
      span.textContent = String(label);
      el.append(strong, span);
      return el;
    }),
  );
}
function inspect(t: PlacedTile | null | undefined): void {
  selected = t ?? null;
  $("editSelected").hidden = !t;
  if (!t) return;
  const features = map.features.filter((f) => f.tileId === t.id);
  const views = gridViews(map);
  const own: number[] = [];
  for (let dy = 0; dy < 6; dy++)
    for (let dx = 0; dx < 6; dx++) {
      const i = cellIndexAt(map, t.x + dx, t.y + dy);
      if (i >= 0) own.push(i);
    }
  const zone = tileZone(map, t);
  const classes = [...new Set(own.map((i) => views.cellClass(i)))];
  const touched = new Set(own.map(regionIndexOf));
  const loot = own.filter((i) => views.spawns.has(i)).length;
  $("inspector").textContent = [
    `Tile ${t.id} · (${t.col}, ${t.row})`,
    `Zone ${t.zoneId} · tier ${zone?.tier ?? "?"} / bonus ${zone?.bonus ?? "?"}`,
    `Template: ${t.templateId} @ ${t.orientation}°`,
    `Cell classes: ${classes.join(", ")}`,
    `Regions crossing this tile: ${touched.size} · loot slots ${loot}`,
    features.map((f) => f.kind).join(", ") || "No required feature",
  ].join("\n");
  const exit = features.find((f) => f.kind === "exit");
  if (exit) routes = routePaths(exit);
}
$("editSelected").onclick = () => {
  if (!selected) return;
  tab("author");
  select("template").value = selected.templateId;
  editTemplate();
};
function line(a: Point, b: Point, color: string, width = 1): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}
function circle(x: number, y: number, r: number, color: string): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}
function draw() {
  const d = window.devicePixelRatio || 1;
  ctx.setTransform(d, 0, 0, d, 0, 0);
  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  if (!map) return;
  ctx.save();
  ctx.translate(pan.x, pan.y);
  ctx.scale(zoom, zoom);
  const overlay = select("overlay").value;
  const views = gridViews(map);
  if (overlay === "region" || overlay === "class") {
    for (let y = 0; y < map.grid.height; y++)
      for (let x = 0; x < map.grid.width; x++) {
        const i = y * map.grid.width + x;
        const cellClass = views.cellClass(i);
        if (cellClass === OUTSIDE_CLASS) continue;
        ctx.fillStyle = views.cellSolid(i)
          ? "#0a1419"
          : overlay === "region"
            ? regionColor(regionIndexOf(i))
            : `hsl(${hash(cellClass) % 360} 32% 30%)`;
        ctx.fillRect(x, y, 1, 1);
      }
  } else {
    const zoneById = new Map(map.zones.map((z) => [z.id, z]));
    for (const t of map.tiles) {
      const zone = zoneById.get(t.zoneId);
      ctx.fillStyle =
        overlay === "tier"
          ? colors[(zone?.tier ?? 1) - 1]
          : overlay === "bonus"
            ? `hsl(${185 + (zone?.bonus ?? 0) * 12} 28% ${22 + (zone?.bonus ?? 0) * 6}%)`
            : `hsl(${hash(t.templateId) % 360} 25% 28%)`;
      ctx.fillRect(t.x, t.y, 6, 6);
    }
    // Zone boundaries, so the progression grid is legible over the tiles.
    if (overlay === "tier" || overlay === "bonus") {
      ctx.strokeStyle = "#9fe8f088";
      ctx.lineWidth = 2 / zoom;
      for (const z of map.zones)
        ctx.strokeRect(
          z.cells[0],
          z.cells[1],
          z.cells[2] - z.cells[0] + 1,
          z.cells[3] - z.cells[1] + 1,
        );
    }
    ctx.fillStyle = "#0a1419";
    for (let y = 0; y < map.grid.height; y++)
      for (let x = 0; x < map.grid.width; x++)
        if (views.cellSolid(y * map.grid.width + x)) ctx.fillRect(x, y, 1, 1);
  }
  ctx.strokeStyle = "#10212b88";
  ctx.lineWidth = 0.05;
  for (const t of map.tiles) ctx.strokeRect(t.x, t.y, 6, 6);
  if (zoom > 9) {
    ctx.strokeStyle = "#ffffff09";
    ctx.lineWidth = 0.035;
    for (const t of map.tiles) {
      for (let i = 1; i < 6; i++) {
        line(
          { x: t.x + i, y: t.y },
          { x: t.x + i, y: t.y + 6 },
          "#ffffff09",
          0.035,
        );
        line(
          { x: t.x, y: t.y + i },
          { x: t.x + 6, y: t.y + i },
          "#ffffff09",
          0.035,
        );
      }
    }
  }
  for (const w of map.walls)
    line({ x: w.x1, y: w.y1 }, { x: w.x2, y: w.y2 }, "#071015", 0.2);
  // A seam only a contestant fits through. Read off the measured width, so it
  // marks what the tiles happen to leave rather than anything that was planned.
  const contestantOnly = (e: MapEdge) =>
    e.width >= map.params.contestantRadius * 2 &&
    e.width < map.params.hunterRadius * 2;
  for (const e of map.edges.filter(contestantOnly)) {
    const a = center(map.tiles.find((t) => t.id === e.a)!),
      b = center(map.tiles.find((t) => t.id === e.b)!),
      x = (a.x + b.x) / 2,
      y = (a.y + b.y) / 2;
    line(
      { x: x - (a.x === b.x ? 0.75 : 0), y: y - (a.y === b.y ? 0.75 : 0) },
      { x: x + (a.x === b.x ? 0.75 : 0), y: y + (a.y === b.y ? 0.75 : 0) },
      "#76e6e9",
      0.2,
    );
  }
  if (!playing && input("routes").checked)
    routes.forEach((path, i) => {
      for (let j = 1; j < path.length; j++) {
        const a = center(map.tiles.find((t) => t.id === path[j - 1])!),
          b = center(map.tiles.find((t) => t.id === path[j])!);
        line(
          { x: a.x + i * 0.25, y: a.y + i * 0.25 },
          { x: b.x + i * 0.25, y: b.y + i * 0.25 },
          i ? "#ed919cbb" : "#cff78fcc",
          0.17,
        );
      }
    });
  for (const f of map.features) {
    const palette = {
      spawn: "#d3f995",
      exit: "#ffc36e",
      charger: "#9fa5ff",
      warp: "#e398eb",
      "hunter-spawn": "#f08a8c",
      "set-piece": "#b4d4df",
    };
    circle(
      f.x,
      f.y,
      f.kind === "set-piece" ? 0.35 : 0.65,
      palette[f.kind] || "#fff",
    );
    if (zoom > 5) {
      ctx.font = `${Math.max(0.8, 9 / zoom)}px Segoe UI`;
      ctx.fillStyle = "#e4edef";
      ctx.textAlign = "center";
      ctx.fillText(
        {
          spawn: "S",
          exit: "E",
          charger: "C",
          warp: "T",
          "hunter-spawn": "H",
          "set-piece": "◆",
        }[f.kind] || "?",
        f.x,
        f.y - 1,
      );
    }
  }
  if (selected) {
    ctx.strokeStyle = "#ecf9ff";
    ctx.lineWidth = 0.18;
    ctx.strokeRect(selected.x + 0.2, selected.y + 0.2, 5.6, 5.6);
  }
  if (playing && run) {
    for (const item of run.loot)
      if (!item.taken) circle(item.x, item.y, 0.22, "#ffd37f");
    for (const b of run.bullets) circle(b.x, b.y, 0.13, "#fff0bf");
    for (const h of run.hunters)
      if (h.respawn <= 0) circle(h.x, h.y, map.params.hunterRadius, "#ed7988");
    circle(run.x, run.y, run.radius, "#d6ff9f");
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 0.07;
    ctx.stroke();
    const aim = world(mouse),
      a = Math.atan2(aim.y - run.y, aim.x - run.x);
    line(
      run,
      { x: run.x + Math.cos(a) * 1.2, y: run.y + Math.sin(a) * 1.2 },
      "#fff",
      0.15,
    );
  }
  ctx.restore();
}
function move(
  actor: { x: number; y: number },
  dx: number,
  dy: number,
  radius: number,
): void {
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 0.15));
  for (let i = 0; i < steps; i++) {
    if (canOccupy(map, actor.x + dx / steps, actor.y, radius))
      actor.x += dx / steps;
    if (canOccupy(map, actor.x, actor.y + dy / steps, radius))
      actor.y += dy / steps;
  }
}
function stop(message = "Ready for a run."): void {
  playing = false;
  keys.clear();
  $("play").textContent = "Start escape run";
  $("gameStatus").textContent = message;
}
function start() {
  if (!map) return;
  if (playing) {
    stop("Run ended.");
    fit();
    return;
  }
  const spawn = map.features.find((f) => f.kind === "spawn")!,
    body = select("body").value;
  const hs = map.features.find((f) => f.kind === "hunter-spawn")!;
  run = {
    x: spawn.x,
    y: spawn.y,
    radius:
      body === "hunter" ? map.params.hunterRadius : map.params.contestantRadius,
    body,
    health: 100,
    score: 0,
    charge: 0,
    time: 0,
    shootCd: 0,
    hitCd: 0,
    warpCd: 0,
    bullets: [],
    loot: map.grid.cells.spawns.map((slot) => ({
      x: (slot.cell % map.grid.width) + 0.5,
      y: Math.floor(slot.cell / map.grid.width) + 0.5,
      taken: false,
    })),
    hunters: [0, 1].map((_, i) => ({
      x: hs.x,
      y: hs.y,
      respawn: i * 3,
      path: [],
      repath: 0,
    })),
  };
  playing = true;
  $("play").textContent = "End run";
  $("mapTab").click();
  zoom = Math.max(9, Math.min(18, canvas.clientWidth / 55));
}
function update(dt: number): void {
  if (!playing || !run) return;
  const self = run;
  self.time += dt;
  self.shootCd -= dt;
  self.hitCd -= dt;
  self.warpCd -= dt;
  let dx =
      Number(keys.has("d") || keys.has("arrowright")) -
      Number(keys.has("a") || keys.has("arrowleft")),
    dy =
      Number(keys.has("s") || keys.has("arrowdown")) -
      Number(keys.has("w") || keys.has("arrowup"));
  const l = Math.hypot(dx, dy);
  if (l)
    move(
      self,
      (dx / l) * dt * (self.body === "hunter" ? 4.5 : 5),
      (dy / l) * dt * (self.body === "hunter" ? 4.5 : 5),
      self.radius,
    );
  for (const item of self.loot)
    if (!item.taken && Math.hypot(item.x - self.x, item.y - self.y) < 1) {
      item.taken = true;
      self.score++;
    }
  const charger = map.features.find(
    (f) => f.kind === "charger" && Math.hypot(f.x - self.x, f.y - self.y) < 2,
  );
  if (keys.has("e") && charger && !l)
    self.charge = Math.min(5, self.charge + dt);
  const transit = map.features.find(
    (f) => f.kind === "warp" && Math.hypot(f.x - self.x, f.y - self.y) < 2,
  );
  if (keys.has("e") && transit && self.body === "hunter" && self.warpCd <= 0) {
    const others = map.features.filter(
        (f) => f.kind === "warp" && f.id !== transit.id,
      ),
      to = others[0];
    if (to) {
      self.x = to.x;
      self.y = to.y;
      self.warpCd = 3;
    }
  }
  for (const h of self.hunters) {
    if (h.respawn > 0) {
      h.respawn -= dt;
      continue;
    }
    h.repath -= dt;
    const ht = tileAt(h.x, h.y),
      pt = tileAt(self.x, self.y);
    if (h.repath <= 0 && ht && pt) {
      h.path = findPath(map, ht.id, pt.id, "hunter");
      h.repath = 1;
      h.target = null;
    }
    let target;
    if (ht && pt && ht.id === pt.id) target = self;
    else if (ht && h.path.length > 1) {
      const next = map.tiles.find((t) => t.id === h.path[1])!;
      const current = center(ht);
      if (!h.target)
        h.target =
          Math.hypot(h.x - current.x, h.y - current.y) > 0.2
            ? current
            : center(next);
      if (Math.hypot(h.x - h.target.x, h.y - h.target.y) < 0.18)
        h.target = center(next);
      target = h.target;
    }
    if (target) {
      const len = Math.hypot(target.x - h.x, target.y - h.y);
      if (len > 0.05)
        move(
          h,
          ((target.x - h.x) / len) * dt * 3.3,
          ((target.y - h.y) / len) * dt * 3.3,
          map.params.hunterRadius,
        );
    }
    if (
      Math.hypot(h.x - self.x, h.y - self.y) <
        self.radius + map.params.hunterRadius + 0.1 &&
      self.hitCd <= 0
    ) {
      self.health -= 20;
      self.hitCd = 1;
    }
  }
  for (const b of self.bullets) {
    const steps = Math.ceil((dt * 30) / 0.15);
    for (let i = 0; i < steps && b.life > 0; i++) {
      b.x += (b.dx * dt * 30) / steps;
      b.y += (b.dy * dt * 30) / steps;
      b.life -= dt / steps;
      if (!canOccupy(map, b.x, b.y, 0.05)) {
        b.life = 0;
        break;
      }
      for (const h of self.hunters)
        if (
          h.respawn <= 0 &&
          Math.hypot(h.x - b.x, h.y - b.y) < map.params.hunterRadius
        ) {
          h.respawn = 8;
          const hs = map.features.find((f) => f.kind === "hunter-spawn")!;
          h.x = hs.x;
          h.y = hs.y;
          b.life = 0;
          self.score += 3;
          break;
        }
    }
  }
  self.bullets = self.bullets.filter((b) => b.life > 0);
  pan = {
    x: canvas.clientWidth / 2 - self.x * zoom,
    y: canvas.clientHeight / 2 - self.y * zoom,
  };
  const exit = map.features.find(
    (f) => f.kind === "exit" && Math.hypot(f.x - self.x, f.y - self.y) < 1.5,
  );
  let hint = charger
    ? "Hold E while still to charge"
    : transit
      ? self.body === "hunter"
        ? "E: transit"
        : "Transit: hunters only"
      : exit
        ? "Charge at C before extracting"
        : "Find C, charge, then reach E";
  $("gameStatus").textContent =
    `Health ${self.health} · score ${self.score}\nCharge ${self.charge.toFixed(1)} / 5s · time ${self.time.toFixed(1)}s\n${hint}`;
  if (exit && self.charge >= 5) {
    stop(`ESCAPED · ${self.time.toFixed(1)}s · score ${self.score}`);
    fit();
  } else if (self.health <= 0) {
    stop(`Caught after ${self.time.toFixed(1)}s · score ${self.score}`);
    fit();
  }
}
function shoot() {
  if (!playing || !run || run.shootCd > 0) return;
  const self = run;
  const aim = world(mouse),
    a = Math.atan2(aim.y - self.y, aim.x - self.x);
  self.bullets.push({
    x: self.x,
    y: self.y,
    dx: Math.cos(a),
    dy: Math.sin(a),
    life: 2,
  });
  self.shootCd = 0.2;
}
canvas.addEventListener("pointerdown", (e) => {
  mouse = point(e);
  if (playing) {
    shoot();
    return;
  }
  dragging = { ...mouse, px: pan.x, py: pan.y };
  moved = false;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", (e) => {
  mouse = point(e);
  if (dragging) {
    const dx = mouse.x - dragging.x,
      dy = mouse.y - dragging.y;
    if (Math.hypot(dx, dy) > 3) moved = true;
    pan = { x: dragging.px + dx, y: dragging.py + dy };
  }
});
canvas.addEventListener("pointerup", (e) => {
  if (!playing && !moved) {
    const p = world(point(e));
    inspect(tileAt(p.x, p.y));
  }
  dragging = null;
});
canvas.addEventListener("pointercancel", () => (dragging = null));
canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const p = point(e),
      w = world(p);
    zoom = Math.max(1, Math.min(40, zoom * Math.exp(-e.deltaY * 0.001)));
    pan = { x: p.x - w.x * zoom, y: p.y - w.y * zoom };
  },
  { passive: false },
);
window.addEventListener("keydown", (e) => {
  const target = e.target as HTMLElement | null;
  if (target && ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName))
    return;
  const k = e.key.toLowerCase();
  if (["arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(k))
    e.preventDefault();
  keys.add(k);
  if (k === "escape") {
    stop("Run ended.");
    fit();
  }
});
window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener("blur", () => keys.clear());
$("generate").onclick = build;
$("random").onclick = () => {
  input("seed").value =
    `exit-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
  build();
};
$("fit").onclick = fit;
$("play").onclick = start;
const exportName = (extension: string) =>
  `last-exit-${String(map.seed).replace(/[^a-z0-9-]/gi, "_")}.${extension}`;
// Both buttons write the same wire form; only the encoding differs.
$("export").onclick = () =>
  map &&
  download(exportName("json"), artifactToJson(map, 2), "application/json");
$("exportBson").onclick = () =>
  map &&
  download(
    exportName("bson"),
    artifactToBson(map) as unknown as BlobPart,
    "application/bson",
  );
function tab(activeId: "world" | "author" | "sets" | "layouts"): void {
  $("worldViewContainer").hidden = activeId !== "world";
  $("authorViewContainer").hidden = activeId !== "author";
  $("setsViewContainer").hidden = activeId !== "sets";
  $("layoutsViewContainer").hidden = activeId !== "layouts";

  $("mapTab").classList.toggle("active", activeId === "world");
  $("authorTab").classList.toggle("active", activeId === "author");
  $("setsTab").classList.toggle("active", activeId === "sets");
  $("layoutsTab").classList.toggle("active", activeId === "layouts");

  if (activeId !== "world" && playing) stop("Run ended for authoring.");

  if (activeId === "author") {
    renderLibraryMeta();
  } else if (activeId === "sets") {
    renderTileSetsList();
  } else if (activeId === "world") {
    resize();
  }
}
$("mapTab").onclick = () => tab("world");
$("authorTab").onclick = () => tab("author");
$("setsTab").onclick = () => tab("sets");
$("layoutsTab").onclick = () => tab("layouts");
// --- Tile Sets Editor ---
let activeTileSetId = "";

function renderTileSetsList() {
  const container = document.getElementById("tileSetsList");
  if (!container) return;
  container.innerHTML = "";
  if (!library.tileSets) library.tileSets = [];

  library.tileSets.forEach((set) => {
    const el = document.createElement("div");
    el.className = "tile-set-item";
    if (set.id === activeTileSetId) el.classList.add("active");
    el.textContent = set.id;
    el.onclick = () => {
      activeTileSetId = set.id;
      renderTileSetsList();
      renderTileSetEditor();
    };
    container.appendChild(el);
  });

  if (!activeTileSetId && library.tileSets.length > 0) {
    activeTileSetId = library.tileSets[0].id;
  }

  renderTileSetEditor();
}

let tileSetFilter = "";

function renderTileSetEditor() {
  const editor = document.getElementById("setsEditor");
  const empty = document.getElementById("setsEditorEmpty");
  if (!editor || !empty) return;

  const activeSet = library.tileSets?.find((s) => s.id === activeTileSetId);

  if (!activeSet) {
    editor.hidden = true;
    empty.hidden = false;
    return;
  }

  editor.hidden = false;
  empty.hidden = true;

  (document.getElementById("activeSetId") as HTMLInputElement).value =
    activeSet.id;

  const membersGallery = document.getElementById("setMembersGallery");
  const availableGallery = document.getElementById("setAvailableGallery");
  if (!membersGallery || !availableGallery) return;

  membersGallery.innerHTML = "";
  availableGallery.innerHTML = "";

  const inSet = new Set(activeSet.members);
  const filter = tileSetFilter.toLowerCase();
  const filterEl = document.getElementById(
    "setAvailableFilter",
  ) as HTMLInputElement;
  if (filterEl && filterEl.value !== tileSetFilter)
    filterEl.value = tileSetFilter;

  for (const t of library.tiles) {
    const isMember = inSet.has(t.id);

    if (!isMember && filter) {
      const searchStr = (
        t.id +
        " " +
        (t.labels || []).join(" ") +
        " " +
        (t.defaultCellClass || "")
      ).toLowerCase();
      if (!searchStr.includes(filter)) continue;
    }

    const card = document.createElement("button");
    card.type = "button";
    card.className = "tile-card";

    const name = document.createElement("span");
    name.textContent = t.id;
    card.append(tileThumbnail(t), name);

    if (isMember) {
      card.title = "Click to remove from set";
      card.onclick = () => {
        activeSet.members = activeSet.members.filter((id) => id !== t.id);
        apply(library);
        renderTileSetEditor();
      };
      membersGallery.appendChild(card);
    } else {
      card.title = "Click to add to set";
      card.onclick = () => {
        activeSet.members.push(t.id);
        apply(library);
        renderTileSetEditor();
      };
      availableGallery.appendChild(card);
    }
  }
}

document.getElementById("setAvailableFilter")!.oninput = (e) => {
  tileSetFilter = (e.target as HTMLInputElement).value;
  renderTileSetEditor();
};

document.getElementById("newTileSet")!.onclick = () => {
  if (!library.tileSets) library.tileSets = [];
  let id = "new-set";
  let suffix = 1;
  while (library.tileSets.some((s) => s.id === id)) {
    id = `new-set-${suffix++}`;
  }
  library.tileSets.push({ id, members: [] });
  activeTileSetId = id;
  apply(library);
  renderTileSetsList();
};

document.getElementById("saveTileSet")!.onclick = () => {
  const activeSet = library.tileSets?.find((s) => s.id === activeTileSetId);
  if (!activeSet) return;
  const newId = (
    document.getElementById("activeSetId") as HTMLInputElement
  ).value.trim();
  if (!newId || newId === activeSet.id) return;
  if (library.tileSets?.some((s) => s.id === newId)) {
    alert("A Tile Set with that ID already exists.");
    return;
  }
  activeSet.id = newId;
  activeTileSetId = newId;
  apply(library);
  renderTileSetsList();
};

document.getElementById("deleteTileSet")!.onclick = () => {
  if (!library.tileSets || !activeTileSetId) return;
  library.tileSets = library.tileSets.filter((s) => s.id !== activeTileSetId);
  activeTileSetId = "";
  apply(library);
  renderTileSetsList();
};

(window as any).renderTileSetsList = renderTileSetsList;

function syncLibrary() {
  const previous = select("template").value;
  select("template").replaceChildren(
    ...library.tiles.map((t) => new Option(t.id, t.id)),
  );
  if (library.tiles.some((t) => t.id === previous))
    select("template").value = previous;
  area("librarySource").value = JSON.stringify(library, null, 2);
  editTemplate();
}
// Cell painting. `paint` holds one entry per tile cell: null defers to the
// tile's default class, anything else is a cell class name. The marks in
// `cells` and their legend are an encoding detail, decoded on load and
// re-derived on save rather than authored by hand.
const TILE_CELLS = 6;
/** The reserved material class, and the mark that stands for it in `cells`. */
const SOLID = "solid";
const SOLID_MARK = "#";
const canBeSolid = (_col: number, _row: number) => true;
const classColor = (name: string) => `hsl(${hash(name) % 360} 32% 34%)`;
let paint: Array<string | null> = new Array(36).fill(null);
let brush: string | null = null;
let segmentValues: SegmentDeclaration[] = new Array(SEGMENT_COUNT).fill("any");
let selectedSegment = 0;
let segmentEdits = new Map<number, SegmentDeclaration>();
const invalidSegmentInputs = new Map<number, string>();

// The preview is one drawing surface for two kinds of primitive. What a
// pointer means is decided by the edit mode and the tool rather than by
// whichever node happens to sit under it: a segment is a few pixels wide
// between cells 36px apart, so hit testing is geometric and its catch radius
// widens to half a cell as soon as cells stop competing for the same pointer.
// The nodes stay for drawing and labelling only.
type EditMode = "both" | "cells" | "segments";
type Tool = "paint" | "rect" | "fill";
const EDIT_MODES: Array<[EditMode, string, string]> = [
  [
    "both",
    "Cells + segments",
    "Cells take the class brush; a click within a quarter cell of a grid line takes the segment brush instead.",
  ],
  ["cells", "Cells", "Only cells respond. Grid lines stay visible but inert."],
  [
    "segments",
    "Segments",
    "Only segments respond, and the nearest line within half a cell wins, so thin strips need no precision.",
  ],
];
const TOOLS: Array<[Tool, string, string]> = [
  ["paint", "Paint", "Click or drag to apply the active brush."],
  [
    "rect",
    "Rectangle",
    "Drag a box. Cells fill it; segments trace its outline, and a drag with no width lays one straight line.",
  ],
  ["fill", "Fill", "Flood the connected run matching whatever you clicked."],
];
let editMode: EditMode = "both";
let tool: Tool = "paint";
let segmentBrush: SegmentDeclaration = "wall";
let partialSpan: [number, number] = [0.25, 0.75];
let drawing: { tool: Tool; pointerId: number } | null = null;
let rectDrag: { x0: number; y0: number; x1: number; y1: number } | null = null;
const cellsLive = () => editMode !== "segments";
const segmentsLive = () => editMode !== "cells";
const paintFallback = () => select("defaultCellClass").value || "open";
const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

function readPaint(t: TileDesign): Array<string | null> {
  const next: Array<string | null> = new Array(36).fill(null);
  // The shared resolver includes shorthand, solid boundaries, and explicit
  // primitive cell overrides. The editor must show what generation will read.
  const resolved = tilePrimitives(t);
  for (let row = 0; row < TILE_CELLS; row++)
    for (let col = 0; col < TILE_CELLS; col++) {
      const resolvedClass = resolved.cells[row * TILE_CELLS + col]!.class;
      const mark = t.cells?.[row]?.[col] ?? ".";
      next[row * TILE_CELLS + col] =
        resolvedClass === t.defaultCellClass &&
        mark === "." &&
        t.primitives?.cells?.[`${col},${row}`]?.class === undefined
          ? null
          : resolvedClass === SOLID
            ? SOLID
            : resolvedClass;
    }
  return next;
}

/** Re-derive `cells` and `legend`, or drop both when nothing is painted. */
function writePaint(t: TileDesign): void {
  const used = [...new Set(paint.filter((v) => v && v !== SOLID))] as string[];
  if (!paint.some((v) => v !== null)) {
    delete t.cells;
    delete t.legend;
  } else {
    const pool = "abcdefghijklmnopqrstuvwxyz0123456789".split("");
    const mark = new Map<string, string>();
    for (const name of used) {
      const first = name[0]?.toLowerCase() ?? "";
      const key =
        pool.includes(first) && !mark.has(first)
          ? first
          : pool.find((c) => ![...mark.values()].includes(c))!;
      pool.splice(pool.indexOf(key), 1);
      mark.set(name, key);
    }
    t.cells = Array.from({ length: TILE_CELLS }, (_, row) =>
      Array.from({ length: TILE_CELLS }, (_, col) => {
        const value = paint[row * TILE_CELLS + col];
        return value === null
          ? "."
          : value === SOLID
            ? SOLID_MARK
            : mark.get(value)!;
      }).join(""),
    );
    const legend = Object.fromEntries([...mark].map(([name, k]) => [k, name]));
    if (Object.keys(legend).length) t.legend = legend;
    else delete t.legend;
  }
  // Painting is an explicit replacement for cell classes. Keep non-class
  // primitive metadata (such as a future height), but remove hidden class
  // overrides that would otherwise win over the freshly painted grid.
  for (const [address, meta] of Object.entries(t.primitives?.cells ?? {})) {
    delete meta.class;
    if (meta.height === undefined) delete t.primitives!.cells![address];
  }
  if (t.primitives?.cells && !Object.keys(t.primitives.cells).length)
    delete t.primitives.cells;
  if (t.primitives && !Object.keys(t.primitives).length) delete t.primitives;
}

/** The tile under edit including unsaved paint, as generation would read it. */
function draftTile(): TileDesign | null {
  const original = library.tiles.find(
    (tile) => tile.id === select("template").value,
  );
  if (!original) return null;
  const draft = structuredClone(original);
  draft.defaultCellClass = paintFallback();
  writePaint(draft);
  writeSegmentEdits(draft);
  return draft;
}

function renderPaint(fallback: string): void {
  const draft = draftTile();
  if (draft) {
    const primitives = tilePrimitives(draft);
    segmentValues = Array.from({ length: SEGMENT_COUNT }, (_, index) =>
      segmentDeclaration(primitives, index),
    );
  }
  const preview = $("tilePreview");
  preview.className = `mode-${editMode}`;
  preview.replaceChildren(
    ...paint.map((value, i) => {
      const col = i % TILE_CELLS,
        row = (i - col) / TILE_CELLS;
      const el = document.createElement("div");
      el.classList.add("tile-cell");
      if (value === SOLID) {
        el.classList.add("solid");
        el.title = `${col},${row} · solid`;
      } else {
        const name = value ?? fallback;
        el.style.background = classColor(name);
        el.title = `${col},${row} · ${name}${value ? "" : " (default)"}`;
      }
      if (brush === SOLID && !canBeSolid(col, row)) el.classList.add("locked");
      return el;
    }),
  );
  renderSegments();
  renderGutters();
  renderRectGhost();
}

/** One re-render of the preview and everything that describes its state. */
function refresh(): void {
  renderPaint(paintFallback());
  renderPalette();
  renderSegmentControls();
}

// --- Applying a brush ------------------------------------------------------

/** Paint one cell, refusing what the one-cell interior margin forbids. */
function setCell(index: number, value: string | null): boolean {
  const col = index % TILE_CELLS,
    row = (index - col) / TILE_CELLS;
  if (value === SOLID && !canBeSolid(col, row)) return false;
  paint[index] = value;
  return true;
}
/** Declare one segment. Interior lines against the boundary stay unavailable. */
function setSegment(index: number, value: SegmentDeclaration): boolean {
  invalidSegmentInputs.delete(index);
  segmentValues[index] = value;
  segmentEdits.set(index, value);
  return true;
}
const segmentBrushValue = (): SegmentDeclaration =>
  Array.isArray(segmentBrush)
    ? ([...partialSpan] as [number, number])
    : segmentBrush;

/** Apply the active brush to a set of primitives, reporting what was refused. */
function applyTo(hits: Hit[]): void {
  let refusedCells = 0,
    refusedSegments = 0;
  for (const hit of hits) {
    const ok =
      hit.kind === "cell"
        ? setCell(hit.index, brush)
        : setSegment(hit.index, segmentBrushValue());
    if (ok) continue;
    if (hit.kind === "cell") refusedCells++;
    else refusedSegments++;
  }
  if (refusedCells)
    $("libraryStatus").textContent = "Refused invalid cell placement.";
  else if (refusedSegments)
    $("libraryStatus").textContent = "Refused invalid segment edit.";
  const single = hits.length === 1 ? hits[0]! : null;
  if (single?.kind === "segment") selectedSegment = single.index;
  refresh();
}

/** Read what is already at a primitive, so a click can pick it up as a brush. */
function pickUp(hit: Hit): void {
  if (hit.kind === "cell") brush = paint[hit.index] ?? null;
  else {
    const value = segmentValues[hit.index]!;
    if (Array.isArray(value)) {
      partialSpan = [value[0], value[1]];
      segmentBrush = [value[0], value[1]];
    } else segmentBrush = value;
    selectedSegment = hit.index;
  }
  refresh();
}

// --- Hit testing -----------------------------------------------------------

interface Hit {
  kind: "cell" | "segment";
  index: number;
}
/** Preview-local coordinates in cell units, where 0..6 spans the tile. */
function localPoint(
  clientX: number,
  clientY: number,
): { u: number; v: number } {
  const rect = $("tilePreview").getBoundingClientRect();
  return {
    u: ((clientX - rect.left) / rect.width) * TILE_CELLS,
    v: ((clientY - rect.top) / rect.height) * TILE_CELLS,
  };
}
function hitTest(clientX: number, clientY: number): Hit | null {
  const { u, v } = localPoint(clientX, clientY);
  if (segmentsLive()) {
    const vLine = clamp(Math.round(u), 0, TILE_CELLS),
      hLine = clamp(Math.round(v), 0, TILE_CELLS);
    const dv = Math.abs(u - vLine),
      dh = Math.abs(v - hLine);
    // Half a cell catches everything when only segments are live; a quarter
    // leaves the middle of each cell to the class brush when both are.
    const catchRadius = cellsLive() ? 0.25 : 0.5;
    if (Math.min(dv, dh) <= catchRadius)
      return dv <= dh
        ? {
            kind: "segment",
            index: vSeg(vLine, clamp(Math.floor(v), 0, TILE_CELLS - 1)),
          }
        : {
            kind: "segment",
            index: hSeg(hLine, clamp(Math.floor(u), 0, TILE_CELLS - 1)),
          };
  }
  if (!cellsLive()) return null;
  if (u < 0 || v < 0 || u >= TILE_CELLS || v >= TILE_CELLS) return null;
  return { kind: "cell", index: cellAt(Math.floor(u), Math.floor(v)) };
}

// --- Tools -----------------------------------------------------------------

/** Every cell holding what the seed cell holds, reached orthogonally. */
function cellFlood(seed: number): Hit[] {
  const target = paint[seed] ?? null;
  const seen = new Set<number>([seed]);
  const queue = [seed];
  while (queue.length) {
    const at = queue.pop()!;
    const col = at % TILE_CELLS,
      row = (at - col) / TILE_CELLS;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nc = col + dx,
        nr = row + dy;
      if (nc < 0 || nr < 0 || nc >= TILE_CELLS || nr >= TILE_CELLS) continue;
      const next = cellAt(nc, nr);
      if (seen.has(next) || (paint[next] ?? null) !== target) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return [...seen].map((index) => ({ kind: "cell", index }) as Hit);
}
/** The run of like declarations along one grid line, through the seed. */
function segmentRun(seed: number): Hit[] {
  const { vertical, line, offset } = segmentPlace(seed);
  const wanted = declarationKind(segmentValues[seed]!);
  const at = (i: number) => (vertical ? vSeg(line, i) : hSeg(line, i));
  const out: number[] = [seed];
  for (
    let i = offset - 1;
    i >= 0 && declarationKind(segmentValues[at(i)]!) === wanted;
    i--
  )
    out.push(at(i));
  for (
    let i = offset + 1;
    i < TILE_CELLS && declarationKind(segmentValues[at(i)]!) === wanted;
    i++
  )
    out.push(at(i));
  return out.map((index) => ({ kind: "segment", index }) as Hit);
}
/** Cells inside a box, or the segments tracing its outline. */
function rectHits(box: {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}): Hit[] {
  const ax = Math.min(box.x0, box.x1),
    bx = Math.max(box.x0, box.x1),
    ay = Math.min(box.y0, box.y1),
    by = Math.max(box.y0, box.y1);
  if (editMode === "segments") {
    const out = new Set<number>();
    if (ax === bx && ay === by) return [];
    if (ax === bx) for (let r = ay; r < by; r++) out.add(vSeg(ax, r));
    else if (ay === by) for (let c = ax; c < bx; c++) out.add(hSeg(ay, c));
    else {
      for (let c = ax; c < bx; c++) {
        out.add(hSeg(ay, c));
        out.add(hSeg(by, c));
      }
      for (let r = ay; r < by; r++) {
        out.add(vSeg(ax, r));
        out.add(vSeg(bx, r));
      }
    }
    return [...out].map((index) => ({ kind: "segment", index }) as Hit);
  }
  const out: Hit[] = [];
  for (let r = ay; r < by; r++)
    for (let c = ax; c < bx; c++)
      out.push({ kind: "cell", index: cellAt(c, r) });
  return out;
}
/** Where a rectangle drag snaps: vertices for segments, cells for classes. */
function rectAnchor(
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const { u, v } = localPoint(clientX, clientY);
  if (editMode === "segments")
    return {
      x: clamp(Math.round(u), 0, TILE_CELLS),
      y: clamp(Math.round(v), 0, TILE_CELLS),
    };
  return {
    x: clamp(Math.floor(u), 0, TILE_CELLS - 1),
    y: clamp(Math.floor(v), 0, TILE_CELLS - 1),
  };
}
/** The box a cell drag covers: inclusive of both corner cells. */
function cellBox(box: { x0: number; y0: number; x1: number; y1: number }) {
  return {
    x0: Math.min(box.x0, box.x1),
    y0: Math.min(box.y0, box.y1),
    x1: Math.max(box.x0, box.x1) + 1,
    y1: Math.max(box.y0, box.y1) + 1,
  };
}

// --- Preview rendering -----------------------------------------------------

function renderRectGhost(): void {
  if (!rectDrag) return;
  const box = editMode === "segments" ? rectDrag : cellBox(rectDrag);
  const ax = Math.min(box.x0, box.x1),
    bx = Math.max(box.x0, box.x1),
    ay = Math.min(box.y0, box.y1),
    by = Math.max(box.y0, box.y1);
  const ghost = document.createElement("div");
  ghost.className = "rect-ghost";
  Object.assign(ghost.style, {
    left: `${(ax / TILE_CELLS) * 100}%`,
    top: `${(ay / TILE_CELLS) * 100}%`,
    width: `${((bx - ax) / TILE_CELLS) * 100}%`,
    height: `${((by - ay) / TILE_CELLS) * 100}%`,
    minWidth: "2px",
    minHeight: "2px",
  });
  $("tilePreview").append(ghost);
}

/** Row and column strips beside the preview: one click covers a whole line. */
function renderGutters(): void {
  const cols = $("gutterCols"),
    rows = $("gutterRows");
  const lines = editMode === "segments";
  const count = lines ? TILE_CELLS + 1 : TILE_CELLS;
  const make = (i: number, vertical: boolean) => {
    const el = document.createElement("button");
    el.type = "button";
    el.textContent = String(i);
    const along = `${(((lines ? i : i + 0.5) / TILE_CELLS) * 100).toFixed(4)}%`;
    Object.assign(
      el.style,
      vertical
        ? {
            left: along,
            top: "0",
            bottom: "0",
            width: "14px",
            transform: "translateX(-50%)",
          }
        : {
            top: along,
            left: "0",
            right: "0",
            height: "14px",
            transform: "translateY(-50%)",
          },
    );
    el.title = lines
      ? `Declare every segment on ${vertical ? "vertical" : "horizontal"} line ${i} with the segment brush`
      : `Paint ${vertical ? "column" : "row"} ${i} with the class brush`;
    el.onclick = () =>
      applyTo(
        Array.from({ length: TILE_CELLS }, (_, k) =>
          lines
            ? {
                kind: "segment" as const,
                index: vertical ? vSeg(i, k) : hSeg(i, k),
              }
            : {
                kind: "cell" as const,
                index: vertical ? cellAt(i, k) : cellAt(k, i),
              },
        ),
      );
    return el;
  };
  cols.replaceChildren(
    ...Array.from({ length: count }, (_, i) => make(i, true)),
  );
  rows.replaceChildren(
    ...Array.from({ length: count }, (_, i) => make(i, false)),
  );
}

function renderBrushes(fallback: string): void {
  const names = [
    ...new Set([...cellClassNames(library), fallback].filter(Boolean)),
  ].sort();
  const make = (label: string, value: string | null, swatch: string | null) => {
    const el = document.createElement("button");
    el.type = "button";
    el.textContent = label;
    el.classList.toggle("active", brush === value);
    if (swatch) {
      const dot = document.createElement("span");
      dot.className = "swatch";
      dot.style.background = swatch;
      el.prepend(dot);
    }
    el.onclick = () => {
      brush = value;
      refresh();
    };
    return el;
  };
  $("brushes").replaceChildren(
    make("default", null, null),
    ...names.map((name) =>
      make(name, name, name === SOLID ? "#0a1419" : classColor(name)),
    ),
  );
}

const SEGMENT_KINDS: Array<[string, string]> = [
  ["any", "defers to whatever the neighbour needs"],
  ["open", "states a clear crossing"],
  ["wall", "states a barrier"],
  ["partial", "states an aperture of the span below"],
];
function segmentSwatch(kind: string): string | null {
  if (kind === "open") return "#83d7a4";
  if (kind === "wall") return "#e2807f";
  if (kind === "partial") return "#e5bd6a";
  return null;
}
function renderSegmentBrushes(): void {
  const active = declarationKind(segmentBrush);
  $("segmentBrushes").replaceChildren(
    ...SEGMENT_KINDS.map(([kind, why]) => {
      const el = document.createElement("button");
      el.type = "button";
      el.textContent = kind;
      el.title = why;
      el.classList.toggle("active", active === kind);
      const dot = document.createElement("span");
      dot.className = kind === "any" ? "swatch any" : "swatch";
      const swatch = segmentSwatch(kind);
      if (swatch) dot.style.background = swatch;
      el.prepend(dot);
      el.onclick = () => {
        segmentBrush =
          kind === "partial"
            ? ([partialSpan[0], partialSpan[1]] as [number, number])
            : (kind as SegmentDeclaration);
        refresh();
      };
      return el;
    }),
  );
  ($("spanField") as HTMLElement).hidden = active !== "partial";
  const aperture = input("brushAperture");
  if (document.activeElement !== aperture)
    aperture.value = partialSpan.join("-");
  aperture.oninput = () => {
    const match = aperture.value
      .trim()
      .match(/^(\d*\.?\d+)\s*[-,]\s*(\d*\.?\d+)$/);
    const lo = Number(match?.[1]),
      hi = Number(match?.[2]);
    if (!match || lo < 0 || hi > 1 || lo >= hi) {
      $("libraryStatus").textContent =
        "Partial aperture needs two numbers from 0 to 1, with the first smaller.";
      return;
    }
    partialSpan = [lo, hi];
    segmentBrush = [lo, hi];
    $("libraryStatus").textContent = `Segment brush now opens ${lo}–${hi}.`;
  };
}

/** Whole-tile shapes, applied with whichever brush the mode makes active. */
interface Pattern {
  label: string;
  title: string;
  hits: () => Hit[];
}
const cellRange = (keep: (col: number, row: number) => boolean): Hit[] => {
  const out: Hit[] = [];
  for (let row = 0; row < TILE_CELLS; row++)
    for (let col = 0; col < TILE_CELLS; col++)
      if (keep(col, row)) out.push({ kind: "cell", index: cellAt(col, row) });
  return out;
};
const segmentRange = (keep: (index: number) => boolean): Hit[] =>
  Array.from({ length: SEGMENT_COUNT }, (_, index) => index)
    .filter((index) => keep(index))
    .map((index) => ({ kind: "segment", index }) as Hit);
const onPerimeter = (index: number) => {
  const { line } = segmentPlace(index);
  return line === 0 || line === TILE_CELLS;
};
const CELL_PATTERNS: Pattern[] = [
  { label: "Fill", title: "Every cell", hits: () => cellRange(() => true) },
  {
    label: "Border",
    title: "The outermost ring of cells",
    hits: () =>
      cellRange(
        (c, r) =>
          c === 0 || r === 0 || c === TILE_CELLS - 1 || r === TILE_CELLS - 1,
      ),
  },
  {
    label: "Interior",
    title: "The 4 × 4 block the interior margin leaves free",
    hits: () => cellRange((c, r) => c >= 1 && c <= 4 && r >= 1 && r <= 4),
  },
  {
    label: "Checker",
    title: "Alternating cells",
    hits: () => cellRange((c, r) => (c + r) % 2 === 0),
  },
  {
    label: "Columns",
    title: "Every other column",
    hits: () => cellRange((c) => c % 2 === 0),
  },
  {
    label: "Rows",
    title: "Every other row",
    hits: () => cellRange((_, r) => r % 2 === 0),
  },
];
const SEGMENT_PATTERNS: Pattern[] = [
  {
    label: "Perimeter",
    title: "All 24 seam segments",
    hits: () => segmentRange(onPerimeter),
  },
  {
    label: "Interior",
    title: "Every editable interior segment",
    hits: () => segmentRange((index) => !onPerimeter(index)),
  },
  {
    label: "Room",
    title: "The outline of the interior 4 × 4 block",
    hits: () =>
      segmentRange((index) => {
        const { line, offset } = segmentPlace(index);
        return (line === 1 || line === 5) && offset >= 1 && offset <= 4;
      }),
  },
];
function renderPatterns(): void {
  const buttons = [
    ...(cellsLive() ? CELL_PATTERNS : []),
    ...(segmentsLive() ? SEGMENT_PATTERNS : []),
  ].map((pattern) => {
    const el = document.createElement("button");
    el.type = "button";
    el.textContent = pattern.label;
    el.title = `${pattern.title} · takes the active brush`;
    el.onclick = () => applyTo(pattern.hits());
    return el;
  });
  if (segmentsLive()) {
    const reset = document.createElement("button");
    reset.type = "button";
    reset.textContent = "Defer all";
    reset.title = "Return every editable segment to any";
    reset.onclick = () => {
      for (let index = 0; index < SEGMENT_COUNT; index++)
        setSegment(index, "any");
      refresh();
    };
    buttons.push(reset);
  }
  $("patterns").replaceChildren(...buttons);
}

function renderModes(): void {
  const build = (
    host: HTMLElement,
    entries: Array<[string, string, string]>,
    current: string,
    choose: (value: string) => void,
  ) =>
    host.replaceChildren(
      ...entries.map(([value, label, why]) => {
        const el = document.createElement("button");
        el.type = "button";
        el.textContent = label;
        el.title = why;
        el.dataset.value = value;
        el.classList.toggle("active", value === current);
        el.onclick = () => {
          choose(value);
          refresh();
        };
        return el;
      }),
    );
  build($("editMode"), EDIT_MODES, editMode, (value) => {
    editMode = value as EditMode;
  });
  build($("editTool"), TOOLS, tool, (value) => {
    tool = value as Tool;
  });
  $("editHint").textContent =
    `${EDIT_MODES.find(([v]) => v === editMode)![2]} ${
      TOOLS.find(([v]) => v === tool)![2]
    } Right-click opens a palette at the cursor; Alt-click picks up what is already there. The numbered strips beside the preview cover a whole row, column or line.`;
}

function renderPalette(): void {
  renderModes();
  ($("cellPalette") as HTMLElement).hidden = !cellsLive();
  ($("segmentPalette") as HTMLElement).hidden = !segmentsLive();
  renderBrushes(paintFallback());
  renderSegmentBrushes();
  renderPatterns();
}

/** The declared classes, with the properties that are intrinsic to each. */
function renderClasses(): void {
  const declared = Object.entries(library.cellClasses ?? {}).sort(([a], [b]) =>
    a < b ? -1 : 1,
  );
  $("classList").replaceChildren(
    ...declared.map(([name, rule]) => {
      const row = document.createElement("div");
      row.className = "class-row";
      const dot = document.createElement("span");
      dot.className = "swatch";
      dot.style.background = classColor(name);
      const label = document.createElement("strong");
      label.textContent = name;
      const clutter = document.createElement("input");
      clutter.type = "number";
      clutter.min = "0";
      clutter.max = "1";
      clutter.step = "0.05";
      clutter.value = String(rule.clutterChance ?? 0);
      clutter.title = "Clutter chance";
      clutter.onchange = () => {
        const next = structuredClone(library);
        next.cellClasses![name] = {
          ...next.cellClasses![name],
          clutterChance: Number(clutter.value),
        };
        try {
          apply(next);
        } catch (e) {
          $("libraryStatus").textContent = (e as Error).message;
        }
      };
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove";
      remove.onclick = () => {
        const used = library.tiles.some(
          (t) =>
            t.defaultCellClass === name ||
            Object.values(t.legend ?? {}).includes(name),
        );
        if (used) {
          $("libraryStatus").textContent =
            `${name} is still painted by a tile, so it cannot be removed.`;
          return;
        }
        const next = structuredClone(library);
        delete next.cellClasses![name];
        try {
          apply(next);
        } catch (e) {
          $("libraryStatus").textContent = (e as Error).message;
        }
      };
      row.append(dot, label, clutter, remove);
      return row;
    }),
  );
}

// --- The gallery of tile previews -----------------------------------------

/** A small read-only picture of a tile, as generation resolves it. */
function tileThumbnail(t: TileDesign): HTMLElement {
  const primitives = tilePrimitives(t);
  const figure = document.createElement("figure");
  for (const cell of primitives.cells) {
    const el = document.createElement("i");
    el.style.background =
      cell.class === SOLID ? "#0a1419" : classColor(cell.class);
    figure.append(el);
  }
  // Only stated barriers are drawn: an unstated segment carries no geometry.
  for (const [index, value] of primitives.segments) {
    if (value === "any" || value === "open") continue;
    const { vertical, line, offset } = segmentPlace(index);
    const bar = document.createElement("b");
    if (Array.isArray(value)) bar.className = "partial";
    Object.assign(
      bar.style,
      vertical
        ? {
            left: `${(line / TILE_CELLS) * 100}%`,
            top: `${(offset / TILE_CELLS) * 100}%`,
            width: "3px",
            height: `${100 / TILE_CELLS}%`,
            transform: "translateX(-50%)",
          }
        : {
            left: `${(offset / TILE_CELLS) * 100}%`,
            top: `${(line / TILE_CELLS) * 100}%`,
            width: `${100 / TILE_CELLS}%`,
            height: "3px",
            transform: "translateY(-50%)",
          },
    );
    figure.append(bar);
  }
  return figure;
}
function renderGallery(): void {
  const filter = input("tileFilter").value.trim().toLowerCase();
  const shown = library.tiles.filter(
    (t) => !filter || t.id.toLowerCase().includes(filter),
  );
  if (!shown.length) {
    const empty = document.createElement("p");
    empty.className = "gallery-empty";
    empty.textContent = `No tile name contains "${filter}".`;
    $("tileGallery").replaceChildren(empty);
    return;
  }
  $("tileGallery").replaceChildren(
    ...shown.map((t) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "tile-card";
      card.dataset.tile = t.id;
      card.classList.toggle("active", t.id === select("template").value);
      card.classList.toggle("adapter", t.adapter === true);
      card.title = `${t.id} · default ${t.defaultCellClass}${t.adapter ? " · fallback adapter" : ""}`;
      const name = document.createElement("span");
      name.textContent = t.id;
      card.append(tileThumbnail(t), name);
      card.onclick = () => {
        select("template").value = t.id;
        editTemplate();
      };
      return card;
    }),
  );
}
input("tileFilter").oninput = () => renderGallery();

// --- Pointer handling on the preview ---------------------------------------

function paintAtPointer(e: PointerEvent): void {
  const hit = hitTest(e.clientX, e.clientY);
  if (!hit) return;
  if (e.altKey) {
    pickUp(hit);
    return;
  }
  if (tool === "fill")
    applyTo(hit.kind === "cell" ? cellFlood(hit.index) : segmentRun(hit.index));
  else applyTo([hit]);
}
$("tilePreview").addEventListener("pointerdown", (e) => {
  const event = e as PointerEvent;
  if (event.button !== 0) return;
  event.preventDefault();
  closePopup();
  drawing = { tool, pointerId: event.pointerId };
  if (tool === "rect" && !event.altKey) {
    const start = rectAnchor(event.clientX, event.clientY);
    rectDrag = { x0: start.x, y0: start.y, x1: start.x, y1: start.y };
    renderPaint(paintFallback());
  } else paintAtPointer(event);
});
$("tilePreview").addEventListener("pointermove", (e) => {
  const event = e as PointerEvent;
  const hit = hitTest(event.clientX, event.clientY);
  $("hoverReadout").textContent =
    hit?.kind === "segment"
      ? `segment ${segmentAddress(hit.index)} · ${describe(segmentValues[hit.index]!)}`
      : hit
        ? `cell ${hit.index % TILE_CELLS},${Math.floor(hit.index / TILE_CELLS)} · ${paint[hit.index] ?? `${paintFallback()} (default)`}`
        : "";
  if (!drawing) return;
  if (drawing.tool === "rect" && rectDrag) {
    const end = rectAnchor(event.clientX, event.clientY);
    rectDrag.x1 = end.x;
    rectDrag.y1 = end.y;
    renderPaint(paintFallback());
  } else if (drawing.tool === "paint") paintAtPointer(event);
});
const endDraw = () => {
  const box = rectDrag;
  rectDrag = null;
  if (drawing?.tool === "rect" && box) {
    const hits = rectHits(editMode === "segments" ? box : cellBox(box));
    if (hits.length) applyTo(hits);
    else refresh();
  }
  drawing = null;
};
$("tilePreview").addEventListener("pointerup", endDraw);
$("tilePreview").addEventListener("pointercancel", endDraw);
$("tilePreview").addEventListener("pointerleave", () => {
  $("hoverReadout").textContent = "";
});
$("authorCenter").addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const event = e as MouseEvent;
  openPopup(
    event.clientX,
    event.clientY,
    hitTest(event.clientX, event.clientY),
  );
});

// --- The palette that follows the cursor -----------------------------------

let popup: HTMLElement | null = null;
function closePopup(): void {
  popup?.remove();
  popup = null;
}
/**
 * A palette placed at the cursor, offering only what the primitive under it can
 * take. Choosing a value both sets the brush and applies it, so declaring a
 * wall is one gesture rather than a trip to a control below the fold.
 */
function openPopup(clientX: number, clientY: number, hit: Hit | null): void {
  closePopup();
  if (!hit) return;
  const host = document.createElement("div");
  host.className = "popup";
  host.id = "cursorPalette";
  const title = document.createElement("h4");
  const row = () => {
    const el = document.createElement("div");
    el.className = "row";
    host.append(el);
    return el;
  };
  const action = (
    parent: HTMLElement,
    label: string,
    run: () => void,
    swatch?: string | null,
    active = false,
  ) => {
    const el = document.createElement("button");
    el.type = "button";
    el.textContent = label;
    el.classList.toggle("active", active);
    if (swatch !== undefined) {
      const dot = document.createElement("span");
      dot.className = swatch === null ? "swatch any" : "swatch";
      if (swatch) dot.style.background = swatch;
      el.prepend(dot);
    }
    el.onclick = () => {
      run();
      closePopup();
    };
    parent.append(el);
  };
  if (hit.kind === "segment") {
    title.textContent = `Segment ${segmentAddress(hit.index)}`;
    host.append(title);
    const kinds = row();
    for (const [kind] of SEGMENT_KINDS)
      action(
        kinds,
        kind,
        () => {
          segmentBrush =
            kind === "partial"
              ? ([partialSpan[0], partialSpan[1]] as [number, number])
              : (kind as SegmentDeclaration);
          applyTo([hit]);
        },
        segmentSwatch(kind),
        declarationKind(segmentValues[hit.index]!) === kind,
      );
    host.append(document.createElement("hr"));
    const scope = row();
    action(scope, "Whole line", () => {
      const { vertical, line } = segmentPlace(hit.index);
      applyTo(
        Array.from({ length: TILE_CELLS }, (_, k) => ({
          kind: "segment" as const,
          index: vertical ? vSeg(line, k) : hSeg(line, k),
        })),
      );
    });
    action(scope, "Matching run", () => applyTo(segmentRun(hit.index)));
    action(scope, "Perimeter", () => applyTo(SEGMENT_PATTERNS[0]!.hits()));
  } else {
    const col = hit.index % TILE_CELLS,
      cellRow = (hit.index - col) / TILE_CELLS;
    title.textContent = `Cell ${col},${cellRow}`;
    host.append(title);
    const classes = row();
    const names = [
      ...new Set([...cellClassNames(library), paintFallback()].filter(Boolean)),
    ].sort();
    action(
      classes,
      "default",
      () => {
        brush = null;
        applyTo([hit]);
      },
      null,
      paint[hit.index] === null,
    );
    for (const name of names)
      action(
        classes,
        name,
        () => {
          brush = name;
          applyTo([hit]);
        },
        name === SOLID ? "#0a1419" : classColor(name),
        paint[hit.index] === name,
      );
    host.append(document.createElement("hr"));
    const scope = row();
    action(scope, "Fill row", () =>
      applyTo(
        Array.from({ length: TILE_CELLS }, (_, k) => ({
          kind: "cell" as const,
          index: cellAt(k, cellRow),
        })),
      ),
    );
    action(scope, "Fill column", () =>
      applyTo(
        Array.from({ length: TILE_CELLS }, (_, k) => ({
          kind: "cell" as const,
          index: cellAt(col, k),
        })),
      ),
    );
    action(scope, "Flood", () => applyTo(cellFlood(hit.index)));
  }
  document.body.append(host);
  const box = host.getBoundingClientRect();
  host.style.left = `${clamp(clientX + 8, 6, Math.max(6, innerWidth - box.width - 6))}px`;
  host.style.top = `${clamp(clientY + 8, 6, Math.max(6, innerHeight - box.height - 6))}px`;
  popup = host;
}
addEventListener("pointerdown", (e) => {
  if (popup && !popup.contains(e.target as Node)) closePopup();
});
addEventListener("keydown", (e) => {
  if (e.key === "Escape") closePopup();
});

$("clearPaint").onclick = () => {
  paint = new Array(36).fill(null);
  refresh();
};
$("addClass").onclick = () => {
  const name = input("newClass").value.trim();
  if (!name) return;
  if (name === SOLID || cellClassNames(library).includes(name)) {
    $("libraryStatus").textContent = `${name} is already a cell class.`;
    return;
  }
  try {
    const next = structuredClone(library);
    next.cellClasses = { ...next.cellClasses, [name]: {} };
    input("newClass").value = "";
    brush = name;
    apply(next);
  } catch (e) {
    $("libraryStatus").textContent = (e as Error).message;
  }
};
select("defaultCellClass").onchange = () => refresh();

const SIDES: Side[] = ["N", "E", "S", "W"];
function declarationKind(value: SegmentDeclaration): string {
  return Array.isArray(value) ? "partial" : value;
}
function describe(value: SegmentDeclaration): string {
  return Array.isArray(value) ? `open ${value[0]}–${value[1]}` : value;
}
function segmentAddress(index: number): string {
  const { vertical, line, offset } = segmentPlace(index);
  return `${vertical ? "v" : "h"}:${line},${offset}`;
}

function renderSegments(): void {
  const preview = $("tilePreview");
  // A strip is only as wide as it needs to be to read. The pointer is resolved
  // geometrically against the grid, so the node takes no pointer events and
  // its width is never what makes a segment easy or hard to hit.
  const thickness = editMode === "segments" ? "9px" : "7px";
  for (let index = 0; index < SEGMENT_COUNT; index++) {
    const { vertical, line, offset } = segmentPlace(index);
    const value = segmentValues[index]!;
    const button = document.createElement("button");
    button.type = "button";
    button.tabIndex = -1;
    button.className = `tile-segment ${declarationKind(value)}${selectedSegment === index ? " selected" : ""}`;
    button.setAttribute("aria-label", `Segment ${segmentAddress(index)}`);
    button.title = `${segmentAddress(index)} · ${describe(value)}`;
    Object.assign(
      button.style,
      vertical
        ? {
            left: `${(line / 6) * 100}%`,
            top: `${(offset / 6) * 100}%`,
            width: thickness,
            height: `${100 / 6}%`,
            transform: "translateX(-50%)",
          }
        : {
            left: `${(offset / 6) * 100}%`,
            top: `${(line / 6) * 100}%`,
            width: `${100 / 6}%`,
            height: thickness,
            transform: "translateY(-50%)",
          },
    );
    if (Array.isArray(value)) {
      button.style.background = `linear-gradient(to ${vertical ? "bottom" : "right"}, #e2807f ${value[0] * 100}%, #83d7a4 ${value[0] * 100}%, #83d7a4 ${value[1] * 100}%, #e2807f ${value[1] * 100}%)`;
    }
    preview.append(button);
  }
}
function renderSegmentControls(): void {
  const value = segmentValues[selectedSegment]!;
  const controls = $("segmentControls");
  const address = document.createElement("strong");
  address.textContent = segmentAddress(selectedSegment);
  const kind = document.createElement("select");
  kind.id = "segmentKind";
  for (const option of ["any", "open", "wall", "partial"])
    kind.add(new Option(option, option));
  kind.value = declarationKind(value);
  kind.disabled = false;
  const aperture = document.createElement("input");
  aperture.id = "segmentAperture";
  aperture.value =
    invalidSegmentInputs.get(selectedSegment) ??
    (Array.isArray(value) ? value.join("-") : "");
  aperture.placeholder = "0.25-0.75";
  aperture.hidden = kind.value !== "partial";
  aperture.disabled = kind.disabled;
  kind.onchange = () => {
    setSegment(
      selectedSegment,
      kind.value === "partial"
        ? ([partialSpan[0], partialSpan[1]] as [number, number])
        : (kind.value as SegmentDeclaration),
    );
    refresh();
  };
  aperture.oninput = () => {
    const match = aperture.value
      .trim()
      .match(/^(\d*\.?\d+)\s*[-,]\s*(\d*\.?\d+)$/);
    const lo = Number(match?.[1]),
      hi = Number(match?.[2]);
    if (!match || lo < 0 || hi > 1 || lo >= hi) {
      invalidSegmentInputs.set(selectedSegment, aperture.value);
      $("libraryStatus").textContent =
        "Partial aperture needs two numbers from 0 to 1, with the first smaller.";
      return;
    }
    partialSpan = [lo, hi];
    setSegment(selectedSegment, [lo, hi]);
    renderPaint(paintFallback());
  };
  const kindLabel = document.createElement("label");
  kindLabel.textContent = "Kind";
  kindLabel.append(kind);
  const apertureLabel = document.createElement("label");
  apertureLabel.textContent = "Open span";
  apertureLabel.hidden = aperture.hidden;
  apertureLabel.append(aperture);
  controls.replaceChildren(address, kindLabel, apertureLabel);
}
function readSegments(t: TileDesign): void {
  const primitives = tilePrimitives(t);
  segmentValues = Array.from({ length: SEGMENT_COUNT }, (_, index) =>
    segmentDeclaration(primitives, index),
  );
  segmentEdits.clear();
  invalidSegmentInputs.clear();
  selectedSegment = 0;
}
function writeSegmentEdits(t: TileDesign): void {
  if (!segmentEdits.size) return;
  // Deferring is the absence of a declaration, not a declaration of "any". It
  // still has to be stored where it cancels one the shorthands, the authored
  // walls or a solid cell would otherwise derive, so the probe asks what this
  // tile would say with none of these edits applied.
  const probe = structuredClone(t);
  for (const index of segmentEdits.keys())
    delete probe.primitives?.segments?.[segmentAddress(index)];
  const derived = tilePrimitives(probe);
  for (const [index, value] of segmentEdits) {
    const address = segmentAddress(index);
    if (value === "any" && segmentDeclaration(derived, index) === "any") {
      if (t.primitives?.segments) delete t.primitives.segments[address];
      continue;
    }
    t.primitives ??= {};
    t.primitives.segments ??= {};
    t.primitives.segments[address] = value;
  }
  if (t.primitives?.segments && !Object.keys(t.primitives.segments).length)
    delete t.primitives.segments;
  if (t.primitives && !Object.keys(t.primitives).length) delete t.primitives;
}

function editTemplate(keepPaint = false) {
  const t = library.tiles.find((t) => t.id === select("template").value);
  if (!t) return;
  input("tileId").value = t.id;
  input("tileAdapter").checked = t.adapter === true;
  input("tileLabels").value = (t.labels || []).join(" ");
  const classes = cellClassNames(library)
    .filter((name) => name !== SOLID)
    .sort();
  select("defaultCellClass").replaceChildren(
    ...classes.map((name) => new Option(name, name)),
  );
  select("defaultCellClass").value = t.defaultCellClass;
  if (!keepPaint) paint = readPaint(t);
  $("ports").replaceChildren(
    ...SIDES.map((side) => {
      const label = document.createElement("label");
      label.textContent = side;
      const field = document.createElement("input");
      field.id = `port${side}`;
      field.title =
        "any, closed, door, wide, squeeze, or alternatives joined with |";
      const value = t.ports?.[side] ?? "any";
      field.value = Array.isArray(value) ? value.join("|") : value;
      label.append(field);
      return label;
    }),
  );
  renderClasses();
  readSegments(t);
  refresh();
  renderGallery();
  renderLibraryMeta();
}
function renderLibraryMeta(): void {
  const t = library.tiles.find((tile) => tile.id === select("template").value);
  if (!t) return;
  const placements =
    map?.tiles.filter((placed) => placed.templateId === t.id).length ?? 0;
  const fresh = libraryRevision === builtLibraryRevision;
  $("libraryMeta").textContent =
    `Active corpus: ${library.tiles.length} designs · source: ${libraryOrigin}. ${fresh ? `Last-built map uses ${placements} placement${placements === 1 ? "" : "s"} of this design.` : `Last-built map usage was ${placements}; this library changed and needs a rebuild.`} ${t.adapter ? "Fallback adapter: used only when authored designs cannot fit." : "Authored design: considered before fallback adapters."}`;
}
function apply(next: Library): void {
  const result = validateLibrary(next);
  if (!result.valid) throw Error(result.errors.join("\n"));
  library = next;
  libraryRevision++;
  libraryOrigin = "browser-edited library";
  syncLibrary();
  try {
    localStorage.setItem("last-exit-library-v1", JSON.stringify(library));
  } catch {}
  $("libraryStatus").textContent =
    "Library valid. Build a map to use these changes.";
}
select("template").onchange = () => editTemplate();
$("saveTemplate").onclick = () => {
  try {
    if (invalidSegmentInputs.size)
      throw Error(
        `Invalid partial aperture at ${[...invalidSegmentInputs.keys()].map(segmentAddress).join(", ")}. Use two numbers from 0 to 1, with the first smaller.`,
      );
    const next = structuredClone(library),
      current = select("template").value,
      t = next.tiles.find((t) => t.id === current);
    if (!t) return;
    const renamed = input("tileId").value.trim();
    if (!renamed) throw Error("A tile needs a name.");
    if (renamed !== t.id && next.tiles.some((x) => x.id === renamed))
      throw Error(`${renamed} is already the name of another tile.`);
    if (renamed !== t.id) {
      // Tile sets and layouts refer to tiles by id, so a rename has to carry.
      for (const set of next.tileSets)
        set.members = set.members.map((m) => (m === t.id ? renamed : m));
      t.id = renamed;
    }
    t.defaultCellClass = select("defaultCellClass").value;
    writePaint(t);
    writeSegmentEdits(t);
    const ports = {} as Record<Side, string | string[]>;
    for (const side of SIDES) {
      const value = input(`port${side}`).value.trim() || "any";
      ports[side] = value.includes("|")
        ? value
            .split("|")
            .map((v) => v.trim())
            .filter(Boolean)
        : value;
    }
    // A design that states nothing about its seams carries no ports at all.
    if (Object.values(ports).every((v) => v === "any")) delete t.ports;
    else t.ports = ports;
    const labels = input("tileLabels")
      .value.trim()
      .split(/\s+/)
      .filter(Boolean);
    if (labels.length) t.labels = labels;
    else delete t.labels;
    if (input("tileAdapter").checked) t.adapter = true;
    else delete t.adapter;
    apply(next);
    select("template").value = t.id;
    editTemplate();
  } catch (e) {
    $("libraryStatus").textContent = (e as Error).message;
  }
};
$("cloneTemplate").onclick = () => {
  try {
    const next = structuredClone(library),
      found = next.tiles.find((t) => t.id === select("template").value);
    if (!found) return;
    const t = structuredClone(found);
    let n = 1;
    const base = t.id;
    while (next.tiles.some((x) => x.id === `${base}-${n}`)) n++;
    t.id = `${base}-${n}`;
    next.tiles.push(t);
    apply(next);
    select("template").value = t.id;
    editTemplate();
    $("libraryStatus").textContent =
      "Duplicated. Available for general fill. Add its ID to a tile set to use it in layouts.";
  } catch (e) {
    $("libraryStatus").textContent = (e as Error).message;
  }
};
$("applyLibrary").onclick = () => {
  try {
    apply(JSON.parse(area("librarySource").value));
  } catch (e) {
    $("libraryStatus").textContent = (e as Error).message;
  }
};
$("downloadLibrary").onclick = () =>
  download(
    "last-exit-library.json",
    JSON.stringify(library, null, 2),
    "application/json",
  );
$("resetLibrary").onclick = () => {
  try {
    apply(structuredClone(DEFAULT_LIBRARY));
    libraryOrigin = "shipped library";
    renderLibraryMeta();
    localStorage.removeItem("last-exit-library-v1");
    $("libraryStatus").textContent =
      "Restored the shipped library. Build a map to use it.";
  } catch (e) {
    $("libraryStatus").textContent = (e as Error).message;
  }
};
$("importLibrary").onchange = async (e) => {
  try {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    apply(JSON.parse(await file.text()));
  } catch (err) {
    $("libraryStatus").textContent = (err as Error).message;
  }
};
declare global {
  interface Window {
    mapLab: { snapshot: () => unknown };
  }
}
window.mapLab = Object.freeze({
  snapshot: () => ({
    seed: map?.seed,
    valid: map?.validation.valid,
    playing,
    templateUsage: Object.fromEntries(
      [...new Set(map?.tiles.map((tile) => tile.templateId) ?? [])].map(
        (id) => [
          id,
          map?.tiles.filter((tile) => tile.templateId === id).length ?? 0,
        ],
      ),
    ),
    player: run
      ? {
          x: run.x,
          y: run.y,
          charge: run.charge,
          health: run.health,
          score: run.score,
        }
      : null,
  }),
});
try {
  const saved = JSON.parse(
    localStorage.getItem("last-exit-library-v1") ?? "null",
  );
  if (saved && validateLibrary(saved).valid) {
    library = saved;
    libraryOrigin = "browser saved library";
    libraryRevision = 1;
  }
} catch {}
syncLibrary();
build();
requestAnimationFrame(function frame(t) {
  update(Math.min(0.05, (t - last) / 1000 || 0));
  last = t;
  draw();
  requestAnimationFrame(frame);
});

// --- Layouts (Set Pieces) Editor ---

let activeLayoutId: string | null = null;
let activeLayoutBrush: string | null = null;

function renderLayoutsList() {
  const container = $("layoutsList");
  if (!container) return;
  container.innerHTML = "";
  if (!library.layouts) library.layouts = [];

  library.layouts.forEach((layout) => {
    const el = document.createElement("div");
    el.className = "tile-set-item";
    if (layout.id === activeLayoutId) el.classList.add("active");
    el.textContent = layout.id;
    el.onclick = () => {
      activeLayoutId = layout.id;
      renderLayoutsList();
      renderLayoutEditor();
    };
    container.append(el);
  });
}

$("newLayout").onclick = () => {
  if (!library.layouts) library.layouts = [];
  let id = "new-set-piece";
  let counter = 1;
  while (library.layouts.some((l) => l.id === id)) {
    id = `new-set-piece-${counter++}`;
  }
  library.layouts.push({
    id,
    classId: "set-piece",
    eligibleTiers: [0, 1, 2, 3, 4, 5],
    tiles: [],
  });
  activeLayoutId = id;

  renderLayoutsList();
  renderLayoutEditor();
};

function getLayoutPaletteItems(): string[] {
  const explicit = (library.tileSets || []).map((s) => s.id);
  const implicit = (library.tiles || [])
    .map((t) => t.id)
    .filter((id) => !explicit.includes(id));
  return [...explicit, ...implicit];
}

function renderLayoutPalette() {
  const container = $("layoutPaletteList");
  const filterInput = $("layoutPaletteFilter") as HTMLInputElement;
  const filter = filterInput.value.toLowerCase();

  container.innerHTML = "";
  const items = getLayoutPaletteItems();

  items.forEach((id) => {
    if (filter && !id.toLowerCase().includes(filter)) return;

    const el = document.createElement("div");
    el.className = "layout-palette-item";
    if (id === activeLayoutBrush) el.classList.add("active");
    el.textContent = id;
    el.style.borderLeft = `4px solid ${classColor(id)}`;

    // Check if it's explicit or implicit
    const isExplicit = (library.tileSets || []).some((s) => s.id === id);
    if (!isExplicit) {
      el.style.opacity = "0.7";
      el.title = "Implicit tile set (single tile)";
    }

    el.onclick = () => {
      activeLayoutBrush = id;
      renderLayoutPalette();
    };
    container.append(el);
  });
}

$("layoutPaletteFilter")?.addEventListener("input", renderLayoutPalette);

function renderLayoutEditor() {
  const layout = library.layouts?.find((l) => l.id === activeLayoutId);
  const editor = $("layoutsEditor");
  const empty = $("noLayoutSelected");

  if (!layout) {
    editor.style.display = "none";
    empty.style.display = "block";
    return;
  }
  editor.style.display = "flex";
  editor.style.flexDirection = "column";
  empty.style.display = "none";

  const idInput = $("activeLayoutId") as HTMLInputElement;
  const classInput = $("activeLayoutClass") as HTMLInputElement;

  idInput.value = layout.id;
  idInput.onchange = () => {
    const newId = idInput.value.trim();
    if (newId && !library.layouts.some((l) => l.id === newId && l !== layout)) {
      layout.id = newId;
      activeLayoutId = newId;

      renderLayoutsList();
    } else {
      idInput.value = layout.id;
    }
  };

  classInput.value = layout.classId || "set-piece";
  classInput.onchange = () => {
    layout.classId = classInput.value.trim() || "set-piece";
  };

  const checkboxes = $("activeLayoutTiers").querySelectorAll(
    "input[type=checkbox]",
  ) as NodeListOf<HTMLInputElement>;
  checkboxes.forEach((cb) => {
    const tier = parseInt(cb.value, 10);
    cb.checked = layout.eligibleTiers.includes(tier);
    cb.onchange = () => {
      if (cb.checked) {
        if (!layout.eligibleTiers.includes(tier))
          layout.eligibleTiers.push(tier);
      } else {
        layout.eligibleTiers = layout.eligibleTiers.filter((t) => t !== tier);
      }
      layout.eligibleTiers.sort((a, b) => a - b);
    };
  });

  renderLayoutPalette();

  const grid = $("layoutGrid");
  grid.innerHTML = "";

  // 11x11 grid from dx -5 to +5, dy -5 to +5
  const GRID_SIZE = 5;
  for (let dy = -GRID_SIZE; dy <= GRID_SIZE; dy++) {
    for (let dx = -GRID_SIZE; dx <= GRID_SIZE; dx++) {
      const cell = document.createElement("div");
      cell.className = "layout-cell";
      if (dx === 0 && dy === 0) cell.classList.add("origin");

      const slot = layout.tiles.find((t) => t.dx === dx && t.dy === dy);
      if (slot) {
        cell.classList.add("filled");
        cell.textContent = slot.tileSetId;
        cell.style.background = classColor(slot.tileSetId);
        cell.title = `${slot.tileSetId} at (${dx}, ${dy})`;
      } else {
        cell.title = `(${dx}, ${dy})`;
      }

      cell.onmousedown = (e) => {
        if (e.button === 0 && activeLayoutBrush) {
          // Left click: Paint
          if (slot) {
            slot.tileSetId = activeLayoutBrush;
          } else {
            layout.tiles.push({ dx, dy, tileSetId: activeLayoutBrush });
          }

          renderLayoutEditor();
        } else if (e.button === 2) {
          // Right click: Erase
          layout.tiles = layout.tiles.filter((t) => t !== slot);

          renderLayoutEditor();
        }
      };
      // Prevent context menu on right click to erase
      cell.oncontextmenu = (e) => e.preventDefault();

      grid.append(cell);
    }
  }
}

$("saveLayout").onclick = () => {
  try {
    apply(structuredClone(library));
    $("libraryStatus").textContent = "Set piece saved successfully.";
  } catch (e) {
    $("libraryStatus").textContent = (e as Error).message;
  }
};

$("deleteLayout").onclick = () => {
  if (!activeLayoutId) return;
  library.layouts = library.layouts.filter((l) => l.id !== activeLayoutId);
  activeLayoutId = null;

  renderLayoutsList();
  renderLayoutEditor();
};
