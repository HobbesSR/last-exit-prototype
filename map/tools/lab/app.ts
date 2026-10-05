/**
 * The Map Lab (53, "Tools"): chain maps, read through `mapViews` (51 "What the finished
 * map is"), with the report beside the game's `diagnoseBuiltMap`. It generates, saves and
 * loads through the same core as the CLI and MCP, so all three agree on a map.
 */
import { CHAIN_LIBRARIES, bundledLibrary, chainParams, checkMap, validateLibrary } from "../core.ts";
import type { MapCheck, ToolMap } from "../core.ts";
import { GAME_ENGINES } from "../engines.ts";
import { mapViews } from "../../macro/src/chain/map.ts";
import type { MapViews } from "../../macro/src/chain/map.ts";
import { CHAIN_TILE_SIZE } from "../../macro/src/chain/library.ts";
import { DEFAULT_CHAIN_PARAMS } from "../../macro/src/chain/placement.ts";
import { chainMapToBson, chainMapToJson } from "../../macro/src/chain/saving.ts";
import type { ChainParams, PlacedSlot, SetPieceInstance } from "../../macro/src/chain/types.ts";
import type { RegionBrief } from "../../kernel/contract.ts";
import type { BrokenPromise } from "../../micro/diagnose.ts";
import { elementShapes } from "../../micro/geometry.ts";
import type { RegionElement } from "../../micro/types.ts";
import { briefFragment } from "../../micro/brief-link.ts";
import { drawAllocation, drawDesignGraph, drawOpenings, drawSpans, guidanceNotMet, traceSummary } from "../../micro/building/draw.ts";
import type { BuildingTrace } from "../../micro/building/trace.ts";
import type { RouteMeasure } from "../routes.ts";
import { outline } from "../../../shared/shape.ts";
import type { ObstacleKind } from "../../../shared/types.ts";
import { chainDraft, openChainEntry, renderChainLibrary } from "./chain-author.ts";
import type { LabReply, LabRequest } from "./worker.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);
const select = (id: string) => $<HTMLSelectElement>(id);
const canvas = $<HTMLCanvasElement>("map");
const ctx = canvas.getContext("2d")!;
type Context = CanvasRenderingContext2D;
/** Where a layer below full opacity is drawn before it is laid on the map. */
const scratch = document.createElement("canvas");
const scratchCtx = scratch.getContext("2d")!;

type Views = MapViews<RegionElement>;
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
let drill: {
  id: string;
  type: string;
  brief: RegionBrief;
  pending: boolean;
  traces: BuildingTrace[];
  lots: RegionBrief[];
  difference: string | null;
  error: string;
  /** The brief as a link's fragment (`brief-link.ts`), once encoded. */
  fragment: string | null;
} | null = null;
/** What each drill-down and route layer last drew, for the browser test. */
let drawnTraces: Record<string, object> = {};
/** The game's dev server, where the micro tools are, when it runs in this worktree (20.5). */
let gameUrl: string | null = null;
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

function chosenLibrary(): unknown {
  if (select("librarySource").value === "bundled") return bundledLibrary(recipeParams());
  const draft = chainDraft();
  const checked = validateLibrary(draft);
  if (!checked.valid) throw new Error(`the Chain Library tab's draft isn't valid for the game: ${checked.errors.join("; ")}`);
  return draft;
}

function setStatus(text: string, bad = false): void {
  $("status").textContent = text;
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
  setStatus(`${map.layout.seed}: ${views.regions.regions.length} regions, ${check.valid ? "no defects" : `${check.defects.length} defects`}, generated in ${(lastMs / 1000).toFixed(2)} s`);
}

/** A steady colour for a name. */
function colour(name: string, saturation = 42, lightness = 40): Rgb {
  let hash = 2166136261;
  for (let i = 0; i < name.length; i++) hash = Math.imul(hash ^ name.charCodeAt(i), 16777619);
  return hsl(((hash >>> 0) % 360) / 360, saturation / 100, lightness / 100);
}

function hsl(h: number, s: number, l: number): Rgb {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const channel = (t: number) => {
    t = (t + 1) % 1;
    const v = t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
    return Math.round(v * 255);
  };
  return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)];
}

const css = ([r, g, b]: Rgb) => `rgb(${r} ${g} ${b})`;

/** Regions any defect or broken promise names. */
function defectRegions(): Set<string> {
  const named = new Set<string>();
  for (const defect of check?.defects ?? []) for (const id of defect.regions ?? []) named.add(id);
  for (const broken of diagnosis?.brokenPromises ?? []) named.add(broken.region);
  if (drill?.difference) named.add(drill.id);
  return named;
}

// ── Region drill-down ───────────────────────────────────────────────────────

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

/** Whether the drill-down may be drawn: the region rebuilt equal to the stored result, so its traces are the stored region's. */
function drillShown(): boolean {
  return !!drill && !drill.pending && !drill.difference && !drill.error;
}

function drilled(): BuildingTrace[] {
  return drillShown() ? drill!.traces : [];
}

/** A trace layer: drawn in world units, through the drawing the micro lab uses (`building/draw.ts`). */
function traceLayer(id: string, label: string, pass: Layer["pass"], on: boolean,
  drawTraces: (g: Context, traces: BuildingTrace[], px: number) => object): Layer {
  return {
    id, pass, label, stage: "results", on, opacity: 1,
    paint: (g, v, px) => {
      const traces = drilled();
      if (!traces.length) return;
      const { cellSize } = v.built;
      g.save();
      g.scale(1 / cellSize, 1 / cellSize);
      drawnTraces[id] = drawTraces(g, traces, px * cellSize);
      g.restore();
    },
  };
}

/** The outline of a set of cells, where a cell meets one not in the set. */
function cellOutline(cells: Array<{ x: number; y: number }>): Path2D {
  const own = new Set(cells.map(({ x, y }) => `${x},${y}`)), edge = new Path2D();
  const side = (x0: number, y0: number, x1: number, y1: number) => {
    edge.moveTo(x0, y0);
    edge.lineTo(x1, y1);
  };
  for (const { x, y } of cells) {
    if (!own.has(`${x},${y - 1}`)) side(x, y, x + 1, y);
    if (!own.has(`${x},${y + 1}`)) side(x, y + 1, x + 1, y + 1);
    if (!own.has(`${x - 1},${y}`)) side(x, y, x, y + 1);
    if (!own.has(`${x + 1},${y}`)) side(x + 1, y, x + 1, y + 1);
  }
  return edge;
}

/** The built map's parts, by what they are, each drawn by a layer of its own. */
type Part = "walls" | "ruins" | "cover" | "windows" | "doors" | "roofs";
const PARTS: Part[] = ["walls", "ruins", "cover", "windows", "doors", "roofs"];
/** Every obstacle kind's part, so a new kind can't be drawn as nothing. */
const OBSTACLE_PART: Record<ObstacleKind, Part> = {
  building: "walls", "ruin-wall": "ruins", container: "cover", crate: "cover", window: "windows",
};

interface BuiltParts {
  /** Each part's shapes, in cell units. */
  paths: Record<Part, Path2D>;
  count: Record<Part, number>;
  /** Per region id: its part counts, and its elements' labels. */
  regions: Map<string, { count: Record<Part, number>; labels: string[] }>;
}

const noParts = (): Record<Part, number> => Object.fromEntries(PARTS.map((part) => [part, 0])) as Record<Part, number>;

/**
 * The built map's colliders and gates (`elementShapes`) and roofs (an enclosing element's
 * footprint), sorted into parts. `elementShapes` gives one shape per obstacle or gate part,
 * in part order, so each shape takes the part it came from.
 */
function buildParts(v: Views): BuiltParts {
  const paths = Object.fromEntries(PARTS.map((part) => [part, new Path2D()])) as Record<Part, Path2D>;
  const count = noParts(), regions: BuiltParts["regions"] = new Map();
  const { cellSize } = v.built;
  for (const region of v.built.regions) {
    const own = { count: noParts(), labels: [] as string[] };
    regions.set(region.brief.id, own);
    const add = (part: Part) => {
      count[part]++;
      own.count[part]++;
    };
    for (const element of region.elements) {
      own.labels.push(element.label);
      const drawn = element.template.parts.filter((part) => part.part === "obstacle" || part.part === "gate");
      elementShapes(element, true).forEach((shape, i) => {
        const source = drawn[i]!, part = source.part === "obstacle" ? OBSTACLE_PART[source.kind] : "doors";
        outline(shape).forEach((p, j) => (j ? paths[part].lineTo(p.x / cellSize, p.y / cellSize) : paths[part].moveTo(p.x / cellSize, p.y / cellSize)));
        paths[part].closePath();
        add(part);
      });
      if (element.template.encloses) {
        paths.roofs.rect(element.x / cellSize, element.y / cellSize, element.template.w / cellSize, element.template.h / cellSize);
        add("roofs");
      }
    }
  }
  return { paths, count, regions };
}

/** A region's elements by name, numbers folded: "12 compound-room-#, 1 hut-building". */
function elementNames(labels: string[]): string {
  const named = new Map<string, number>();
  for (const label of labels) {
    const name = label.replace(/\d+/g, "#");
    named.set(name, (named.get(name) ?? 0) + 1);
  }
  return [...named].map(([name, n]) => `${n} ${name}`).join(", ");
}

/** The cell nearest the cells' mean, so a label lands inside a region of any shape. */
function centreCell(cells: Array<{ x: number; y: number }>): { x: number; y: number } {
  const mx = cells.reduce((sum, c) => sum + c.x, 0) / cells.length, my = cells.reduce((sum, c) => sum + c.y, 0) / cells.length;
  let best = cells[0]!;
  for (const c of cells) if ((c.x - mx) ** 2 + (c.y - my) ** 2 < (best.x - mx) ** 2 + (best.y - my) ** 2) best = c;
  return best;
}

/** What a brief asks for, folded to one phrase: "2 spawn, 1 exit". */
function assigned(brief: RegionBrief): string {
  return Object.entries(brief.coreElements ?? {}).filter(([, n]) => n).map(([kind, n]) => `${n} ${kind}`).join(", ");
}

function zoneAt(v: Views, x: number, y: number): Views["zones"][number] | undefined {
  return v.zones.find(({ cells: b }) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1);
}

// ── Layers ──────────────────────────────────────────────────────────────────

type Rgb = [number, number, number];
type Rgba = [number, number, number, number];

/** The cell a layer reads for the inspector, with its region and that region's result. */
interface Probe {
  x: number;
  y: number;
  cell: number;
  region?: Views["regions"]["regions"][number];
  built?: Views["built"]["regions"][number];
}

/**
 * One layer of the map view (53 "Tools"). The registry is in chain order (51), and draws
 * in two passes: every areas layer, then every marks layer, so a later stage lies over an
 * earlier one and lines stay readable over areas. A layer belongs to one pass, so it is
 * laid on the map once, at its opacity.
 */
interface Layer {
  id: string;
  label: string;
  /** What it reads: the Layout itself, the stored region results, or a `mapViews` key. */
  stage: "layout" | "results" | keyof Views;
  on: boolean;
  /** 0–1, applied to everything the layer draws. */
  opacity: number;
  /** Areas (cell fields, fills) or marks (lines, dots). */
  pass: "areas" | "marks";
  /** A cell field, for an areas layer: each cell's name, or null where nothing is drawn. Painted once per map into a canvas. */
  cells?: (v: Views) => (cell: number) => string | null;
  /** The colour for a name the field gave; a steady colour per name otherwise. */
  colour?: (name: string) => Rgb | Rgba;
  /** Say how many values there are instead of listing them. */
  summarise?: string;
  /** What the layer draws besides its cells, in its pass. `px` is one screen pixel in cell units. */
  paint?: (g: Context, v: Views, px: number) => void;
  /** Legend entries, for a layer without cells. */
  legend?: () => Array<[string, string]>;
  /** The inspector's lines for a cell. */
  inspect?: (v: Views, at: Probe) => string[];
  /**
   * Buttons under the inspector for a cell, each opening something elsewhere: in this page,
   * switching to the Chain Library tab when `chain` says so, or at `href` in a new tab.
   */
  links?: (v: Views, at: Probe) => Link[];
  /** The layer's painted cells and legend, for the current map. */
  painted?: { canvas: HTMLCanvasElement; seen: Map<string, Rgb | Rgba> } | null;
}

type Link = { label: string; open: () => void; chain?: boolean } | { label: string; href: string };

const SITE_COLOURS: Record<string, string> = {
  spawn: "#7fd0ff", "hunter-spawn": "#ff7a6b", exit: "#c8f185", charger: "#ffd166", warp: "#c39bff",
};

function runLine(path: Path2D, run: { axis: "h" | "v"; x: number; y: number; length: number }): void {
  path.moveTo(run.x, run.y);
  path.lineTo(run.axis === "h" ? run.x + run.length : run.x, run.axis === "v" ? run.y + run.length : run.y);
}

function dot(g: Context, x: number, y: number, radius: number): void {
  g.beginPath();
  g.arc(x, y, radius, 0, Math.PI * 2);
}

/** Text on a dark backing, 11 screen pixels high, with its top left at (x, y) in cell units. */
function tag(g: Context, text: string, x: number, y: number, px: number, fill: string): void {
  const size = 11;
  g.font = `${size * px}px system-ui, sans-serif`;
  g.textBaseline = "top";
  const pad = 2 * px, width = g.measureText(text).width;
  g.fillStyle = "rgb(11 16 21 / 0.78)";
  g.fillRect(x, y, width + 2 * pad, size * px + 2 * pad);
  g.fillStyle = fill;
  g.fillText(text, x + pad, y + pad);
}

/** The slot holding a cell, with its set piece instance. */
const slotOf = (x: number, y: number) => slotAt.get(`${Math.floor(x / CHAIN_TILE_SIZE)},${Math.floor(y / CHAIN_TILE_SIZE)}`);
const TILE_LINE = "#dfe7ea";
const BRIEF_PORTAL = "#ffb35c";
const LOT_LINE = "#f4e285";
const pieceColour = (setPieceClass: string) => css(colour(setPieceClass, 75, 62));
/** Labels are drawn once a tile is this many screen pixels across. */
const LABEL_TILE_PX = 72;

/** A heat colour, blue to red, for the map's least to greatest zone loot chance. */
function heat(v: Views, chance: number): Rgb {
  const chances = v.zones.map((zone) => zone.lootChance), least = Math.min(...chances), span = Math.max(...chances) - least;
  const t = span ? (chance - least) / span : 0.5;
  return hsl(0.66 - 0.66 * t, 0.7, 0.3 + 0.15 * t);
}

/**
 * A region type's colour, from its place among the library's region types, so types stay
 * apart where hashed colours would crowd together, and keep their colour across maps.
 */
function typeColour(type: string): Rgb {
  const types = [...new Set(Object.values(map?.library.cellClasses ?? {}).map((entry) => entry.regionType))].sort();
  const i = types.indexOf(type);
  return i < 0 ? colour(type) : hsl((i * 0.618034) % 1, 0.6, i % 2 ? 0.36 : 0.5);
}

/** One part of the built map, filled in its colour. */
function partLayer(part: Part, label: string, fill: string, legend: string): Layer {
  return {
    id: part, pass: "areas", label, stage: "built", on: true, opacity: 1,
    legend: () => [[legend, fill]],
    paint: (g) => {
      if (!parts) return;
      g.fillStyle = fill;
      g.fill(parts.paths[part]);
    },
  };
}

const LAYERS: Layer[] = [
  {
    id: "layout", pass: "marks", label: "Layout: tiles and set pieces", stage: "layout", on: false, opacity: 1,
    legend: () => [["tile", TILE_LINE], ...[...new Set(map?.layout.setPieces.map((piece) => piece.setPieceClass))]
      .map((name): [string, string] => [`set piece, ${name}`, pieceColour(name)])],
    paint: (g, _, px) => {
      if (!map) return;
      const S = CHAIN_TILE_SIZE, labelled = S / px >= LABEL_TILE_PX;
      const tiles = new Path2D();
      for (const { col, row } of map.layout.slots) tiles.rect(col * S, row * S, S, S);
      g.strokeStyle = TILE_LINE;
      g.lineWidth = px;
      g.stroke(tiles);
      // A set piece instance is outlined where its slots meet a slot not its own.
      for (const piece of map.layout.setPieces) {
        const own = new Set(piece.slots.map(({ col, row }) => `${col},${row}`)), edge = new Path2D();
        const side = (x0: number, y0: number, x1: number, y1: number) => {
          edge.moveTo(x0, y0);
          edge.lineTo(x1, y1);
        };
        for (const { col, row } of piece.slots) {
          const [x0, y0, x1, y1] = [col * S, row * S, (col + 1) * S, (row + 1) * S];
          if (!own.has(`${col},${row - 1}`)) side(x0, y0, x1, y0);
          if (!own.has(`${col},${row + 1}`)) side(x0, y1, x1, y1);
          if (!own.has(`${col - 1},${row}`)) side(x0, y0, x0, y1);
          if (!own.has(`${col + 1},${row}`)) side(x1, y0, x1, y1);
        }
        g.strokeStyle = pieceColour(piece.setPieceClass);
        g.lineWidth = 3 * px;
        g.stroke(edge);
      }
      if (!labelled) return;
      for (const { col, row, design, orientation } of map.layout.slots) {
        g.save();
        g.beginPath();
        g.rect(col * S, row * S, S, S);
        g.clip();
        tag(g, `${design} ${orientation}°`, col * S + 3 * px, row * S + 3 * px, px, TILE_LINE);
        g.restore();
      }
      for (const piece of map.layout.setPieces) {
        const { col, row } = piece.slots.reduce((a, b) => (b.row < a.row || (b.row === a.row && b.col < a.col) ? b : a));
        tag(g, `${piece.setPiece} (${piece.setPieceClass})`, col * S + 3 * px, row * S + 20 * px, px, pieceColour(piece.setPieceClass));
      }
    },
    inspect: (_, { x, y }) => {
      const at = slotOf(x, y);
      if (!at) return [];
      const { slot, piece } = at;
      return [`Tile ${slot.design} at ${slot.orientation}°${piece ? `, in set piece ${piece.setPiece} (${piece.setPieceClass})` : ""}`];
    },
    links: (_, { x, y }) => {
      const at = slotOf(x, y), from = map;
      if (!at || !from) return [];
      const { slot, piece } = at;
      return [
        { label: `Edit tile design ${slot.design}`, open: () => openChainEntry(from.library, "tiles", slot.design), chain: true },
        ...(piece ? [{ label: `Edit set piece ${piece.setPiece}`, open: () => openChainEntry(from.library, "setPieces", piece.setPiece), chain: true }] : []),
      ];
    },
  },
  {
    id: "declared", pass: "areas", label: "Declared classes", stage: "declaredGrid", on: false, opacity: 1,
    cells: (v) => (cell) => v.declaredGrid.cells[cell] || null,
    colour: (name) => (name === "any" ? [70, 78, 84] : colour(name)),
    inspect: (v, { cell }) => [`Declared: ${v.declaredGrid.cells[cell] || "outside the mask"}`],
  },
  {
    id: "resolved", pass: "areas", label: "Resolved classes", stage: "resolved", on: false, opacity: 1,
    cells: (v) => (cell) => v.resolved.cells[cell] || null,
    inspect: (v, { cell }) => (v.resolved.cells[cell] ? [`Resolved: ${v.resolved.cells[cell]}`] : []),
  },
  {
    id: "regions", pass: "areas", label: "Regions", stage: "regions", on: true, opacity: 1, summarise: "regions",
    cells: (v) => (cell) => (regionAt[cell]! >= 0 ? v.regions.regions[regionAt[cell]!]!.id : null),
    inspect: (_, { region }) => (region ? ["", `Region ${region.id}`, `Class ${region.class}, ${region.cells.length} cells, seed ${region.seed}`] : []),
  },
  {
    id: "portals", pass: "marks", label: "Boundaries and portals", stage: "regions", on: true, opacity: 1,
    legend: () => [["boundary", "#0b1015"], ["portal", "#e9f7c4"]],
    paint: (g, v, px) => {
      const boundaries = new Path2D(), portals = new Path2D();
      for (const boundary of v.regions.boundaries) runLine(boundaries, boundary.run);
      for (const portal of v.regions.portals) runLine(portals, portal);
      g.lineCap = "butt";
      g.strokeStyle = "#0b1015";
      g.lineWidth = 1.5 * px;
      g.stroke(boundaries);
      g.strokeStyle = "#e9f7c4";
      g.lineWidth = Math.max(0.25, 3 * px);
      g.stroke(portals);
    },
  },
  {
    id: "proof", pass: "areas", label: "Proof components", stage: "proof", on: false, opacity: 1,
    cells: (v) => {
      const component = new Map<string, number>();
      v.proof.components.forEach((ids, i) => ids.forEach((id) => component.set(id, i)));
      return (cell) => (regionAt[cell]! >= 0 ? `component ${component.get(v.regions.regions[regionAt[cell]!]!.id)}` : null);
    },
    inspect: (v, { region }) => (region ? [`Proof component ${v.proof.components.findIndex((ids) => ids.includes(region.id))}`] : []),
  },
  {
    id: "zones", pass: "areas", label: "Zone tiers", stage: "zones", on: false, opacity: 1,
    cells: (v) => {
      const { width } = v.resolved;
      return (cell) => {
        if (!v.resolved.cells[cell]) return null;
        const zone = zoneAt(v, cell % width, Math.floor(cell / width));
        return zone ? `tier ${zone.tier}` : null;
      };
    },
    colour: (name) => hsl(0.33 - Number(name.slice(5)) * 0.07, 0.45, 0.22 + Number(name.slice(5)) * 0.06),
    inspect: (v, { x, y, cell }) => {
      const zone = v.resolved.cells[cell] ? zoneAt(v, x, y) : undefined;
      return zone ? [`Zone ${zone.id}: tier ${zone.tier}, bonus ${zone.bonus}`] : [];
    },
  },
  {
    id: "bonus", pass: "areas", label: "Zone bonus", stage: "zones", on: false, opacity: 1,
    cells: (v) => {
      const { width } = v.resolved;
      return (cell) => {
        if (!v.resolved.cells[cell]) return null;
        const zone = zoneAt(v, cell % width, Math.floor(cell / width));
        return zone ? `bonus ${zone.bonus}` : null;
      };
    },
    colour: (name) => hsl(0.8 - Number(name.slice(6)) * 0.06, 0.5, 0.22 + Number(name.slice(6)) * 0.12),
  },
  {
    id: "regionType", pass: "areas", label: "Region types", stage: "briefs", on: false, opacity: 1,
    cells: (v) => (cell) => (regionAt[cell]! >= 0 ? briefOf.get(v.regions.regions[regionAt[cell]!]!.id)?.brief.type ?? null : null),
    colour: typeColour,
  },
  {
    id: "lootChance", pass: "areas", label: "Loot chance", stage: "briefs", on: false, opacity: 1,
    cells: (v) => {
      const { width } = v.resolved, chance = new Map<number, number>();
      for (const brief of v.briefs)
        for (const zone of brief.zones) for (const { x, y } of zone.cells) chance.set(y * width + x, zone.lootChance);
      return (cell) => (chance.has(cell) ? `${Math.round(chance.get(cell)! * 100)}% loot` : null);
    },
    colour: (name) => heat(views!, Number.parseInt(name) / 100),
  },
  {
    id: "briefs", pass: "marks", label: "Briefs: portals and core elements", stage: "briefs", on: false, opacity: 1,
    legend: () => [["portal, as its region's brief states it", BRIEF_PORTAL], ["core elements assigned", "#ffd166"]],
    paint: (g, v, px) => {
      // Each region's portals are drawn a little inside it, so a shared portal shows both briefs'
      // statements. Portal ids are too long to label; the inspector lists them.
      const { width } = v.resolved, inset = Math.min(0.3, 4 * px), lines = new Path2D();
      v.regions.regions.forEach((region, own) => {
        for (const portal of briefOf.get(region.id)?.brief.portals ?? []) {
          // Cell (x, y) is the run's first cell on its far side (`run.ts`); the region is there or on the near side.
          const h = portal.axis === "h", inside = regionAt[portal.y * width + portal.x] === own ? inset : -inset;
          const [x, y] = h ? [portal.x, portal.y + inside] : [portal.x + inside, portal.y];
          lines.moveTo(x, y);
          lines.lineTo(h ? x + portal.length : x, h ? y : y + portal.length);
        }
      });
      g.lineCap = "butt";
      g.strokeStyle = BRIEF_PORTAL;
      g.lineWidth = Math.max(0.12, 2 * px);
      g.stroke(lines);
      for (const { brief, anchor } of briefOf.values()) {
        const text = assigned(brief);
        if (text) tag(g, text, anchor.x, anchor.y, px, "#ffd166");
      }
    },
    inspect: (_, { region }) => {
      const brief = region && briefOf.get(region.id)?.brief;
      if (!brief) return [];
      const chances = [...new Set(brief.zones.map((zone) => `${Math.round(zone.lootChance * 100)}%`))];
      return [
        `Brief: type ${brief.type}, ${brief.portals.length} portals${brief.portals.length ? ` (${brief.portals.map((portal) => portal.id).join(", ")})` : ""}`,
        `Assigned core elements: ${assigned(brief) || "none"}`,
        ...(brief.parameters ? [`Parameters: ${Object.entries(brief.parameters).map(([name, value]) => `${name} ${value}`).join(", ")}`] : []),
        `Loot chance ${chances.join(", ")}`,
      ];
    },
  },
  {
    id: "lots", pass: "marks", label: "Drill-down: block lots", stage: "results", on: true, opacity: 1,
    legend: () => [["lot, a block's child region", LOT_LINE]],
    paint: (g, _, px) => {
      if (!drill || !drillShown()) return;
      g.strokeStyle = LOT_LINE;
      g.lineWidth = 2 * px;
      g.setLineDash([6 * px, 4 * px]);
      for (const lot of drill.lots) g.stroke(cellOutline(lot.cells));
      g.setLineDash([]);
      // A lot is a rectangle (54 `block`); its label is clipped to it.
      for (const lot of drill.lots) {
        const xs = lot.cells.map((c) => c.x), ys = lot.cells.map((c) => c.y), x = Math.min(...xs), y = Math.min(...ys);
        g.save();
        g.beginPath();
        g.rect(x, y, Math.max(...xs) + 1 - x, Math.max(...ys) + 1 - y);
        g.clip();
        tag(g, `${lot.id.slice(drill.id.length + 1)} ${lot.type}`, x + 3 * px, y + 3 * px, px, LOT_LINE);
        g.restore();
      }
      drawnTraces.lots = { lots: drill.lots.length };
    },
    inspect: (_, { region }) => {
      if (!region || drill?.id !== region.id) return [];
      if (drill.pending) return ["", "Drill-down: rebuilding…"];
      if (drill.error) return ["", `Drill-down failed: ${drill.error}`];
      if (drill.difference) return ["", `Defect: rebuilt, the region differs from the stored result, at ${drill.difference}. Its traces aren't drawn.`];
      return [
        "",
        `Drill-down: rebuilt equal to the stored result; ${drill.traces.length} building${drill.traces.length === 1 ? "" : "s"} from designs${drill.lots.length ? `, ${drill.lots.length} lots` : ""}`,
        ...drill.traces.flatMap((trace) => [traceSummary(trace), ...guidanceNotMet(trace)]),
      ];
    },
    links: (_, { region }) => {
      if (!region || drill?.id !== region.id || drill.pending) return [];
      const { brief, fragment } = drill, file = `brief-${brief.id.replace(/[^a-z0-9-]/gi, "_")}.json`;
      return [
        ...(gameUrl && fragment ? [{ label: "Open in the micro lab", href: `${gameUrl}/micro-lab.html${fragment}` }] : []),
        ...(gameUrl && fragment && brief.type === "block" ? [{ label: "Open in the generation demo", href: `${gameUrl}/generation-demo.html${fragment}` }] : []),
        { label: "Save this region's brief", open: () => download(file, JSON.stringify(brief, null, 2), "application/json") },
      ];
    },
  },
  traceLayer("allocation", "Drill-down: spaces and allocation", "areas", true, drawAllocation),
  traceLayer("spans", "Drill-down: spans", "marks", false, drawSpans),
  traceLayer("openings", "Drill-down: openings", "marks", true, drawOpenings),
  traceLayer("graph", "Drill-down: design graph", "marks", false, drawDesignGraph),
  {
    ...partLayer("walls", "Building walls", "#c3ccc7", "building wall"),
    inspect: (_, { built }) => {
      if (!built) return [];
      const own = parts?.regions.get(built.brief.id);
      return [
        `${built.elements.length} elements, ${built.loot.length} loot`,
        ...(own ? [`Parts: ${PARTS.map((part) => `${own.count[part]} ${part}`).join(", ")}`, `Elements: ${elementNames(own.labels) || "none"}`] : []),
      ];
    },
  },
  partLayer("ruins", "Ruin walls and rubble", "#9b8a72", "ruin wall"),
  partLayer("cover", "Cover", "#6e9a72", "container or crate"),
  partLayer("windows", "Windows", "#6fc8ff", "window"),
  // Chain maps place every door closed and unlocked (micro's adapter), so one colour says it.
  partLayer("doors", "Doors", "#d66955", "door, closed"),
  { ...partLayer("roofs", "Roofs", "#7a4f74", "roof"), on: false, opacity: 0.6 },
  {
    id: "loot", pass: "marks", label: "Loot", stage: "built", on: false, opacity: 1,
    legend: () => [["loot", "#f2ca55"]],
    paint: (g, v, px) => {
      const { cellSize } = v.built;
      g.fillStyle = "#f2ca55";
      for (const region of v.built.regions)
        for (const loot of region.loot) {
          dot(g, loot.x / cellSize, loot.y / cellSize, Math.max(0.15, 2 * px));
          g.fill();
        }
    },
  },
  {
    id: "sites", pass: "marks", label: "Core element sites", stage: "built", on: true, opacity: 1,
    legend: () => Object.entries(SITE_COLOURS),
    paint: (g, v, px) => {
      const { cellSize } = v.built;
      for (const region of v.built.regions)
        for (const site of region.coreElements) {
          dot(g, site.x / cellSize, site.y / cellSize, Math.max(0.6, 5 * px));
          g.fillStyle = SITE_COLOURS[site.kind] ?? "#fff";
          g.fill();
          g.strokeStyle = "#0b1015";
          g.lineWidth = px;
          g.stroke();
        }
    },
    inspect: (_, { built }) => (built?.coreElements.length ? [`Core elements: ${built.coreElements.map((site) => site.kind).join(", ")}`] : []),
  },
  {
    id: "routes", pass: "marks", label: "Routes: contestant and hunter", stage: "built", on: true, opacity: 1,
    legend: () => [["contestant route", CONTESTANT_ROUTE], ["hunter route", HUNTER_ROUTE], ["squeeze, contestant only", SQUEEZE], ["no route", "#ff5a4a"]],
    paint: (g, v, px) => {
      const measure = routes?.measure;
      if (!measure) return;
      const { cellSize } = v.built, unit = px * cellSize;
      g.save();
      g.scale(1 / cellSize, 1 / cellSize);
      g.lineCap = g.lineJoin = "round";
      // The hunter's wider line goes under the contestant's, so both show where they share ground.
      for (const [route, colour, width] of [[measure.hunter, HUNTER_ROUTE, 7], [measure.contestant, CONTESTANT_ROUTE, 3]] as const) {
        if (!route.points.length) continue;
        g.strokeStyle = colour;
        g.lineWidth = width * unit;
        g.stroke(routePath(route.points));
      }
      // A body with no route gets a dashed line straight to the target, so it can't pass unseen.
      if (!measure.contestant.points.length || !measure.hunter.points.length) {
        g.strokeStyle = "#ff5a4a";
        g.lineWidth = 2 * unit;
        g.setLineDash([8 * unit, 6 * unit]);
        g.stroke(routePath([measure.from, measure.to]));
        g.setLineDash([]);
      }
      g.strokeStyle = SQUEEZE;
      for (const run of measure.squeezes) {
        g.lineWidth = 4 * unit;
        g.stroke(routePath(run));
        dot(g, run[0]!.x, run[0]!.y, 9 * unit);
        g.lineWidth = 2 * unit;
        g.stroke();
      }
      for (const end of [measure.from, measure.to]) {
        dot(g, end.x, end.y, 7 * unit);
        g.strokeStyle = "#ffffff";
        g.lineWidth = 2 * unit;
        g.stroke();
      }
      g.restore();
      drawnTraces.routes = { contestant: measure.contestant.points.length, hunter: measure.hunter.points.length, squeezes: measure.squeezes.length };
    },
  },
  {
    id: "defects", pass: "areas", label: "Defect regions", stage: "report", on: true, opacity: 1,
    cells: () => {
      const named = defectRegions();
      return (cell) => (regionAt[cell]! >= 0 && named.has(views!.regions.regions[regionAt[cell]!]!.id) ? "defect" : null);
    },
    colour: () => [235, 70, 60, 120],
    inspect: (_, { region }) => region ? [
      ...(check?.defects ?? []).filter((defect) => defect.regions?.includes(region.id)).map((defect) => `Defect, ${defect.kind}: ${defect.message}`),
      ...(diagnosis?.brokenPromises ?? []).filter((broken) => broken.region === region.id).map((broken) => `Broken promise: ${broken.errors.join("; ")}`),
    ] : [],
  },
  {
    id: "defectSites", pass: "marks", label: "Defect sites", stage: "report", on: true, opacity: 1,
    legend: () => [["defect at a site", "#ff5a4a"]],
    paint: (g, v, px) => {
      const { cellSize } = v.built;
      for (const defect of check?.defects ?? [])
        if (defect.site) {
          dot(g, defect.site.x / cellSize, defect.site.y / cellSize, Math.max(1, 9 * px));
          g.strokeStyle = "#ff5a4a";
          g.lineWidth = 2 * px;
          g.stroke();
        }
    },
  },
];

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
   * A layer at full opacity draws straight onto the map. Otherwise it draws opaque on a
   * scratch canvas that is laid on once at the layer's opacity, so overlapping parts of one
   * layer (a site's fill and outline, say) don't fade by different amounts.
   */
  const composite = (layer: Layer, paint: (g: Context) => void) => {
    if (layer.opacity >= 1) return paint(ctx);
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
const CONTESTANT_ROUTE = "#7fd0ff";
const HUNTER_ROUTE = "#ff7a6b";
const SQUEEZE = "#ffe14d";

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
  routesWorker = ask(null, { kind: "routes", built: v.built, from: a, to: b }, (reply) => {
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
function routeLine(name: string, route: RouteMeasure["contestant"]): HTMLElement {
  return route.length === null
    ? element("p", `${name} (clearance ${route.clearance}): no route. The target is unreachable for this body.`, "bad")
    : element("p", `${name} (clearance ${route.clearance}): ${Math.round(route.length).toLocaleString("en")} world units on the grid, ${Math.round(route.walked!).toLocaleString("en")} walked`);
}

function renderRoutes(): void {
  const body = $("routesBody");
  $<HTMLButtonElement>("measureRoutes").disabled = !views;
  if (!routes) return void (body.textContent = "Not measured.");
  if (routes.pending) return void (body.textContent = "Measuring…");
  if (routes.error) return void body.replaceChildren(element("p", `Not measured: ${routes.error}`, "bad"));
  const { contestant, hunter, squeezes, ratio } = routes.measure!;
  body.replaceChildren(
    element("p", `From ${routes.from} to ${routes.to} (${routes.ms.toFixed(0)} ms)`),
    routeLine("Contestant", contestant),
    routeLine("Hunter", hunter),
    ...(ratio !== null ? [element("p", `Hunter / contestant: ${ratio.toFixed(3)}`)] : []),
    ...(contestant.length !== null ? [element("p", `${squeezes.length} squeeze${squeezes.length === 1 ? "" : "s"} on the contestant's route, where a hunter can't pass`)] : []),
  );
}

/** A route as a path, in the built map's coordinates. */
function routePath(points: Array<{ x: number; y: number }>): Path2D {
  const path = new Path2D();
  points.forEach((p, i) => (i ? path.lineTo(p.x, p.y) : path.moveTo(p.x, p.y)));
  return path;
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
      if (link.chain) showTab(true);
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

function download(name: string, body: string | Uint8Array, type: string): void {
  const url = URL.createObjectURL(new Blob([body as BlobPart], { type }));
  const link = element("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

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
$("zoomIn").onclick = () => zoomCentre(1.25);
$("zoomOut").onclick = () => zoomCentre(1 / 1.25);
$("zoomReset").onclick = fit;
$("diagnose").onclick = startDiagnosis;
$("cancelDiagnose").onclick = cancelDiagnosis;
$("measureRoutes").onclick = measureRoutes;
renderLayers();
input("seed").onkeydown = (event) => {
  if (event.key === "Enter") generateMap();
};

function showTab(chain: boolean): void {
  $("worldView").hidden = chain;
  $("chainViewContainer").hidden = !chain;
  $("worldTab").classList.toggle("active", !chain);
  $("chainTab").classList.toggle("active", chain);
  if (chain) renderChainLibrary();
  else resize();
}
$("worldTab").onclick = () => showTab(false);
$("chainTab").onclick = () => showTab(true);

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
      from: routes.from, to: routes.to, pending: routes.pending, error: routes.error,
      contestant: routes.measure && { length: routes.measure.contestant.length, points: routes.measure.contestant.points.length },
      hunter: routes.measure && { length: routes.measure.hunter.length, points: routes.measure.hunter.points.length },
      squeezes: routes.measure?.squeezes.length ?? null, ratio: routes.measure?.ratio ?? null,
      drawn: drawnTraces.routes ?? null, text: $("routesBody").textContent,
    },
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

// The micro tools are on the game's dev server, linked when it runs in this worktree (20.5).
fetch("/dev-nav-config.json", { cache: "no-store" })
  .then((response) => (response.ok ? response.json() : null))
  .then((config: { mainUrl?: string | null } | null) => {
    gameUrl = config?.mainUrl ?? null;
    renderInspector();
  })
  .catch(() => {});

fillParams(DEFAULT_CHAIN_PARAMS);
generateMap();


// ── Resizer ─────────────────────────────────────────────────────────────────

const resizer = $("diagnosticsResizer") as HTMLDivElement;
const diagnosticsPane = $("diagnosticsPane") as HTMLDivElement;
const worldMain = document.querySelector(".world-main") as HTMLElement;

let paneCollapsed = false;
let paneHeight = 0;

const savedResizer = (() => {
  try { return localStorage.getItem("mapLabDiagnostics"); }
  catch (e) { return null; }
})();

if (savedResizer) {
  try {
    const state = JSON.parse(savedResizer);
    if (state.collapsed) paneCollapsed = true;
    if (state.height) paneHeight = state.height;
  } catch (e) {}
}

function saveResizerState() {
  try {
    localStorage.setItem("mapLabDiagnostics", JSON.stringify({
      collapsed: paneCollapsed,
      height: paneHeight
    }));
  } catch (e) {}
}

function applyPaneHeight() {
  if (paneCollapsed) {
    resizer.classList.add("collapsed");
    diagnosticsPane.classList.add("collapsed");
    diagnosticsPane.style.height = '';
    diagnosticsPane.style.maxHeight = '';
    return;
  }
  resizer.classList.remove("collapsed");
  diagnosticsPane.classList.remove("collapsed");
  
  if (paneHeight) {
    if (!worldMain.clientHeight) return; // Skip clamp when hidden
    const maxH = worldMain.clientHeight - 240 - resizer.offsetHeight;
    let newH = paneHeight;
    if (newH < 40) newH = 40;
    if (newH > maxH) newH = maxH;
    
    paneHeight = newH; // store the clamped value
    diagnosticsPane.style.height = `${newH}px`;
    diagnosticsPane.style.maxHeight = 'none';
  } else {
    diagnosticsPane.style.height = '';
    diagnosticsPane.style.maxHeight = '';
  }
}

function toggleResizer() {
  paneCollapsed = !paneCollapsed;
  applyPaneHeight();
  saveResizerState();
}

resizer.onkeydown = (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    toggleResizer();
  }
};

let resizerDrag: { startY: number; startHeight: number; moved: boolean } | null = null;
resizer.onpointerdown = (event) => {
  resizer.setPointerCapture(event.pointerId);
  resizerDrag = { startY: event.clientY, startHeight: diagnosticsPane.offsetHeight, moved: false };
};
resizer.onpointermove = (event) => {
  if (!resizerDrag) return;
  const dy = resizerDrag.startY - event.clientY;
  if (Math.abs(dy) > 3) {
    if (!resizerDrag.moved) {
      paneCollapsed = false;
    }
    resizerDrag.moved = true;
  }
  if (!resizerDrag.moved) return;

  paneHeight = resizerDrag.startHeight + dy;
  applyPaneHeight();
};
const stopDrag = () => {
  if (resizerDrag) {
    if (resizerDrag.moved) saveResizerState();
    else toggleResizer();
  }
  resizerDrag = null;
};
const cancelDrag = () => {
  resizerDrag = null;
};
resizer.onpointerup = stopDrag;
resizer.onpointercancel = cancelDrag;
resizer.onlostpointercapture = cancelDrag;

// Hook into window resize to re-clamp
new ResizeObserver(() => {
  if (!paneCollapsed && paneHeight) applyPaneHeight();
}).observe(worldMain);

// Initial application
applyPaneHeight();
