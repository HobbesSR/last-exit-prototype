/**
 * The Map Lab (53, "Tools"): maps from the generation chain (51), read through
 * `mapViews` (51.12), with the report beside the game's `diagnoseBuiltMap`. It generates, saves and
 * loads through the same core as the CLI and MCP, so all three agree on a map.
 */
import { CHAIN_LIBRARIES, bundledLibrary, chainParams, checkMap, validateLibrary } from "../core.ts";
import type { MapCheck, ToolMap } from "../core.ts";
import { GAME_ENGINES } from "../../engines.ts";
import { mapViews } from "../../macro/src/chain/map.ts";
import { DEFAULT_CHAIN_PARAMS } from "../../macro/src/chain/placement.ts";
import { chainMapToBson, chainMapToJson } from "../../macro/src/chain/saving.ts";
import type { ChainParams, PlacedSlot, SetPieceInstance } from "../../macro/src/chain/types.ts";
import type { RegionBrief } from "../../kernel/contract.ts";
import type { BrokenPromise } from "../../micro/diagnose.ts";
import { briefFragment } from "../../micro/brief-link.ts";
import type { RouteMeasure, RouteMethod } from "../routes.ts";
import { liveChainParams, liveSeed } from "../../live.ts";
import { builtMapFrame, builtPlayableArea } from "../../micro/adapter.ts";
import { MAX_ARENA_SEED } from "../../../shared/simulation/rules.ts";
import { chainDraft, renderChainLibrary } from "./chain-author.ts";
import { download } from "./download.ts";
import type { LabReply, LabRequest } from "./worker.ts";
import { PARTS, addElementParts, partPaths } from "./parts.ts";
import type { Part } from "./parts.ts";
import { renderPlaceables } from "./placeables.ts";
import { mountPlacementView } from "./placement-view.ts";
import type { ChainLibrary } from "../../macro/src/chain/library.ts";
import type { SkeletonAlgorithm } from "../../macro/src/chain/skeleton.ts";

import { colour, createLayers, css } from "./layers.ts";
import type { BuiltParts, Drill, Layer, Probe, Rgb, Rgba, Views } from "./layers.ts";
import { mountDiagnosticsResizer } from "./diagnostics-resizer.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);
const select = (id: string) => $<HTMLSelectElement>(id);
const canvas = $<HTMLCanvasElement>("map");
const ctx = canvas.getContext("2d")!;
type Context = CanvasRenderingContext2D;
/** Where a layer below full opacity is drawn before it is laid on the map. */
const scratch = document.createElement("canvas");
const scratchCtx = scratch.getContext("2d")!;

const NUMERIC = ["zoneWidth", "zoneHeight", "exitCount", "contestantCount", "hunterCount"] as const;

// ── State ───────────────────────────────────────────────────────────────────

let map: ToolMap | null = null;
let views: Views | null = null;
let check: MapCheck | null = null;
let diagnosis: { brokenPromises: BrokenPromise[]; ms: number } | null = null;
let lastMs = 0;
let error = "";
let busy = false;
let selected: { x: number; y: number } | null = null;
/** Per cell: the index of its region in `views.regions.regions`, or -1 outside the mask. */
let regionAt = new Int32Array(0);
let parts: BuiltParts | null = null;
/** Per tile slot, `col,row`: the placed design and the set piece instance holding it, if any. */
let slotAt = new Map<string, { slot: PlacedSlot; piece?: SetPieceInstance }>();
/** Per region id: its brief, and the region cell nearest its centre, where its brief is labelled. */
let briefOf = new Map<string, { brief: RegionBrief; anchor: { x: number; y: number } }>();
let camera = { zoom: 2, x: 0, y: 0 };
/** Until the viewer pans or zooms, the map is refitted whenever the canvas resizes. */
let fitted = true;
/** The zoom that fits the map, which the zoom readout calls 100%. */
let fitZoom = 1;
/**
 * The selected region, rebuilt with an observer (53 "Region drill-down"): its buildings'
 * traces, a `block`'s lots, and where the rebuild differs from the stored result, if it does.
 * Its links to the micro tools carry its brief.
 */
let drill: Drill | null = null;
/** What each drill-down and route layer last drew, for the browser test. */
let drawnTraces: Record<string, object> = {};
/** Why a room with the map's seed wouldn't play the map, from the worker (53 "Play in the game"). */
let live: string[] = [];
/** The game, where the micro tools are: the lab runs on the game's server, so it is at the root (20.5). */
const gameUrl = "";
/**
 * Contestant and hunter routes between two points of the built map (53 "Routes"), measured on
 * request in a worker. `from` and `to` name the panel's choices: a site, or the selected cell.
 */
let routes: { from: string; to: string; pending: boolean; measure: RouteMeasure | null; error: string; ms: number } | null = null;

// ── Workers ─────────────────────────────────────────────────────────────────

const WORKER_URL = new URL("./worker.ts", import.meta.url);
let mapWorker: Worker | null = null;
let diagnoseWorker: Worker | null = null;
let drillWorker: Worker | null = null;
let routesWorker: Worker | null = null;

/** One request on a worker of its own, so a newer request or a cancel can terminate it. */
function ask(previous: Worker | null, request: LabRequest, reply: (answer: LabReply) => void): Worker {
  previous?.terminate();
  const worker = new Worker(WORKER_URL, { type: "module" });
  worker.onmessage = (event: MessageEvent<LabReply>) => {
    worker.terminate();
    reply(event.data);
  };
  worker.onerror = (event) => {
    worker.terminate();
    reply({ kind: "error", message: event.message || "the worker failed to start" });
  };
  worker.postMessage(request);
  return worker;
}

// ── Recipe ──────────────────────────────────────────────────────────────────

/** The sizes libraries are authored for (55); any other is custom, for playground mode. */
const sizeKey = (width: unknown, height: unknown) => `${width}x${height}`;
for (const library of CHAIN_LIBRARIES) {
  const option = document.createElement("option");
  option.value = sizeKey(library.zoneWidth, library.zoneHeight);
  option.textContent = `${library.zoneWidth} × ${library.zoneHeight} (${library.name})`;
  select("zoneSize").append(option);
}
select("zoneSize").append(Object.assign(document.createElement("option"), { value: "custom", textContent: "Custom" }));

function showSize(): void {
  const key = sizeKey(input("zoneWidth").value, input("zoneHeight").value);
  select("zoneSize").value = CHAIN_LIBRARIES.some((l) => sizeKey(l.zoneWidth, l.zoneHeight) === key) ? key : "custom";
}

function fillParams(params: ChainParams): void {
  select("mode").value = params.mode ?? "game";
  for (const name of NUMERIC) input(name).value = String(params[name]);
  showSize();
}

function recipeParams(): ChainParams {
  const raw: Record<string, unknown> = { mode: select("mode").value };
  for (const name of NUMERIC) raw[name] = input(name).value === "" ? undefined : Number(input(name).value);
  // Loot isn't on the form, so it stays at the defaults.
  return chainParams(raw);
}

/** The library World and Placement both use: the chosen source, then the experimental skeleton (#883) if on. */
function chosenLibrary(): unknown {
  const skeleton = select("skeleton").value;
  // "Off" is stated, so it also clears a skeleton a Chain Library draft authored (review 721).
  const withSkeleton = ({ connectivitySkeleton: _, ...library }: ChainLibrary): ChainLibrary => skeleton === "off" ? library : { ...library,
    connectivitySkeleton: { algorithm: skeleton as SkeletonAlgorithm, extraOpenShare: Number(select("skeletonExtraOpen").value) || 0, shortcutPriority: true } };
  if (select("librarySource").value === "bundled") return withSkeleton(bundledLibrary(recipeParams()));
  const draft = chainDraft();
  const checked = validateLibrary(draft);
  if (!checked.valid) throw new Error(`the Chain Library tab's draft isn't valid for the game: ${checked.errors.join("; ")}`);
  return withSkeleton(draft as ChainLibrary);
}

let solveWorker: Worker | null = null;
const solveView = mountPlacementView($("solveView"), () => {
  try {
    const seed = input("seed").value, params = recipeParams(), library = chosenLibrary() as ChainLibrary;
    const skeletonAlgo = select("skeleton").value;
    solveView.pending(`Seed ${seed} · ${params.mode} · ${params.zoneWidth} × ${params.zoneHeight} · ${library.name} · source ${select("librarySource").value} · largest first${skeletonAlgo !== 'off' ? ` · skeleton ${skeletonAlgo} (+${Math.round((Number(select("skeletonExtraOpen").value) || 0) * 100)}% open)` : ''}`);
    solveWorker = ask(solveWorker, { kind: "placement", seed, params, library }, reply => {
      solveWorker = null;
      if (reply.kind === "placement") solveView.received(reply.recording, library, reply.ms);
      else solveView.stopped(reply.kind === "error" ? reply.message : 'Unexpected worker reply.');
    });
  } catch (error) { solveView.stopped(error instanceof Error ? error.message : String(error)); }
}, () => {
  solveWorker?.terminate(); solveWorker = null;
  solveView.stopped('Recording cancelled. Record placement to try again.');
});

for (const library of CHAIN_LIBRARIES) {
  select("solveSize").append(Object.assign(document.createElement("option"), {
    value: sizeKey(library.zoneWidth, library.zoneHeight), textContent: `${library.zoneWidth} × ${library.zoneHeight}`,
  }));
}
select("solveSize").append(Object.assign(document.createElement("option"), { value: "world", textContent: "Custom (set in World)", disabled: true }));
function syncPlacementControls(): void {
  input("solveSeed").value = input("seed").value;
  const key = sizeKey(input("zoneWidth").value, input("zoneHeight").value);
  select("solveSize").value = CHAIN_LIBRARIES.some(library => sizeKey(library.zoneWidth, library.zoneHeight) === key) ? key : "world";
}
// An older World result must not reset a recipe edited here while it was building.
function cancelStaleWorldGeneration(): void {
  if (!busy) return;
  mapWorker?.terminate(); mapWorker = null; busy = false;
  setStatus("Generation cancelled: recipe edited in Placement.");
}
input("solveSeed").oninput = () => {
  solveView.recipeEdited();
  cancelStaleWorldGeneration();
  input("seed").value = input("solveSeed").value;
};
input("solveSeed").onkeydown = event => { if (event.key === "Enter") $("solveRecord").click(); };
select("solveSize").onchange = () => {
  solveView.recipeEdited();
  cancelStaleWorldGeneration();
  select("zoneSize").value = select("solveSize").value;
  select("zoneSize").dispatchEvent(new Event("change"));
};
$("solveRandom").onclick = () => {
  solveView.recipeEdited();
  cancelStaleWorldGeneration();
  input("seed").value = `exit-${crypto.getRandomValues(new Uint32Array(1))[0]!.toString(36)}`;
  syncPlacementControls();
};

/** Set the recipe to a room's (53 "Play in the game"), with a room seed, and generate. */
function useRoomRecipe(): void {
  fillParams(liveChainParams());
  select("librarySource").value = "bundled";
  select("skeleton").value = "off";
  select("skeletonExtraOpen").disabled = true;
  if (liveSeed(input("seed").value) === null)
    input("seed").value = String(1 + (crypto.getRandomValues(new Uint32Array(1))[0]! % MAX_ARENA_SEED));
  generateMap();
}

/** Link to a new room on the game's dev server when this map is the one a room plays, or say why not. */
function renderPlay(): void {
  const link = $("playInGame") as HTMLAnchorElement;
  const reasons = map ? live : ["there is no map yet"];
  const playable = !reasons.length;
  link.hidden = !playable;
  if (playable) link.href = `${gameUrl}/?seed=${map!.layout.seed}&size=${sizeKey(map!.layout.params.zoneWidth, map!.layout.params.zoneHeight)}`;
  $("playNote").textContent = reasons.length
    ? `A room wouldn't play this map: ${reasons.join("; ")}.`
    : `Opens a new room with seed ${map!.layout.seed} at ${map!.layout.params.zoneWidth} × ${map!.layout.params.zoneHeight}.`;
}

function setStatus(text: string, bad = false): void {
  $("status").textContent = `World: ${text}`;
  $("status").style.color = bad ? "#f2b787" : "";
}

function generateMap(): void {
  let request: LabRequest;
  try {
    request = { kind: "generate", seed: input("seed").value, params: recipeParams(), library: chosenLibrary() };
  } catch (failure) {
    return fail(failure);
  }
  busy = true;
  setStatus(`Generating ${request.seed}…`);
  mapWorker = ask(mapWorker, request, received);
}

function received(reply: LabReply): void {
  busy = false;
  if (reply.kind === "error") return fail(new Error(reply.message));
  if (reply.kind !== "map") return;
  lastMs = reply.ms;
  live = reply.live;
  show(reply.map);
}

function fail(failure: unknown): void {
  busy = false;
  error = failure instanceof Error ? failure.message : String(failure);
  setStatus(error, true);
}

// ── A map, through its views ────────────────────────────────────────────────

function show(next: ToolMap): void {
  cancelDiagnosis();
  map = next;
  views = mapViews(map, GAME_ENGINES.compose);
  check = checkMap(map);
  diagnosis = null;
  error = "";
  selected = null;
  drillWorker?.terminate();
  drillWorker = null;
  drill = null;
  routesWorker?.terminate();
  routesWorker = null;
  routes = null;
  fillParams(map.layout.params);
  input("seed").value = map.layout.seed;
  const { width, height } = views.resolved;
  regionAt = new Int32Array(width * height).fill(-1);
  views.regions.regions.forEach((region, i) => {
    for (const cell of region.cells) regionAt[cell] = i;
  });
  parts = buildParts(views);
  slotAt = new Map(map.layout.slots.map((slot) => [`${slot.col},${slot.row}`, { slot }]));
  for (const piece of map.layout.setPieces)
    for (const { col, row } of piece.slots) slotAt.get(`${col},${row}`)!.piece = piece;
  briefOf = new Map(views.briefs.map((brief) => [brief.id, { brief, anchor: centreCell(brief.cells) }]));
  repaint();
  fit();
  renderReport();
  renderDiagnosis();
  renderRouteChoices();
  renderRoutes();
  renderInspector();
  renderPlay();
  setStatus(`${map.layout.seed}: ${views.regions.regions.length} regions, ${check.valid ? "no defects" : `${check.defects.length} defects`}, generated in ${(lastMs / 1000).toFixed(2)} s`);
}

/** Rebuild the selected region in a worker, unless it's the one already drilled. */
function startDrill(): void {
  const region = views && selected ? probe(views, selected).region : undefined;
  if (region?.id === drill?.id) return;
  const hadDifference = !!drill?.difference;
  drillWorker?.terminate();
  drillWorker = null;
  drill = null;
  if (hadDifference) repaint("defects");
  const brief = region && briefOf.get(region.id)?.brief, stored = region && map?.results.find((result) => result.brief.id === region.id);
  if (!brief || !stored) return;
  const forMap = map;
  drill = { id: brief.id, type: brief.type, brief, pending: true, traces: [], lots: [], difference: null, error: "", fragment: null };
  drillWorker = ask(null, { kind: "drill", brief, stored }, async (reply) => {
    drillWorker = null;
    if (map !== forMap || drill?.id !== brief.id) return;
    if (reply.kind === "error") drill = { ...drill, pending: false, error: reply.message };
    else if (reply.kind === "drill") {
      drill = { ...drill, pending: false, traces: reply.traces, lots: reply.lots, difference: reply.difference };
      if (reply.difference) repaint("defects");
    }
    draw();
    renderInspector();
    // The links carry the brief, deflated, which is asynchronous; they appear when it's done.
    const at = drill, fragment = await briefFragment(brief);
    if (drill !== at) return;
    drill.fragment = fragment;
    renderInspector();
  });
  renderInspector();
}

const noParts = (): Record<Part, number> => Object.fromEntries(PARTS.map((part) => [part, 0])) as Record<Part, number>;

/** The built map's parts, each drawn by a layer of its own. */
function buildParts(v: Views): BuiltParts {
  const paths = partPaths(), count = noParts(), regions: BuiltParts["regions"] = new Map();
  const { cellSize } = v.built;
  for (const region of v.built.regions) {
    const own = { count: noParts(), labels: [] as string[] };
    regions.set(region.brief.id, own);
    for (const element of region.elements) {
      own.labels.push(element.label);
      addElementParts(element, cellSize, paths, (part) => {
        count[part]++;
        own.count[part]++;
      });
    }
  }
  return { paths, count, regions };
}

/** The cell nearest the cells' mean, so a label lands inside a region of any shape. */
function centreCell(cells: Array<{ x: number; y: number }>): { x: number; y: number } {
  const mx = cells.reduce((sum, c) => sum + c.x, 0) / cells.length, my = cells.reduce((sum, c) => sum + c.y, 0) / cells.length;
  let best = cells[0]!;
  for (const c of cells) if ((c.x - mx) ** 2 + (c.y - my) ** 2 < (best.x - mx) ** 2 + (best.y - my) ** 2) best = c;
  return best;
}

const LAYERS = createLayers({
  get map() { return map; },
  get views() { return views; },
  get check() { return check; },
  get diagnosis() { return diagnosis; },
  get drill() { return drill; },
  get routes() { return routes; },
  get parts() { return parts; },
  get slotAt() { return slotAt; },
  get briefOf() { return briefOf; },
  get regionAt() { return regionAt; },
  get drawnTraces() { return drawnTraces; },
  get gameUrl() { return gameUrl; },
});

/** A cell field, painted at one pixel per cell. */
function paintCells(layer: Layer, v: Views): NonNullable<Layer["painted"]> {
  const { width, height } = v.resolved;
  const result = document.createElement("canvas");
  result.width = width;
  result.height = height;
  const name = layer.cells!(v), image = new ImageData(width, height), seen = new Map<string, Rgb | Rgba>();
  for (let cell = 0; cell < width * height; cell++) {
    const value = name(cell);
    if (value === null) continue;
    let rgba = seen.get(value);
    if (!rgba) seen.set(value, (rgba = layer.colour?.(value) ?? colour(value)));
    image.data.set(rgba.length === 4 ? rgba : [...rgba, 255], cell * 4);
  }
  result.getContext("2d")!.putImageData(image, 0, 0);
  return { canvas: result, seen };
}

/** Forget painted cells, for a new map or a new diagnosis; they're painted again when drawn. */
function repaint(...ids: string[]): void {
  for (const layer of LAYERS) if (!ids.length || ids.includes(layer.id)) layer.painted = null;
  renderLegends();
}

function painted(layer: Layer): Layer["painted"] {
  if (!layer.cells || !views) return null;
  return (layer.painted ??= paintCells(layer, views));
}

/** The layer list, built once from the registry. */
function renderLayers(): void {
  $("layers").replaceChildren(...LAYERS.map((layer) => {
    const row = element("div", "", "layer");
    const toggle = element("label");
    const box = Object.assign(element("input"), { type: "checkbox", id: `layer-${layer.id}`, checked: layer.on });
    box.onchange = () => {
      layer.on = box.checked;
      renderLegends();
      draw();
    };
    toggle.append(box, ` ${layer.label}`, element("span", layer.stage, "stage"));
    const opacity = Object.assign(element("input"), {
      type: "range", id: `layer-${layer.id}-opacity`, min: "0", max: "100", value: String(layer.opacity * 100),
      title: `${layer.label} opacity`,
    });
    opacity.oninput = () => {
      layer.opacity = Number(opacity.value) / 100;
      draw();
    };
    row.append(toggle, opacity, Object.assign(element("div", "", "legend"), { id: `legend-${layer.id}` }));
    return row;
  }));
}

function renderLegends(): void {
  for (const layer of LAYERS) {
    const legend = $(`legend-${layer.id}`);
    if (!legend) continue;
    const entries = !layer.on || !views ? [] : layer.cells
      ? [...painted(layer)!.seen].map(([name, rgb]): [string, string] => [name, css(rgb as Rgb)])
      : layer.legend?.() ?? [];
    if (layer.summarise || entries.length > 40) {
      legend.textContent = entries.length ? `${entries.length} ${layer.summarise ?? "values"}, each its own colour.` : "";
      continue;
    }
    legend.replaceChildren(...entries.sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })).map(([name, swatch]) => {
      const item = element("span", name);
      item.style.setProperty("--swatch", swatch);
      return item;
    }));
  }
}

// ── Drawing ─────────────────────────────────────────────────────────────────

function draw(): void {
  const dpr = devicePixelRatio || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  $("zoomLevel").textContent = `${Math.round((camera.zoom / fitZoom) * 100)}%`;
  if (!views) return;
  const v = views, { zoom, x, y } = camera, px = 1 / zoom;
  drawnTraces = {};
  const transform = [dpr * zoom, 0, 0, dpr * zoom, dpr * x, dpr * y] as const;
  ctx.setTransform(...transform);
  ctx.imageSmoothingEnabled = false;
  /**
   * Every layer draws opaque on the same scratch canvas, then is laid on once at its
   * opacity. The same rasterization at 100% and 50% keeps thin geometry consistent;
   * overlapping parts of one layer (a site's fill and outline, say) don't fade by different
   * amounts.
   */
  const composite = (layer: Layer, paint: (g: Context) => void) => {
    if (scratch.width !== canvas.width || scratch.height !== canvas.height) [scratch.width, scratch.height] = [canvas.width, canvas.height];
    scratchCtx.setTransform(1, 0, 0, 1, 0, 0);
    scratchCtx.clearRect(0, 0, scratch.width, scratch.height);
    scratchCtx.setTransform(...transform);
    scratchCtx.imageSmoothingEnabled = false;
    paint(scratchCtx);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = layer.opacity;
    ctx.drawImage(scratch, 0, 0);
    ctx.globalAlpha = 1;
    ctx.setTransform(...transform);
  };
  const shown = LAYERS.filter((layer) => layer.on && layer.opacity > 0);
  for (const pass of ["areas", "marks"])
    for (const layer of shown)
      if (layer.pass === pass)
        composite(layer, (g) => {
          const cells = painted(layer);
          if (cells) g.drawImage(cells.canvas, 0, 0);
          layer.paint?.(g, v, px);
        });
  if (selected) {
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2 * px;
    ctx.strokeRect(selected.x, selected.y, 1, 1);
  }
}

function resize(): void {
  const dpr = devicePixelRatio || 1, box = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(box.width * dpr));
  canvas.height = Math.max(1, Math.round(box.height * dpr));
  if (fitted) fit();
  else draw();
}

function fit(): void {
  if (!views) return;
  const box = canvas.getBoundingClientRect(), { width, height } = views.resolved;
  const zoom = Math.max(0.1, Math.min(box.width / width, box.height / height) * 0.96);
  camera = { zoom, x: (box.width - width * zoom) / 2, y: (box.height - height * zoom) / 2 };
  fitZoom = zoom;
  fitted = true;
  draw();
}

/** Zoom by `factor` about a point on the canvas, in CSS pixels. */
function zoomAbout(factor: number, px: number, py: number): void {
  const zoom = Math.max(0.1, Math.min(80, camera.zoom * factor));
  camera = { zoom, x: px - ((px - camera.x) / camera.zoom) * zoom, y: py - ((py - camera.y) / camera.zoom) * zoom };
  fitted = false;
  draw();
}

function zoomCentre(factor: number): void {
  const box = canvas.getBoundingClientRect();
  zoomAbout(factor, box.width / 2, box.height / 2);
}

/** The cell under a pointer, or null off the map. */
function cellAt(event: { clientX: number; clientY: number }): { x: number; y: number } | null {
  if (!views) return null;
  const box = canvas.getBoundingClientRect();
  const x = Math.floor((event.clientX - box.left - camera.x) / camera.zoom);
  const y = Math.floor((event.clientY - box.top - camera.y) / camera.zoom);
  const { width, height } = views.resolved;
  return x >= 0 && y >= 0 && x < width && y < height ? { x, y } : null;
}

// ── Panels ──────────────────────────────────────────────────────────────────

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

function table(head: string[], rows: Array<Array<string | number>>, bad?: (row: Array<string | number>) => boolean): HTMLTableElement {
  const result = element("table"), header = element("tr");
  header.append(...head.map((name) => element("th", name)));
  result.append(header);
  for (const row of rows) {
    const line = element("tr", "", bad?.(row) ? "bad" : "");
    line.append(...row.map((value) => element("td", String(value))));
    result.append(line);
  }
  return result;
}

function renderReport(): void {
  const body = $("reportBody");
  if (!check || !views) return void (body.textContent = "—");
  const defects = element("ul");
  defects.append(...check.defects.map((defect) => element("li", `${defect.kind}: ${defect.message}`, "bad")));
  body.replaceChildren(
    element("p", check.valid ? "No defects found." : `${check.defects.length} defects found.`, check.valid ? "good" : "bad"),
    ...(check.defects.length ? [defects] : []),
    table(["Instance", "Core element", "Promised", "Found"],
      check.coreElements.map(({ instance, element: kind, promised, found }) => [instance, kind, promised, found]),
      (row) => row[2] !== row[3]),
    table(["Metric", "Value"], Object.entries(check.metrics).map(([name, value]) => [name, Number.isInteger(value) ? value : value.toFixed(3)])),
  );
}

let diagnosisStarted = 0;
let diagnosisTimer = 0;

function renderDiagnosis(): void {
  const body = $("diagnosticBody");
  $<HTMLButtonElement>("diagnose").disabled = !map || !!diagnoseWorker;
  $<HTMLButtonElement>("cancelDiagnose").disabled = !diagnoseWorker;
  if (diagnoseWorker) return void (body.textContent = `Running for ${((performance.now() - diagnosisStarted) / 1000).toFixed(0)} s…`);
  if (!diagnosis) return void (body.textContent = "Not run.");
  const seconds = (diagnosis.ms / 1000).toFixed(1);
  if (!diagnosis.brokenPromises.length)
    return void body.replaceChildren(element("p", `No broken promises in ${views!.built.regions.length} regions (${seconds} s).`, "good"));
  const list = element("ul");
  list.append(...diagnosis.brokenPromises.map(({ region, errors }) => element("li", `${region}: ${errors.join("; ")}`, "bad")));
  body.replaceChildren(element("p", `${diagnosis.brokenPromises.length} regions broke their promise (${seconds} s).`, "bad"), list);
}

function startDiagnosis(): void {
  if (!map || diagnoseWorker) return;
  diagnosisStarted = performance.now();
  const forMap = map;
  diagnoseWorker = ask(null, { kind: "diagnose", map: forMap }, (reply) => {
    diagnoseWorker = null;
    clearInterval(diagnosisTimer);
    if (map !== forMap) return;
    if (reply.kind === "diagnosis") {
      diagnosis = { brokenPromises: reply.brokenPromises, ms: reply.ms };
      repaint("defects");
      draw();
    } else if (reply.kind === "error") $("diagnosticBody").textContent = `The diagnostic failed: ${reply.message}`;
    renderDiagnosis();
    renderInspector();
  });
  diagnosisTimer = window.setInterval(renderDiagnosis, 1000);
  renderDiagnosis();
}

function cancelDiagnosis(): void {
  diagnoseWorker?.terminate();
  diagnoseWorker = null;
  clearInterval(diagnosisTimer);
  renderDiagnosis();
}

// ── Routes ──────────────────────────────────────────────────────────────────

const SELECTED_CELL = "selected";
/** The built map's core element sites, named by kind and number: "spawn 1", "exit 2". */
function routeSites(v: Views): Array<{ name: string; x: number; y: number }> {
  const seen = new Map<string, number>();
  return v.built.regions.flatMap((region) => region.coreElements).map((site) => {
    const n = (seen.get(site.kind) ?? 0) + 1;
    seen.set(site.kind, n);
    return { name: `${site.kind} ${n}`, x: site.x, y: site.y };
  });
}

/** A route end the panel names, in the built map's coordinates; null for an unselected cell. */
function routeEnd(v: Views, name: string): { x: number; y: number } | null {
  if (name !== SELECTED_CELL) return routeSites(v).find((site) => site.name === name) ?? null;
  if (!selected) return null;
  const { cellSize } = v.built;
  return { x: (selected.x + 0.5) * cellSize, y: (selected.y + 0.5) * cellSize };
}

/** The panel's choices for a new map: every site, or the selected cell; a spawn to an exit at first. */
function renderRouteChoices(): void {
  const names = views ? routeSites(views).map((site) => site.name) : [];
  for (const [id, first] of [["routeFrom", "spawn 1"], ["routeTo", "exit 1"]] as const) {
    select(id).replaceChildren(...[...names, SELECTED_CELL].map((name) =>
      Object.assign(element("option", name === SELECTED_CELL ? "the selected cell" : name), { value: name })));
    select(id).value = names.includes(first) ? first : SELECTED_CELL;
  }
}

function measureRoutes(): void {
  if (!views) return;
  const v = views, from = select("routeFrom").value, to = select("routeTo").value;
  const a = routeEnd(v, from), b = routeEnd(v, to);
  routesWorker?.terminate();
  routesWorker = null;
  if (!a || !b) {
    routes = { from, to, pending: false, measure: null, error: "Select a cell on the map first.", ms: 0 };
    return renderRoutes();
  }
  routes = { from, to, pending: true, measure: null, error: "", ms: 0 };
  const forMap = map, asked = routes;
  routesWorker = ask(null, { kind: "routes", built: v.built, from: a, to: b, method: select("routeMethod").value as RouteMethod }, (reply) => {
    routesWorker = null;
    if (map !== forMap || routes !== asked) return;
    routes = reply.kind === "routes" ? { ...asked, pending: false, measure: reply.measure, ms: reply.ms }
      : { ...asked, pending: false, error: reply.kind === "error" ? reply.message : "unexpected reply" };
    renderRoutes();
    draw();
  });
  renderRoutes();
  draw();
}

/** A route's line in the panel: its length, or plainly that there's none. */
function routeLine(name: string, route: RouteMeasure["contestant"], method: RouteMethod): HTMLElement {
  return route.length === null
    ? element("p", `${name} (clearance ${route.clearance}): no route measured (${route.status}).`, "bad")
    : element("p", `${name} (clearance ${route.clearance}): ${Math.round(route.length).toLocaleString("en")} world units on the ${method}, ${Math.round(route.walked!).toLocaleString("en")} walked`);
}

function renderRoutes(): void {
  renderLegends();
  const body = $("routesBody");
  $<HTMLButtonElement>("measureRoutes").disabled = !views;
  if (!routes) return void (body.textContent = "Not measured.");
  if (routes.pending) return void (body.textContent = "Measuring…");
  if (routes.error) return void body.replaceChildren(element("p", `Not measured: ${routes.error}`, "bad"));
  const { contestant, hunter, squeezes, ratio, method } = routes.measure!;
  body.replaceChildren(
    element("p", `${method === "grid" ? "Grid baseline" : "Mesh · full map knowledge"}: from ${routes.from} to ${routes.to} (${routes.ms.toFixed(0)} ms)`),
    routeLine("Contestant", contestant, method),
    routeLine("Hunter", hunter, method),
    ...(ratio !== null ? [element("p", `Hunter / contestant: ${ratio.toFixed(3)}`)] : []),
    ...(contestant.length !== null ? [element("p", method === "grid"
      ? `${squeezes.length} squeeze${squeezes.length === 1 ? "" : "s"} on the contestant's route, where a hunter can't pass`
      : `${squeezes.length} runs of hunter-blocked route legs (whole legs highlighted, not bottleneck extents)`)] : []),
  );
}

function probe(v: Views, at: { x: number; y: number }): Probe {
  const cell = at.y * v.resolved.width + at.x, region = v.regions.regions[regionAt[cell]!];
  return { ...at, cell, region, built: region && v.built.regions.find((result) => result.brief.id === region.id) };
}

/** Every layer's lines for a cell, in chain order. */
function inspection(at: { x: number; y: number } | null): string[] {
  if (!views || !at) return ["Select a cell."];
  const v = views, probed = probe(v, at);
  return [`Cell ${at.x}, ${at.y}`, ...LAYERS.flatMap((layer) => layer.inspect?.(v, probed) ?? [])];
}

function renderInspector(): void {
  $("inspector").textContent = inspection(selected).join("\n");
  const v = views, at = selected;
  const links = v && at ? LAYERS.flatMap((layer) => layer.links?.(v, probe(v, at)) ?? []) : [];
  $("inspectorLinks").replaceChildren(...links.map((link) => {
    if ("href" in link) return Object.assign(element("a", link.label, "full button"), { href: link.href, target: "_blank", rel: "noopener" });
    const button = Object.assign(element("button", link.label, "full"), { type: "button" });
    button.onclick = () => {
      link.open();
      if (link.chain) showTab("chain");
    };
    return button;
  }));
}

const tooltip = $("tooltip");

/** The inspector's first lines for the cell under the pointer. */
function showTooltip(event: PointerEvent): void {
  const at = cellAt(event);
  tooltip.hidden = !at;
  if (!at) return;
  tooltip.textContent = inspection(at).filter(Boolean).slice(0, 5).join("\n");
  const box = $("mapView").getBoundingClientRect();
  tooltip.style.left = `${event.clientX - box.left + 14}px`;
  tooltip.style.top = `${event.clientY - box.top + 14}px`;
}

// ── Saving and loading ──────────────────────────────────────────────────────

const saveName = (suffix: string) => `chain-${(map?.layout.seed ?? "map").replace(/[^a-z0-9-]/gi, "_")}${suffix}`;

$("saveJson").onclick = () => map && download(saveName(".json"), chainMapToJson(map), "application/json");
$("saveBson").onclick = () => map && download(saveName(".bson"), chainMapToBson(map), "application/octet-stream");
$("saveLayout").onclick = () => map && download(saveName("-layout.json"), chainMapToJson(map, { results: false }), "application/json");
input("load").onchange = async () => {
  const file = input("load").files?.[0];
  input("load").value = "";
  if (!file) return;
  busy = true;
  setStatus(`Reading ${file.name}…`);
  mapWorker = ask(mapWorker, { kind: "read", saved: new Uint8Array(await file.arrayBuffer()) }, received);
};

// ── Controls ────────────────────────────────────────────────────────────────

$("generate").onclick = generateMap;
/** The extra-open share (#883) applies only with a skeleton. */
select("skeleton").onchange = () => { select("skeletonExtraOpen").disabled = select("skeleton").value === "off"; };
select("zoneSize").onchange = () => {
  const library = CHAIN_LIBRARIES.find((l) => sizeKey(l.zoneWidth, l.zoneHeight) === select("zoneSize").value);
  if (!library) return;
  input("zoneWidth").value = String(library.zoneWidth);
  input("zoneHeight").value = String(library.zoneHeight);
};
input("zoneWidth").oninput = input("zoneHeight").oninput = showSize;
$("random").onclick = () => {
  input("seed").value = `exit-${crypto.getRandomValues(new Uint32Array(1))[0]!.toString(36)}`;
  generateMap();
};
// Keep the file/play menus dismissible without moving focus out of the workspace.
const actionMenus = document.querySelectorAll<HTMLDetailsElement>(".world-action-menu");
document.addEventListener("pointerdown", (event) => {
  for (const menu of actionMenus)
    if (!menu.contains(event.target as Node)) menu.open = false;
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  for (const menu of actionMenus) {
    if (!menu.open) continue;
    menu.open = false;
    menu.querySelector("summary")?.focus();
    event.preventDefault();
  }
});

$("zoomIn").onclick = () => zoomCentre(1.25);
$("zoomOut").onclick = () => zoomCentre(1 / 1.25);
$("zoomReset").onclick = fit;
$("diagnose").onclick = startDiagnosis;
$("cancelDiagnose").onclick = cancelDiagnosis;
$("measureRoutes").onclick = measureRoutes;
$("routeMethod").onchange = measureRoutes;
$("roomRecipe").onclick = useRoomRecipe;
renderLayers();
input("seed").onkeydown = (event) => {
  if (event.key === "Enter") generateMap();
};

type Tab = "world" | "chain" | "placeables" | "solve";
function showTab(tab: Tab): void {
  if (tab === "solve") syncPlacementControls();
  $("worldView").hidden = tab !== "world";
  $("solveView").hidden = tab !== "solve";
  $("solveTab").classList.toggle("active", tab === "solve");
  if (tab !== "solve") solveView.hide();
  $("chainViewContainer").hidden = tab !== "chain";
  $("placeablesView").hidden = tab !== "placeables";
  $("worldTab").classList.toggle("active", tab === "world");
  $("chainTab").classList.toggle("active", tab === "chain");
  $("placeablesTab").classList.toggle("active", tab === "placeables");
  if (tab === "chain") renderChainLibrary();
  else if (tab === "placeables") renderPlaceables($("placeablesView"));
  else if (tab === "world") resize();
}
$("solveTab").onclick = () => showTab("solve");
$("worldTab").onclick = () => showTab("world");
$("chainTab").onclick = () => showTab("chain");
$("placeablesTab").onclick = () => showTab("placeables");

let drag: { x: number; y: number; camera: typeof camera; moved: boolean } | null = null;
canvas.onpointerdown = (event) => {
  canvas.setPointerCapture(event.pointerId);
  drag = { x: event.clientX, y: event.clientY, camera: { ...camera }, moved: false };
};
canvas.onpointermove = (event) => {
  if (!drag) return showTooltip(event);
  const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
  if (!drag.moved) return;
  tooltip.hidden = true;
  camera = { ...drag.camera, x: drag.camera.x + dx, y: drag.camera.y + dy };
  fitted = false;
  draw();
};
canvas.onpointerup = (event) => {
  const click = drag && !drag.moved;
  drag = null;
  if (!click || !views) return;
  selected = cellAt(event);
  startDrill();
  renderInspector();
  draw();
};
canvas.onpointerleave = () => (tooltip.hidden = true);
canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  const box = canvas.getBoundingClientRect();
  zoomAbout(Math.exp(-event.deltaY * 0.0015), event.clientX - box.left, event.clientY - box.top);
}, { passive: false });
new ResizeObserver(resize).observe(canvas);

// ── For the browser test ────────────────────────────────────────────────────

declare global {
  interface Window {
    mapLab: { snapshot: () => unknown; select: (x: number, y: number) => void };
  }
}
window.mapLab = Object.freeze({
  snapshot: () => ({
    placement: solveView.snapshot(),
    busy,
    error,
    seed: map?.layout.seed ?? null,
    params: map ? { ...map.layout.params } : null,
    grid: views ? { width: views.resolved.width, height: views.resolved.height } : null,
    regions: views?.regions.regions.length ?? 0,
    portals: views?.regions.portals.length ?? 0,
    components: views?.proof.components.length ?? 0,
    briefs: views?.briefs.length ?? 0,
    builtRegions: views?.built.regions.length ?? 0,
    parts: parts ? { ...parts.count } : null,
    sites: views?.built.regions.reduce((sum, region) => sum + region.coreElements.length, 0) ?? 0,
    report: check ? { valid: check.valid, defects: check.defects.length, coreElements: check.coreElements } : null,
    diagnosing: !!diagnoseWorker,
    diagnosis: diagnosis ? { brokenPromises: diagnosis.brokenPromises } : null,
    inspector: $("inspector").textContent,
    layers: LAYERS.map(({ id, pass, stage, on, opacity }) => ({ id, pass, stage, on, opacity })),
    zoom: $("zoomLevel").textContent,
    selected,
    drill: drill && {
      id: drill.id, type: drill.type, pending: drill.pending, error: drill.error, difference: drill.difference,
      buildings: drill.traces.map((trace) => trace.label), lots: drill.lots.map((lot) => ({ id: lot.id, type: lot.type })),
      drawn: { ...drawnTraces }, fragment: drill.fragment,
    },
    routes: routes && {
      from: routes.from, to: routes.to, pending: routes.pending, error: routes.error, method: routes.measure?.method ?? null,
      contestant: routes.measure && { length: routes.measure.contestant.length, points: routes.measure.contestant.points.length },
      hunter: routes.measure && { length: routes.measure.hunter.length, points: routes.measure.hunter.points.length },
      squeezes: routes.measure?.squeezes.length ?? null, ratio: routes.measure?.ratio ?? null,
      drawn: drawnTraces.routes ?? null, text: $("routesBody").textContent,
    },
    /** The built map's frame, sites and playable mask in the game's world coordinates, as a room places them. */
    world: views && (() => {
      const { width, height, origin } = builtMapFrame(views.built);
      const sites = views.built.regions.flatMap((region) => region.coreElements.map(({ kind, x, y }) => ({ kind, x: x + origin.x, y: y + origin.y })));
      return { width, height, sites, playableArea: builtPlayableArea(views.built, origin) };
    })(),
    play: { href: ($("playInGame") as HTMLAnchorElement).hidden ? null : ($("playInGame") as HTMLAnchorElement).href, note: $("playNote").textContent },
    links: [...$("inspectorLinks").children].map((link) => ({ label: link.textContent, href: (link as HTMLAnchorElement).href || null })),
  }),
  /** Select a cell, as a click on it does. */
  select: (x: number, y: number) => {
    selected = { x, y };
    startDrill();
    renderInspector();
    draw();
  },
});

renderInspector();
renderPlay();

fillParams(DEFAULT_CHAIN_PARAMS);
generateMap();

// ── Resizer ─────────────────────────────────────────────────────────────────

mountDiagnosticsResizer($("diagnosticsResizer"), $("diagnosticsPane"), document.querySelector(".world-main")!);
