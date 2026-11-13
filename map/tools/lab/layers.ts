/** World layers and their drawing/inspection rules (53.1). App owns mutable state. */
import type { MapCheck, ToolMap } from "../core.ts";
import type { MapViews } from "../../macro/src/chain/map.ts";
import { CHAIN_TILE_SIZE } from "../../macro/src/chain/library.ts";
import type { PlacedSlot, SetPieceInstance } from "../../macro/src/chain/types.ts";
import type { RegionBrief } from "../../kernel/contract.ts";
import type { BrokenPromise } from "../../micro/diagnose.ts";
import type { RegionElement } from "../../micro/types.ts";
import { designsNotUsed, drawAllocation, drawDesignGraph, drawOpenings, drawSpans, guidanceNotMet, traceSummary } from "../../micro/building/draw.ts";
import type { BuildingTrace } from "../../micro/building/trace.ts";
import type { RouteMeasure } from "../routes.ts";
import { openChainEntry } from "./chain-author.ts";
import { download } from "./download.ts";
import { PARTS, PART_FILL } from "./parts.ts";
import type { Part } from "./parts.ts";
type Context = CanvasRenderingContext2D;
export type Views = MapViews<RegionElement>;

export type Rgb = [number, number, number];
export type Rgba = [number, number, number, number];

/** The cell a layer reads for the inspector, with its region and that region's result. */
export interface Probe {
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
export interface Layer {
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

export type Drill = {
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
};

export interface BuiltParts {
  /** Each part's shapes, in cell units. */
  paths: Record<Part, Path2D>;
  count: Record<Part, number>;
  /** Per region id: its part counts, and its elements' labels. */
  regions: Map<string, { count: Record<Part, number>; labels: string[] }>;
}

export interface LayerContext {
  readonly map: ToolMap | null;
  readonly views: Views | null;
  readonly check: MapCheck | null;
  readonly diagnosis: { brokenPromises: BrokenPromise[] } | null;
  readonly drill: Drill | null;
  readonly routes: { measure: RouteMeasure | null } | null;
  readonly parts: BuiltParts | null;
  readonly slotAt: Map<string, { slot: PlacedSlot; piece?: SetPieceInstance }>;
  readonly briefOf: Map<string, { brief: RegionBrief; anchor: { x: number; y: number } }>;
  readonly regionAt: Int32Array;
  readonly drawnTraces: Record<string, object>;
  readonly gameUrl: string;
}

/** A steady colour for a name. */
export function colour(name: string, saturation = 42, lightness = 40): Rgb {
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

export const css = ([r, g, b]: Rgb) => `rgb(${r} ${g} ${b})`;

/** The outline of a set of cells, where a cell meets one not in the set. */
function cellOutline(cells: Array<{ x: number; y: number }>, size = 1): Path2D {
  const own = new Set(cells.map(({ x, y }) => `${x},${y}`)), edge = new Path2D();
  const side = (x0: number, y0: number, x1: number, y1: number) => {
    edge.moveTo(x0 * size, y0 * size);
    edge.lineTo(x1 * size, y1 * size);
  };
  for (const { x, y } of cells) {
    if (!own.has(`${x},${y - 1}`)) side(x, y, x + 1, y);
    if (!own.has(`${x},${y + 1}`)) side(x, y + 1, x + 1, y + 1);
    if (!own.has(`${x - 1},${y}`)) side(x, y, x, y + 1);
    if (!own.has(`${x + 1},${y}`)) side(x + 1, y, x + 1, y + 1);
  }
  return edge;
}

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

/** A region's elements by name, numbers folded: "12 compound-room-#, 1 hut-building". */
function elementNames(labels: string[]): string {
  const named = new Map<string, number>();
  for (const label of labels) {
    const name = label.replace(/\d+/g, "#");
    named.set(name, (named.get(name) ?? 0) + 1);
  }
  return [...named].map(([name, n]) => `${n} ${name}`).join(", ");
}

/** What a brief asks for, folded to one phrase: "2 spawn, 1 exit". */
function assigned(brief: RegionBrief): string {
  return Object.entries(brief.coreElements ?? {}).filter(([, n]) => n).map(([kind, n]) => `${n} ${kind}`).join(", ");
}

function zoneAt(v: Views, x: number, y: number): Views["zones"][number] | undefined {
  return v.zones.find(({ cells: b }) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1);
}

// ── Layers ──────────────────────────────────────────────────────────────────

const CONTESTANT_ROUTE = "#7fd0ff";
const HUNTER_ROUTE = "#ff7a6b";
const SQUEEZE = "#ffe14d";

/** A route as a path, in the built map's coordinates. */
function routePath(points: Array<{ x: number; y: number }>): Path2D {
  const path = new Path2D();
  points.forEach((p, i) => (i ? path.lineTo(p.x, p.y) : path.moveTo(p.x, p.y)));
  return path;
}

/** Build one registry reading current app state through the supplied getters. */
export function createLayers(state: LayerContext): Layer[] {
  /** Regions any defect or broken promise names. */
  function defectRegions(): Set<string> {
    const named = new Set<string>();
    for (const defect of state.check?.defects ?? []) for (const id of defect.regions ?? []) named.add(id);
    for (const broken of state.diagnosis?.brokenPromises ?? []) named.add(broken.region);
    if (state.drill?.difference) named.add(state.drill.id);
    return named;
  }

  // ── Region drill-down ───────────────────────────────────────────────────────

  /** Whether the drill-down may be drawn: the region rebuilt equal to the stored result, so its traces are the stored region's. */
  function drillShown(): boolean {
    return !!state.drill && !state.drill.pending && !state.drill.difference && !state.drill.error;
  }

  function drilled(): BuildingTrace[] {
    return drillShown() ? state.drill!.traces : [];
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
        state.drawnTraces[id] = drawTraces(g, traces, px * cellSize);
        g.restore();
      },
    };
  }

  const SITE_COLOURS: Record<string, string> = {
    spawn: "#7fd0ff", "hunter-spawn": "#ff7a6b", exit: "#c8f185", charger: "#ffd166", warp: "#c39bff",
  };

  /** The slot holding a cell, with its set piece instance. */
  const slotOf = (x: number, y: number) => state.slotAt.get(`${Math.floor(x / CHAIN_TILE_SIZE)},${Math.floor(y / CHAIN_TILE_SIZE)}`);
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
    const types = [...new Set(Object.values(state.map?.library.cellClasses ?? {}).map((entry) => entry.regionType))].sort();
    const i = types.indexOf(type);
    return i < 0 ? colour(type) : hsl((i * 0.618034) % 1, 0.6, i % 2 ? 0.36 : 0.5);
  }

  /** One part of the built map, filled in its colour. */
  function partLayer(part: Part, label: string, legend: string): Layer {
    const fill = PART_FILL[part];
    return {
      id: part, pass: "areas", label, stage: "built", on: true, opacity: 1,
      legend: () => [[legend, fill]],
      paint: (g) => {
        if (!state.parts) return;
        g.fillStyle = fill;
        g.fill(state.parts.paths[part]);
      },
    };
  }

  return [
    {
      id: "layout", pass: "marks", label: "Layout: tiles and set pieces", stage: "layout", on: false, opacity: 1,
      legend: () => [["tile", TILE_LINE], ...[...new Set(state.map?.layout.setPieces.map((piece) => piece.setPieceClass))]
        .map((name): [string, string] => [`set piece, ${name}`, pieceColour(name)])],
      paint: (g, _, px) => {
        if (!state.map) return;
        const S = CHAIN_TILE_SIZE, labelled = S / px >= LABEL_TILE_PX;
        const tiles = new Path2D();
        for (const { col, row } of state.map.layout.slots) tiles.rect(col * S, row * S, S, S);
        g.strokeStyle = TILE_LINE;
        g.lineWidth = px;
        g.stroke(tiles);
        // A set piece instance is outlined where its slots meet a slot not its own.
        for (const piece of state.map.layout.setPieces) {
          const edge = cellOutline(piece.slots.map(({ col, row }) => ({ x: col, y: row })), S);
          g.strokeStyle = pieceColour(piece.setPieceClass);
          g.lineWidth = 3 * px;
          g.stroke(edge);
        }
        if (!labelled) return;
        for (const { col, row, design, orientation } of state.map.layout.slots) {
          g.save();
          g.beginPath();
          g.rect(col * S, row * S, S, S);
          g.clip();
          tag(g, `${design} ${orientation}°`, col * S + 3 * px, row * S + 3 * px, px, TILE_LINE);
          g.restore();
        }
        for (const piece of state.map.layout.setPieces) {
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
        const at = slotOf(x, y), from = state.map;
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
      cells: (v) => (cell) => (state.regionAt[cell]! >= 0 ? v.regions.regions[state.regionAt[cell]!]!.id : null),
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
        return (cell) => (state.regionAt[cell]! >= 0 ? `component ${component.get(v.regions.regions[state.regionAt[cell]!]!.id)}` : null);
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
      cells: (v) => (cell) => (state.regionAt[cell]! >= 0 ? state.briefOf.get(v.regions.regions[state.regionAt[cell]!]!.id)?.brief.type ?? null : null),
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
      colour: (name) => heat(state.views!, Number.parseInt(name) / 100),
    },
    {
      id: "reducedFill", pass: "areas", label: "Reduced fill: guaranteed clear cells", stage: "briefs", on: false, opacity: 1,
      legend: () => [["owned cell excluded from geometry fill", "#347b90"]],
      cells: (v) => {
        const { width } = v.resolved, excluded = new Set<number>();
        for (const brief of v.briefs) {
          const fill = new Set((brief.fillCells ?? brief.cells).map(({ x, y }) => y * width + x));
          for (const { x, y } of brief.cells) if (!fill.has(y * width + x)) excluded.add(y * width + x);
        }
        return (cell) => excluded.has(cell) ? "guaranteed clear" : null;
      },
      colour: () => [52, 123, 144, 140],
      inspect: (_, { region, x, y }) => {
        const brief = region && state.briefOf.get(region.id)?.brief;
        if (!brief) return [];
        const fill = brief.fillCells ?? brief.cells;
        return brief.cells.some((cell) => cell.x === x && cell.y === y) && !fill.some((cell) => cell.x === x && cell.y === y)
          ? ["Reduced fill: this owned cell is guaranteed clear; geometry cannot occupy it."] : [];
      },
    },
    {
      id: "internalGuaranteed", pass: "marks", label: "Internal guaranteed runs", stage: "briefs", on: false, opacity: 1,
      legend: () => [["internal passability requirement", "#ffac6b"]],
      paint: (g, v, px) => {
        const lines = new Path2D();
        for (const brief of v.briefs) for (const run of brief.internalGuaranteed ?? []) runLine(lines, run);
        g.strokeStyle = "#ffac6b";
        g.lineWidth = Math.max(0.12, 2 * px);
        g.stroke(lines);
      },
      inspect: (_, { region }) => {
        const runs = region && state.briefOf.get(region.id)?.brief.internalGuaranteed;
        return runs?.length ? [`${runs.length} internal guaranteed run${runs.length === 1 ? "" : "s"}; each keeps its clear footprint without creating an external portal.`] : [];
      },
    },
    {
      id: "briefs", pass: "marks", label: "Briefs: portals and core elements", stage: "briefs", on: false, opacity: 1,
      legend: () => [["portal, as its region's brief states it", BRIEF_PORTAL], ["core elements assigned", "#ffd166"]],
      paint: (g, v, px) => {
        // Each region's portals are drawn a little inside it, so a shared portal shows both briefs'
        // statements. Portal ids are too long to label; the inspector lists them.
        const { width } = v.resolved, inset = Math.min(0.3, 4 * px), lines = new Path2D();
        v.regions.regions.forEach((region, own) => {
          for (const portal of state.briefOf.get(region.id)?.brief.portals ?? []) {
            // Cell (x, y) is the run's first cell on its far side (`run.ts`); the region is there or on the near side.
            const h = portal.axis === "h", inside = state.regionAt[portal.y * width + portal.x] === own ? inset : -inset;
            const [x, y] = h ? [portal.x, portal.y + inside] : [portal.x + inside, portal.y];
            lines.moveTo(x, y);
            lines.lineTo(h ? x + portal.length : x, h ? y : y + portal.length);
          }
        });
        g.lineCap = "butt";
        g.strokeStyle = BRIEF_PORTAL;
        g.lineWidth = Math.max(0.12, 2 * px);
        g.stroke(lines);
        for (const { brief, anchor } of state.briefOf.values()) {
          const text = assigned(brief);
          if (text) tag(g, text, anchor.x, anchor.y, px, "#ffd166");
        }
      },
      inspect: (_, { region }) => {
        const brief = region && state.briefOf.get(region.id)?.brief;
        if (!brief) return [];
        const chances = [...new Set(brief.zones.map((zone) => `${Math.round(zone.lootChance * 100)}%`))];
        return [
          `Brief: type ${brief.type}, ${brief.portals.length} portals${brief.portals.length ? ` (${brief.portals.map((portal) => portal.id).join(", ")})` : ""}`,
          `Assigned core elements: ${assigned(brief) || "none"}`,
          `Reduced fill: ${(brief.fillCells ?? brief.cells).length}/${brief.cells.length} owned cells; ${(brief.clearCells ?? []).length} known-clear access cells`,
          `Internal guaranteed runs: ${(brief.internalGuaranteed ?? []).length}`,
          ...(brief.parameters ? [`Parameters: ${Object.entries(brief.parameters).map(([name, value]) => `${name} ${value}`).join(", ")}`] : []),
          `Loot chance ${chances.join(", ")}`,
        ];
      },
    },
    {
      id: "lots", pass: "marks", label: "Drill-down: block lots", stage: "results", on: true, opacity: 1,
      legend: () => [["lot, a block's child region", LOT_LINE]],
      paint: (g, _, px) => {
        if (!state.drill || !drillShown()) return;
        g.strokeStyle = LOT_LINE;
        g.lineWidth = 2 * px;
        g.setLineDash([6 * px, 4 * px]);
        for (const lot of state.drill.lots) g.stroke(cellOutline(lot.cells));
        g.setLineDash([]);
        // A lot is a rectangle (54 `block`); its label is clipped to it.
        for (const lot of state.drill.lots) {
          const xs = lot.cells.map((c) => c.x), ys = lot.cells.map((c) => c.y), x = Math.min(...xs), y = Math.min(...ys);
          g.save();
          g.beginPath();
          g.rect(x, y, Math.max(...xs) + 1 - x, Math.max(...ys) + 1 - y);
          g.clip();
          tag(g, `${lot.id.slice(state.drill.id.length + 1)} ${lot.type}`, x + 3 * px, y + 3 * px, px, LOT_LINE);
          g.restore();
        }
        state.drawnTraces.lots = { lots: state.drill.lots.length };
      },
      inspect: (_, { region }) => {
        if (!region || state.drill?.id !== region.id) return [];
        if (state.drill.pending) return ["", "Drill-down: rebuilding…"];
        if (state.drill.error) return ["", `Drill-down failed: ${state.drill.error}`];
        if (state.drill.difference) return ["", `Defect: rebuilt, the region differs from the stored result, at ${state.drill.difference}. Its traces aren't drawn.`];
        return [
          "",
          `Drill-down: rebuilt equal to the stored result; ${state.drill.traces.length} building${state.drill.traces.length === 1 ? "" : "s"} from designs${state.drill.lots.length ? `, ${state.drill.lots.length} lots` : ""}`,
          ...state.drill.traces.flatMap((trace) => [traceSummary(trace), ...designsNotUsed(trace), ...guidanceNotMet(trace)]),
        ];
      },
      links: (_, { region }) => {
        if (!region || state.drill?.id !== region.id || state.drill.pending) return [];
        const { brief, fragment } = state.drill, file = `brief-${brief.id.replace(/[^a-z0-9-]/gi, "_")}.json`;
        return [
          ...(fragment ? [{ label: "Open in the Preview Lab", href: `${state.gameUrl}/dev/micro${fragment}` }] : []),
          ...(fragment && brief.type === "block" ? [{ label: "Open in the Generation Trace", href: `${state.gameUrl}/dev/micro/generation${fragment}` }] : []),
          { label: "Save this region's brief", open: () => download(file, JSON.stringify(brief, null, 2), "application/json") },
        ];
      },
    },
    traceLayer("allocation", "Drill-down: spaces and allocation", "areas", true, drawAllocation),
    traceLayer("spans", "Drill-down: spans", "marks", false, drawSpans),
    traceLayer("openings", "Drill-down: openings", "marks", true, drawOpenings),
    traceLayer("graph", "Drill-down: design graph", "marks", false, drawDesignGraph),
    {
      ...partLayer("walls", "Building walls", "building wall"),
      inspect: (_, { built }) => {
        if (!built) return [];
        const own = state.parts?.regions.get(built.brief.id);
        return [
          `${built.elements.length} elements, ${built.loot.length} loot`,
          ...(own ? [`Parts: ${PARTS.map((part) => `${own.count[part]} ${part}`).join(", ")}`, `Elements: ${elementNames(own.labels) || "none"}`] : []),
        ];
      },
    },
    partLayer("ruins", "Ruin walls and rubble", "ruin wall"),
    partLayer("cover", "Cover", "container, crate, tree or hedge"),
    partLayer("windows", "Windows", "window"),
    partLayer("pipes", "Pipe runs", "pipe run"),
    partLayer("doors", "Doors", "door, closed"),
    { ...partLayer("roofs", "Roofs", "roof"), on: false, opacity: 0.6 },
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
      legend: () => [["contestant route", CONTESTANT_ROUTE], ["hunter route", HUNTER_ROUTE], [state.routes?.measure?.method === "mesh" ? "hunter-blocked route legs" : "squeeze, contestant only", SQUEEZE], ["no route", "#ff5a4a"]],
      paint: (g, v, px) => {
        const measure = state.routes?.measure;
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
        state.drawnTraces.routes = { contestant: measure.contestant.points.length, hunter: measure.hunter.points.length, squeezes: measure.squeezes.length };
      },
    },
    {
      id: "defects", pass: "areas", label: "Defect regions", stage: "report", on: true, opacity: 1,
      cells: () => {
        const named = defectRegions();
        return (cell) => (state.regionAt[cell]! >= 0 && named.has(state.views!.regions.regions[state.regionAt[cell]!]!.id) ? "defect" : null);
      },
      colour: () => [235, 70, 60, 120],
      inspect: (_, { region }) => region ? [
        ...(state.check?.defects ?? []).filter((defect) => defect.regions?.includes(region.id)).map((defect) => `Defect, ${defect.kind}: ${defect.message}`),
        ...(state.diagnosis?.brokenPromises ?? []).filter((broken) => broken.region === region.id).map((broken) => `Broken promise: ${broken.errors.join("; ")}`),
      ] : [],
    },
    {
      id: "defectSites", pass: "marks", label: "Defect sites", stage: "report", on: true, opacity: 1,
      legend: () => [["defect at a site", "#ff5a4a"]],
      paint: (g, v, px) => {
        const { cellSize } = v.built;
        for (const defect of state.check?.defects ?? [])
          if (defect.site) {
            dot(g, defect.site.x / cellSize, defect.site.y / cellSize, Math.max(1, 9 * px));
            g.strokeStyle = "#ff5a4a";
            g.lineWidth = 2 * px;
            g.stroke();
          }
      },
    },
  ];

}
