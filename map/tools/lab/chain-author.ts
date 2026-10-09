import {
  CHAIN_LIBRARY_VERSION,
  CHAIN_TILE_SIZE,
  COUNT_PARAMS,
  validateLibrary,
} from "../../macro/src/chain/library.ts";
import type {
  ChainLibrary,
  ChainTileDesign,
  ChainSetPieceSlot,
  CoreElementCount,
  PassabilityPrescription,
  SegmentPrescription,
} from "../../macro/src/chain/library.ts";
import { orientDesign } from "../../macro/src/chain/declared-grid.ts";
import { regions, portalViolations } from "../../macro/src/chain/regions.ts";
import type { ResolvedLayout } from "../../macro/src/chain/types.ts";
import { CORE_ELEMENT_KINDS } from "../../kernel/contract.ts";
import type { CoreElementKind } from "../../kernel/contract.ts";
import { MIN_PORTAL_LENGTH } from "../../kernel/scale.ts";
import { CHAIN_LIBRARIES, CHAIN_LIBRARY } from "../core.ts";

const $ = (id: string): HTMLElement => document.getElementById(id)!;
const select = (id: string): HTMLSelectElement => $(id) as HTMLSelectElement;
const area = (id: string): HTMLTextAreaElement => $(id) as HTMLTextAreaElement;
const starter: ChainLibrary = {
  name: "lab-draft",
  version: CHAIN_LIBRARY_VERSION,
  zonePlan: "diamond",
  zoneWidth: 12,
  zoneHeight: 6,
  cellClasses: {
    open: { regionType: "open-field" },
    hut: { regionType: "hut" },
    arrival: { regionType: "arrival", coreElements: { spawn: 1 } },
  },
  tiles: [
    {
      id: "half-hut",
      defaultCellClass: "open",
      cells: ["...hhh", "...hhh", "...hhh", "...hhh", "...hhh", "...hhh"],
      legend: { h: "hut" },
      segments: {
        "v:3,2": { passability: "passable" },
        "v:3,3": { passability: "passable" },
        "v:6,2": { adjacency: "open" },
      },
      orientations: [0, 90, 180, 270],
    },
  ],
  tileSets: [{ id: "one", members: ["half-hut"] }],
  setPieces: [
    {
      id: "entry",
      tiles: [{ dx: 0, dy: 0, tileSetId: "one" }],
      primaryRegionClass: "open",
    },
  ],
  setPieceClasses: [
    {
      id: "start",
      placementRule: "start",
      quota: 1,
      setPieces: ["entry"],
      coreElements: { spawn: 1 },
    },
  ],
};
type Section =
  "classes" | "tiles" | "tileSets" | "setPieces" | "setPieceClasses";
const KEY = "last-exit-chain-library-v3";
let library: ChainLibrary = structuredClone(starter);
let savedDraftWarning = "";
function declaredRegionTypeIds(raw: unknown): Set<string> {
  if (
    !raw ||
    typeof raw !== "object" ||
    !("cellClasses" in raw) ||
    !raw.cellClasses ||
    typeof raw.cellClasses !== "object" ||
    Array.isArray(raw.cellClasses)
  )
    return new Set();
  return new Set(
    Object.values(raw.cellClasses)
      .filter(
        (entry): entry is { regionType: string } =>
          !!entry &&
          typeof entry === "object" &&
          "regionType" in entry &&
          typeof entry.regionType === "string",
      )
      .map((entry) => entry.regionType),
  );
}
/** Keep incomplete authoring drafts, but never pass a broken container to render(). */
function renderableDraft(raw: unknown): raw is ChainLibrary {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const draft = raw as Record<string, unknown>;
  if (
    !draft.cellClasses ||
    typeof draft.cellClasses !== "object" ||
    Array.isArray(draft.cellClasses) ||
    !Object.values(draft.cellClasses).every(
      (entry) => entry !== null && typeof entry === "object",
    )
  )
    return false;
  for (const field of ["tiles", "tileSets", "setPieces", "setPieceClasses"])
    if (
      !Array.isArray(draft[field]) ||
      !draft[field].every(
        (entry: unknown) =>
          entry !== null &&
          typeof entry === "object" &&
          typeof (entry as { id?: unknown }).id === "string",
      )
    )
      return false;
  return (
    (draft.tiles as ChainLibrary["tiles"]).every(
      (tile) =>
        typeof tile.defaultCellClass === "string" &&
        Array.isArray(tile.orientations) &&
        (tile.eligibleTiers === undefined ||
          Array.isArray(tile.eligibleTiers)) &&
        (tile.eligibleBonus === undefined ||
          Array.isArray(tile.eligibleBonus)) &&
        (tile.labels === undefined || Array.isArray(tile.labels)),
    ) &&
    (draft.tileSets as ChainLibrary["tileSets"]).every((set) =>
      Array.isArray(set.members),
    ) &&
    (draft.setPieces as ChainLibrary["setPieces"]).every(
      (piece) =>
        Array.isArray(piece.tiles) &&
        piece.tiles.every(
          (slot) => slot !== null && typeof slot === "object",
        ) &&
        (piece.eligibleTiers === undefined ||
          Array.isArray(piece.eligibleTiers)),
    ) &&
    (draft.setPieceClasses as ChainLibrary["setPieceClasses"]).every((group) =>
      Array.isArray(group.setPieces),
    )
  );
}
try {
  const saved = localStorage.getItem(KEY);
  if (saved) {
    const draft: unknown = JSON.parse(saved);
    const validation = validateLibrary(draft, declaredRegionTypeIds(draft));
    if (validation.valid || renderableDraft(draft))
      library = draft as ChainLibrary;
    else
      savedDraftWarning =
        "Saved chain draft was invalid; loaded the starter library.";
  }
} catch {
  savedDraftWarning =
    "Saved chain draft could not be read; loaded the starter library.";
}
let selectedSegment = "v:3,2";
let selectedCellClass = "hut";
let selectedId = "";
type PaintTool = "paint" | "fill" | "rect" | "segment";
type SegmentBrush = PassabilityPrescription | "unstated";
let selectedPaintTool: PaintTool = "paint";
let selectedSegmentBrush: SegmentBrush = "passable";
let activePopup: HTMLElement | null = null;
let popupDismissListener: ((evt: MouseEvent) => void) | null = null;

function closePopup(): void {
  if (popupDismissListener) {
    document.removeEventListener("pointerdown", popupDismissListener);
    popupDismissListener = null;
  }
  if (activePopup) {
    activePopup.remove();
    activePopup = null;
  }
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closePopup();
});

function section(): Section {
  return select("chainSection").value as Section;
}
function list(): Array<{ id: string }> {
  switch (section()) {
    case "tiles":
      return library.tiles;
    case "tileSets":
      return library.tileSets;
    case "setPieces":
      return library.setPieces;
    case "setPieceClasses":
      return library.setPieceClasses;
    case "classes":
      return [];
  }
}
function entries(): string[] {
  return section() === "classes"
    ? Object.keys(library.cellClasses)
    : list().map((entry) => entry.id);
}
function current(): any {
  return section() === "classes"
    ? library.cellClasses[selectedId]
    : list().find((entry) => entry.id === selectedId);
}
function option(value: string, label = value): HTMLOptionElement {
  return new Option(label, value);
}
function field(
  label: string,
  id: string,
  value: string | number,
  change: (value: string) => void,
  kind: "text" | "number" = "text",
): HTMLElement {
  const wrap = document.createElement("label");
  wrap.textContent = label;
  const input = document.createElement("input");
  input.id = id;
  input.type = kind;
  input.value = String(value);
  input.onchange = () => {
    change(input.value);
    changed();
  };
  wrap.append(input);
  return wrap;
}
function choice(
  label: string,
  id: string,
  values: string[],
  value: string,
  change: (value: string) => void,
  labels: Record<string, string> = {},
): HTMLElement {
  const wrap = document.createElement("label");
  wrap.textContent = label;
  const input = document.createElement("select");
  input.id = id;
  input.replaceChildren(
    ...values.map((v) => option(v, labels[v] ?? (v || "Unspecified"))),
  );
  input.value = value;
  input.onchange = () => {
    change(input.value);
    changed();
  };
  wrap.append(input);
  return wrap;
}
function heading(text: string): HTMLElement {
  const h = document.createElement("h3");
  h.textContent = text;
  return h;
}
function paragraph(text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "hint";
  p.textContent = text;
  return p;
}
function csv(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}
function numberList(value: string): number[] {
  return csv(value).map(Number);
}
function coreFields(value: {
  coreElements?: Partial<Record<CoreElementKind, CoreElementCount>>;
}): HTMLElement {
  const box = document.createElement("div");
  box.id = "chainCoreElements";
  box.className = "chain-core";
  box.append(heading("Core elements"));
  for (const kind of CORE_ELEMENT_KINDS) {
    const wrap = document.createElement("label");
    wrap.textContent = kind;
    const input = document.createElement("input");
    input.className = "chainCoreElements";
    input.dataset.kind = kind;
    input.value = String(value.coreElements?.[kind] ?? "");
    input.placeholder = `Count or ${COUNT_PARAMS.join(" / ")}`;
    input.onchange = () => {
      const raw = input.value.trim();
      const next = { ...value.coreElements };
      if (!raw) delete next[kind];
      else {
        const countParam = COUNT_PARAMS.find((name) => name === raw);
        if (countParam) next[kind] = countParam;
        else {
          const count = Number(raw);
          if (!Number.isSafeInteger(count) || count <= 0) {
            status(
              `Core element ${kind} needs a positive whole number or ${COUNT_PARAMS.join(", ")}.`,
            );
            return;
          }
          next[kind] = count;
        }
      }
      if (Object.keys(next).length) value.coreElements = next;
      else delete value.coreElements;
      changed();
    };
    wrap.append(input);
    box.append(wrap);
  }
  return box;
}
function rename(next: string): void {
  const old = selectedId;
  next = next.trim();
  if (!next || (next !== old && entries().includes(next))) {
    status(`Name must be unique and nonempty: ${next}`);
    return;
  }
  if (section() === "tiles") {
    const setsUsing = library.tileSets
      .filter((s) => s.members.includes(old))
      .map((s) => s.id);
    if (setsUsing.length) {
      const msg = `Rename tile design "${old}" to "${next}"? It is referenced in tile set(s): ${setsUsing.join(", ")}. References will be updated automatically.`;
      if (!confirm(msg)) {
        render();
        return;
      }
    }
  }
  if (section() === "tileSets") {
    const piecesUsing = library.setPieces
      .filter((p) => p.tiles.some((slot) => slot.tileSetId === old))
      .map((p) => p.id);
    if (piecesUsing.length) {
      const msg = `Rename tile set "${old}" to "${next}"? It is referenced in set piece(s): ${piecesUsing.join(", ")}. References will be updated automatically.`;
      if (!confirm(msg)) {
        render();
        return;
      }
    }
  }
  if (section() === "classes") {
    library.cellClasses[next] = library.cellClasses[old]!;
    delete library.cellClasses[old];
    for (const tile of library.tiles) {
      if (tile.defaultCellClass === old) tile.defaultCellClass = next;
      for (const [mark, id] of Object.entries(tile.legend ?? {}))
        if (id === old) tile.legend![mark] = next;
      for (const segment of Object.values(tile.segments ?? {}))
        if (segment.adjacency === old) segment.adjacency = next;
    }
    for (const piece of library.setPieces)
      if (piece.primaryRegionClass === old) piece.primaryRegionClass = next;
  } else {
    current().id = next;
    if (section() === "tiles")
      for (const set of library.tileSets)
        set.members = set.members.map((id) => (id === old ? next : id));
    if (section() === "tileSets")
      for (const piece of library.setPieces)
        for (const slot of piece.tiles)
          if (slot.tileSetId === old) slot.tileSetId = next;
    if (section() === "setPieces")
      for (const group of library.setPieceClasses)
        group.setPieces = group.setPieces.map((id) => (id === old ? next : id));
  }
  selectedId = next;
}
function renderClasses(root: HTMLElement): void {
  const entry = library.cellClasses[selectedId];
  if (!entry) return;
  root.append(
    field("Region type ID", "chainRegionType", entry.regionType, (value) => {
      entry.regionType = value.trim();
    }),
  );
  root.append(
    paragraph(
      "Parameters are key/value pairs. Values are parsed as JSON scalars (number, string, boolean).",
    ),
  );
  const params = document.createElement("div");
  params.id = "chainParams";
  root.append(params);
  for (const [key, value] of Object.entries(entry.params ?? {})) {
    const row = document.createElement("div");
    row.className = "chain-row";
    const name = document.createElement("input");
    name.value = key;
    name.setAttribute("aria-label", "Parameter name");
    const scalar = document.createElement("input");
    scalar.value = JSON.stringify(value);
    scalar.setAttribute("aria-label", "Parameter value");
    const remove = document.createElement("button");
    remove.textContent = "Remove";
    const update = () => {
      try {
        const parsed: unknown = JSON.parse(scalar.value);
        if (!["string", "number", "boolean"].includes(typeof parsed))
          throw Error("Parameter needs a scalar");
        delete entry.params?.[key];
        entry.params ??= {};
        entry.params[name.value.trim()] = parsed as string | number | boolean;
        changed();
      } catch (error) {
        status(String(error));
      }
    };
    name.onchange = update;
    scalar.onchange = update;
    remove.onclick = () => {
      delete entry.params?.[key];
      if (!Object.keys(entry.params ?? {}).length) delete entry.params;
      changed();
    };
    row.append(name, scalar, remove);
    params.append(row);
  }
  const add = document.createElement("button");
  add.textContent = "Add parameter";
  add.onclick = () => {
    entry.params ??= {};
    entry.params[`param${Object.keys(entry.params).length + 1}`] = "";
    changed();
  };
  root.append(add, coreFields(entry));
}
function hash(s: unknown): number {
  return [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 0);
}
function classColor(name: string): string {
  if (name === "open") return "#5a6268";
  if (name === "any") return "#34495e";
  return `hsl(${hash(name) % 360} 35% 38%)`;
}
function plotLine(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let cx = x0;
  let cy = y0;
  while (true) {
    points.push({ x: cx, y: cy });
    if (cx === x1 && cy === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      cx += sx;
    }
    if (e2 < dx) {
      err += dx;
      cy += sy;
    }
  }
  return points;
}
function allPerimeterSegments(): string[] {
  const keys: string[] = [];
  for (let offset = 0; offset < CHAIN_TILE_SIZE; offset++) {
    keys.push(`v:0,${offset}`);
    keys.push(`v:${CHAIN_TILE_SIZE},${offset}`);
    keys.push(`h:0,${offset}`);
    keys.push(`h:${CHAIN_TILE_SIZE},${offset}`);
  }
  return keys;
}
function segmentDescriptor(key: string): { isPerimeter: boolean; line: number; offset: number } {
  const [, rest] = key.split(":");
  const [lineStr, offsetStr] = rest!.split(",");
  const line = Number(lineStr);
  const offset = Number(offsetStr);
  const isPerimeter = line === 0 || line === CHAIN_TILE_SIZE;
  return { isPerimeter, line, offset };
}

function segmentTooltip(key: string, tile: ChainTileDesign): string {
  const { isPerimeter } = segmentDescriptor(key);
  const p = tile.segments?.[key];
  const passability = p?.passability ?? "unstated";
  let tooltip = `Segment ${key} (${isPerimeter ? "perimeter" : "interior"}) · passability: ${passability}`;
  if (isPerimeter && p?.adjacency) {
    tooltip += ` · adjacency: ${p.adjacency}`;
  }
  return tooltip;
}

function setSegmentProp(
  tile: ChainTileDesign,
  key: string,
  dimension: "adjacency" | "passability",
  value: string | undefined,
): void {
  tile.segments ??= {};
  const next = (tile.segments[key] ??= {});
  if (value) {
    if (dimension === "adjacency") {
      next.adjacency = value;
    } else {
      next.passability = value as PassabilityPrescription;
    }
  } else {
    delete next[dimension];
  }
  if (!Object.keys(next).length) delete tile.segments[key];
  if (!Object.keys(tile.segments).length) delete tile.segments;
}

function setSegmentPassability(
  tile: ChainTileDesign,
  key: string,
  passability: PassabilityPrescription | undefined,
): void {
  setSegmentProp(tile, key, "passability", passability);
}

function setSegmentAdjacency(
  tile: ChainTileDesign,
  key: string,
  adjacency: string | undefined,
): void {
  setSegmentProp(tile, key, "adjacency", adjacency);
}

function applySegmentBrush(
  tile: ChainTileDesign,
  key: string,
  brush: SegmentBrush,
): void {
  setSegmentPassability(tile, key, brush === "unstated" ? undefined : brush);
}

function getNearestSegment(
  grid: HTMLElement,
  clientX: number,
  clientY: number,
): string | null {
  const rect = grid.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const u = ((clientX - rect.left) / rect.width) * CHAIN_TILE_SIZE;
  const v = ((clientY - rect.top) / rect.height) * CHAIN_TILE_SIZE;
  const vLine = Math.min(Math.max(Math.round(u), 0), CHAIN_TILE_SIZE);
  const hLine = Math.min(Math.max(Math.round(v), 0), CHAIN_TILE_SIZE);
  const dv = Math.abs(u - vLine);
  const dh = Math.abs(v - hLine);
  if (Math.min(dv, dh) <= 0.25) {
    if (dv <= dh) {
      const offset = Math.min(Math.max(Math.floor(v), 0), CHAIN_TILE_SIZE - 1);
      return `v:${vLine},${offset}`;
    } else {
      const offset = Math.min(Math.max(Math.floor(u), 0), CHAIN_TILE_SIZE - 1);
      return `h:${hLine},${offset}`;
    }
  }
  return null;
}

function openSegmentPopup(
  clientX: number,
  clientY: number,
  key: string,
  tile: ChainTileDesign,
): void {
  const { isPerimeter } = segmentDescriptor(key);
  const p = tile.segments?.[key] ?? {};

  const popup = document.createElement("div");
  popup.className = "chain-popup";
  popup.style.left = `${clientX + 4}px`;
  popup.style.top = `${clientY + 4}px`;

  const title = document.createElement("h4");
  title.textContent = `Segment ${key} (${isPerimeter ? "perimeter" : "interior"})`;
  popup.append(title);

  const passabilities: Array<{
    id: PassabilityPrescription | "unstated";
    label: string;
  }> = [
    { id: "passable", label: "Passable" },
    { id: "not-passable-hint", label: "Wall (hint)" },
    { id: "any", label: "Any (deferred)" },
    { id: "unstated", label: "Clear passability" },
  ];

  for (const opt of passabilities) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = opt.label;
    if ((opt.id === "unstated" && !p.passability) || p.passability === opt.id) {
      btn.classList.add("active");
    }
    btn.onclick = () => {
      applySegmentBrush(tile, key, opt.id);
      closePopup();
      changed();
    };
    popup.append(btn);
  }

  if (isPerimeter) {
    popup.append(document.createElement("hr"));
    const adjTitle = document.createElement("h4");
    adjTitle.textContent = "Across-tile adjacency";
    popup.append(adjTitle);

    const adjChoices = ["", "any", ...Object.keys(library.cellClasses)];
    for (const c of adjChoices) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = c === "" ? "Clear adjacency" : `Adjacency: ${c}`;
      if ((c === "" && !p.adjacency) || p.adjacency === c) {
        btn.classList.add("active");
      }
      btn.onclick = () => {
        setSegmentAdjacency(tile, key, c === "" ? undefined : c);
        closePopup();
        changed();
      };
      popup.append(btn);
    }
  }

  document.body.append(popup);
  activePopup = popup;

  popupDismissListener = (evt: MouseEvent) => {
    if (!popup.contains(evt.target as Node)) {
      closePopup();
    }
  };
  setTimeout(() => {
    if (popupDismissListener) {
      document.addEventListener("pointerdown", popupDismissListener);
    }
  }, 0);
}
function tileCells(tile: ChainTileDesign): string[] {
  const oriented = orientDesign(tile, 0);
  return oriented.cells;
}
function tileThumbnail(t: ChainTileDesign): HTMLElement {
  const figure = document.createElement("figure");
  const cells = tileCells(t);
  for (let i = 0; i < CHAIN_TILE_SIZE * CHAIN_TILE_SIZE; i++) {
    const el = document.createElement("i");
    const cellClass = cells[i] ?? t.defaultCellClass;
    el.style.background = classColor(cellClass);
    figure.append(el);
  }
  for (const [key, p] of Object.entries(t.segments ?? {})) {
    const { isPerimeter, line, offset } = segmentDescriptor(key);
    const axis = key.startsWith("v") ? "v" : "h";
    if (p.passability) {
      const bar = document.createElement("b");
      bar.className = p.passability === "not-passable-hint" ? "wall" : p.passability;
      if (axis === "v") {
        bar.style.left = `${(line / CHAIN_TILE_SIZE) * 100}%`;
        bar.style.top = `${(offset / CHAIN_TILE_SIZE) * 100}%`;
        bar.style.width = "2px";
        bar.style.height = `${(1 / CHAIN_TILE_SIZE) * 100}%`;
        bar.style.transform = "translateX(-50%)";
      } else {
        bar.style.left = `${(offset / CHAIN_TILE_SIZE) * 100}%`;
        bar.style.top = `${(line / CHAIN_TILE_SIZE) * 100}%`;
        bar.style.width = `${(1 / CHAIN_TILE_SIZE) * 100}%`;
        bar.style.height = "2px";
        bar.style.transform = "translateY(-50%)";
      }
      figure.append(bar);
    }
    if (isPerimeter && p.adjacency) {
      const dot = document.createElement("span");
      dot.className = "adj-dot";
      if (p.adjacency === "any") {
        dot.classList.add("any");
      } else {
        dot.style.background = classColor(p.adjacency);
      }
      if (axis === "v") {
        dot.style.left = `${(line / CHAIN_TILE_SIZE) * 100}%`;
        dot.style.top = `${((offset + 0.5) / CHAIN_TILE_SIZE) * 100}%`;
      } else {
        dot.style.left = `${((offset + 0.5) / CHAIN_TILE_SIZE) * 100}%`;
        dot.style.top = `${(line / CHAIN_TILE_SIZE) * 100}%`;
      }
      figure.append(dot);
    }
  }
  return figure;
}

function renderGallery(): void {
  const container = document.getElementById("chainTileGallerySection");
  if (!container) return;
  if (section() !== "tiles") {
    container.style.display = "none";
    return;
  }
  container.style.display = "flex";
  const gallery = document.getElementById("tileGallery");
  if (!gallery) return;

  const filter = (
    (document.getElementById("tileFilter") as HTMLInputElement | null)?.value ?? ""
  ).trim().toLowerCase();

  const shown = library.tiles.filter((t) => {
    if (!filter) return true;
    if (t.id.toLowerCase().includes(filter)) return true;
    if (t.defaultCellClass.toLowerCase().includes(filter)) return true;
    if (t.labels?.some((l) => l.toLowerCase().includes(filter))) return true;
    if (
      Object.values(t.legend ?? {}).some((c) =>
        c.toLowerCase().includes(filter),
      )
    )
      return true;
    return false;
  });

  if (!shown.length) {
    const empty = document.createElement("p");
    empty.className = "gallery-empty";
    empty.textContent = `No tile matches "${filter}".`;
    gallery.replaceChildren(empty);
    return;
  }

  gallery.replaceChildren(
    ...shown.map((t) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "tile-card";
      card.dataset.tile = t.id;
      const isActive = t.id === selectedId;
      card.classList.toggle("active", isActive);
      card.title = `${t.id} · default ${t.defaultCellClass}${t.labels?.length ? ` · [${t.labels.join(", ")}]` : ""}`;
      const name = document.createElement("span");
      name.className = "tile-card-name";
      name.textContent = t.id;
      card.append(tileThumbnail(t), name);
      card.onclick = () => {
        selectedId = t.id;
        render();
      };
      return card;
    }),
  );
}
function updateTileCells(tile: ChainTileDesign, cells: string[]): void {
  const classes = [
    ...new Set(cells.filter((id) => id !== tile.defaultCellClass)),
  ];
  const marks = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ123456789";
  if (classes.length > marks.length)
    throw Error("Too many classes for one tile");
  const legend = Object.fromEntries(classes.map((id, i) => [marks[i]!, id]));
  tile.cells = Array.from({ length: CHAIN_TILE_SIZE }, (_, row) =>
    cells
      .slice(row * CHAIN_TILE_SIZE, (row + 1) * CHAIN_TILE_SIZE)
      .map((id) =>
        id === tile.defaultCellClass ? "." : marks[classes.indexOf(id)]!,
      )
      .join(""),
  );
  if (classes.length) tile.legend = legend;
  else delete tile.legend;
}
function setCell(
  tile: ChainTileDesign,
  x: number,
  y: number,
  value: string,
): void {
  const cells = tileCells(tile);
  cells[y * CHAIN_TILE_SIZE + x] = value;
  updateTileCells(tile, cells);
}
function setCells(
  tile: ChainTileDesign,
  coords: Array<{ x: number; y: number }>,
  value: string,
): void {
  const cells = tileCells(tile);
  for (const { x, y } of coords) {
    cells[y * CHAIN_TILE_SIZE + x] = value;
  }
  updateTileCells(tile, cells);
}
function floodFill(
  tile: ChainTileDesign,
  startX: number,
  startY: number,
  value: string,
): void {
  const cells = tileCells(tile);
  const target = cells[startY * CHAIN_TILE_SIZE + startX];
  if (target === value) return;
  const queue: Array<[number, number]> = [[startX, startY]];
  const seen = new Set<string>([`${startX},${startY}`]);
  while (queue.length > 0) {
    const [x, y] = queue.shift()!;
    cells[y * CHAIN_TILE_SIZE + x] = value;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx,
        ny = y + dy;
      if (
        nx >= 0 &&
        nx < CHAIN_TILE_SIZE &&
        ny >= 0 &&
        ny < CHAIN_TILE_SIZE
      ) {
        const key = `${nx},${ny}`;
        if (!seen.has(key) && cells[ny * CHAIN_TILE_SIZE + nx] === target) {
          seen.add(key);
          queue.push([nx, ny]);
        }
      }
    }
  }
  updateTileCells(tile, cells);
}
function renderTiles(root: HTMLElement): void {
  const tile = current() as ChainTileDesign;
  if (!tile) return;
  const classes = ["any", ...Object.keys(library.cellClasses)];
  if (!classes.includes(selectedCellClass)) selectedCellClass = classes[0]!;
  root.append(
    choice(
      "Default cell class",
      "chainDefaultClass",
      classes,
      tile.defaultCellClass,
      (v) => {
        tile.defaultCellClass = v;
      },
    ),
  );
  const orientations = document.createElement("div");
  orientations.className = "chain-checks";
  orientations.append(heading("Allowed orientations"));
  for (const angle of [0, 90, 180, 270]) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = tile.orientations.includes(angle);
    input.onchange = () => {
      tile.orientations = [0, 90, 180, 270].filter((n) =>
        n === angle ? input.checked : tile.orientations.includes(n),
      );
      changed();
    };
    label.append(input, `${angle}°`);
    orientations.append(label);
  }
  root.append(
    orientations,
    field(
      "Eligible tiers (comma separated, blank = all)",
      "chainTiers",
      (tile.eligibleTiers ?? []).join(", "),
      (v) => {
        if (v.trim()) tile.eligibleTiers = numberList(v);
        else delete tile.eligibleTiers;
      },
    ),
    field(
      "Eligible bonus (comma separated, blank = all)",
      "chainBonus",
      (tile.eligibleBonus ?? []).join(", "),
      (v) => {
        if (v.trim()) tile.eligibleBonus = numberList(v);
        else delete tile.eligibleBonus;
      },
    ),
    field("Labels", "chainLabels", (tile.labels ?? []).join(", "), (v) => {
      if (v.trim()) tile.labels = csv(v);
      else delete tile.labels;
    }),
    field(
      "Weight",
      "chainWeight",
      tile.weight ?? "",
      (v) => {
        if (v.trim()) tile.weight = Number(v);
        else delete tile.weight;
      },
      "number",
    ),
  );
  root.append(heading("Paint cells"));

  const palette = document.createElement("div");
  palette.className = "chain-paint-palette";

  const swatchRow = document.createElement("div");
  swatchRow.className = "chain-palette-row";

  const swatchesContainer = document.createElement("div");
  swatchesContainer.className = "chain-swatches";

  const swatchButtons: HTMLButtonElement[] = [];
  const colGutterButtons: HTMLButtonElement[] = [];
  const rowGutterButtons: HTMLButtonElement[] = [];
  const patternButtons: Array<{ btn: HTMLButtonElement; desc: string }> = [];

  const updateSwatches = () => {
    for (const btn of swatchButtons) {
      btn.classList.toggle("active", btn.dataset.class === selectedCellClass);
    }
    const selectEl = document.getElementById(
      "chainCellBrush",
    ) as HTMLSelectElement | null;
    if (selectEl && selectEl.value !== selectedCellClass) {
      selectEl.value = selectedCellClass;
    }
    for (let x = 0; x < colGutterButtons.length; x++) {
      colGutterButtons[x]!.title = `Paint column ${x} with ${selectedCellClass}`;
    }
    for (let y = 0; y < rowGutterButtons.length; y++) {
      rowGutterButtons[y]!.title = `Paint row ${y} with ${selectedCellClass}`;
    }
    for (const pb of patternButtons) {
      pb.btn.title = `${pb.desc} with ${selectedCellClass}`;
    }
  };

  for (const c of classes) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chain-swatch-button";
    btn.dataset.class = c;
    btn.classList.toggle("active", c === selectedCellClass);
    const dot = document.createElement("span");
    dot.className = "swatch";
    dot.style.background = classColor(c);
    const label = document.createElement("span");
    label.textContent = c;
    btn.append(dot, label);
    btn.onclick = () => {
      selectedCellClass = c;
      updateSwatches();
    };
    swatchesContainer.append(btn);
    swatchButtons.push(btn);
  }

  const brushSelect = choice(
    "Brush class",
    "chainCellBrush",
    classes,
    selectedCellClass,
    (v) => {
      selectedCellClass = v;
      updateSwatches();
    },
  );

  swatchRow.append(brushSelect, swatchesContainer);

  const toolsRow = document.createElement("div");
  toolsRow.className = "chain-palette-row";

  const toolGroup = document.createElement("div");
  toolGroup.className = "chain-tool-group";
  const toolDefs: Array<[PaintTool, string, string]> = [
    ["paint", "Paint", "Click or drag to apply the active brush"],
    ["fill", "Fill", "Flood-fill connected cells of matching class"],
    ["rect", "Rect", "Drag a box to fill covered cells"],
    ["segment", "Segments", "Click or drag across boundaries to stamp segment passability"],
  ];
  for (const [t, label, title] of toolDefs) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.tool = t;
    b.textContent = label;
    b.title = title;
    b.classList.toggle("active", t === selectedPaintTool);
    b.onclick = () => {
      selectedPaintTool = t;
      render();
    };
    toolGroup.append(b);
  }

  const patternGroup = document.createElement("div");
  patternGroup.className = "chain-tool-group";
  const patternDefs: Array<
    [string, string, () => Array<{ x: number; y: number }>]
  > = [
    [
      "Perimeter",
      "Outer ring of 20 perimeter cells",
      () => {
        const out: Array<{ x: number; y: number }> = [];
        for (let y = 0; y < CHAIN_TILE_SIZE; y++)
          for (let x = 0; x < CHAIN_TILE_SIZE; x++)
            if (
              x === 0 ||
              y === 0 ||
              x === CHAIN_TILE_SIZE - 1 ||
              y === CHAIN_TILE_SIZE - 1
            )
              out.push({ x, y });
        return out;
      },
    ],
    [
      "Interior",
      "Inner 4 × 4 cells",
      () => {
        const out: Array<{ x: number; y: number }> = [];
        for (let y = 1; y < CHAIN_TILE_SIZE - 1; y++)
          for (let x = 1; x < CHAIN_TILE_SIZE - 1; x++)
            out.push({ x, y });
        return out;
      },
    ],
    [
      "Checker",
      "Alternating cells",
      () => {
        const out: Array<{ x: number; y: number }> = [];
        for (let y = 0; y < CHAIN_TILE_SIZE; y++)
          for (let x = 0; x < CHAIN_TILE_SIZE; x++)
            if ((x + y) % 2 === 0) out.push({ x, y });
        return out;
      },
    ],
    [
      "Fill all",
      "All 36 cells",
      () => {
        const out: Array<{ x: number; y: number }> = [];
        for (let y = 0; y < CHAIN_TILE_SIZE; y++)
          for (let x = 0; x < CHAIN_TILE_SIZE; x++)
            out.push({ x, y });
        return out;
      },
    ],
  ];
  for (const [lbl, title, getCoords] of patternDefs) {
    const pb = document.createElement("button");
    pb.type = "button";
    pb.textContent = lbl;
    pb.title = `${title} with ${selectedCellClass}`;
    pb.onclick = () => {
      setCells(tile, getCoords(), selectedCellClass);
      changed();
    };
    patternButtons.push({ btn: pb, desc: title });
    patternGroup.append(pb);
  }

  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.textContent = "Clear painting";
  clearBtn.title = "Reset all cells to default cell class";
  clearBtn.onclick = () => {
    delete tile.cells;
    delete tile.legend;
    changed();
  };
  patternGroup.append(clearBtn);

  toolsRow.append(toolGroup, patternGroup);

  const segRow = document.createElement("div");
  segRow.className = "chain-palette-row";

  const segBrushGroup = document.createElement("div");
  segBrushGroup.className = "chain-tool-group chain-seg-brushes";
  const segBrushes: Array<[SegmentBrush, string, string, string]> = [
    ["passable", "Passable", "#83d7a4", "Stamp passable crossing guarantee"],
    ["not-passable-hint", "Wall (hint)", "#e2807f", "Stamp prefer occupied hint"],
    ["any", "Any", "repeating-linear-gradient(45deg, #78909d, #78909d 2px, transparent 2px, transparent 4px)", "Stamp written deferred any"],
    ["unstated", "Clear", "#2c464f", "Clear segment passability"],
  ];
  for (const [sb, label, swatch, title] of segBrushes) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.segBrush = sb;
    b.title = title;
    b.classList.toggle("active", selectedSegmentBrush === sb && selectedPaintTool === "segment");
    const dot = document.createElement("span");
    dot.className = "swatch";
    dot.style.background = swatch;
    const lbl = document.createElement("span");
    lbl.textContent = label;
    b.append(dot, lbl);
    b.onclick = () => {
      selectedSegmentBrush = sb;
      selectedPaintTool = "segment";
      render();
    };
    segBrushGroup.append(b);
  }

  const segPatternGroup = document.createElement("div");
  segPatternGroup.className = "chain-tool-group";
  const segPatterns: Array<[string, string, (t: ChainTileDesign) => void]> = [
    [
      "Perim Walls",
      "Set all perimeter segments to wall hint",
      (t) => {
        for (const k of allPerimeterSegments()) {
          applySegmentBrush(t, k, "not-passable-hint");
        }
      },
    ],
    [
      "Perim Passable",
      "Set all perimeter segments to passable",
      (t) => {
        for (const k of allPerimeterSegments()) {
          applySegmentBrush(t, k, "passable");
        }
      },
    ],
    [
      "Perim Any",
      "Set all perimeter segments to any",
      (t) => {
        for (const k of allPerimeterSegments()) {
          applySegmentBrush(t, k, "any");
        }
      },
    ],
    [
      "Clear Segments",
      "Remove all segment prescriptions (both passability and perimeter adjacency)",
      (t) => {
        delete t.segments;
      },
    ],
  ];
  for (const [lbl, title, applyPat] of segPatterns) {
    const pb = document.createElement("button");
    pb.type = "button";
    pb.textContent = lbl;
    pb.title = title;
    pb.onclick = () => {
      applyPat(tile);
      changed();
    };
    segPatternGroup.append(pb);
  }

  segRow.append(segBrushGroup, segPatternGroup);
  palette.append(swatchRow, toolsRow, segRow);

  root.append(
    palette,
    paragraph(
      "Click or drag to apply the active brush · Alt-click to eyedropper sample · Right-click for quick palette · Gutter buttons cover a whole row or column.",
    ),
  );

  const stage = document.createElement("div");
  stage.className = "chain-tile-stage";
  stage.classList.toggle("mode-segment", selectedPaintTool === "segment");

  const colsGutter = document.createElement("div");
  colsGutter.className = "chain-gutter cols";
  for (let x = 0; x < CHAIN_TILE_SIZE; x++) {
    const gb = document.createElement("button");
    gb.type = "button";
    gb.textContent = String(x);
    gb.title = `Paint column ${x} with ${selectedCellClass}`;
    gb.onclick = () => {
      const coords = Array.from({ length: CHAIN_TILE_SIZE }, (_, y) => ({
        x,
        y,
      }));
      setCells(tile, coords, selectedCellClass);
      changed();
    };
    colGutterButtons.push(gb);
    colsGutter.append(gb);
  }

  const rowsGutter = document.createElement("div");
  rowsGutter.className = "chain-gutter rows";
  for (let y = 0; y < CHAIN_TILE_SIZE; y++) {
    const gb = document.createElement("button");
    gb.type = "button";
    gb.textContent = String(y);
    gb.title = `Paint row ${y} with ${selectedCellClass}`;
    gb.onclick = () => {
      const coords = Array.from({ length: CHAIN_TILE_SIZE }, (_, x) => ({
        x,
        y,
      }));
      setCells(tile, coords, selectedCellClass);
      changed();
    };
    rowGutterButtons.push(gb);
    rowsGutter.append(gb);
  }

  const grid = document.createElement("div");
  grid.id = "chainGrid";
  grid.className = "chain-grid";

  const ghost = document.createElement("div");
  ghost.className = "chain-rect-ghost";
  ghost.hidden = true;
  grid.append(ghost);

  const hoverReadout = document.createElement("div");
  hoverReadout.className = "chain-hover-readout";

  const cells = tileCells(tile);
  const cellButtons: Map<string, HTMLButtonElement> = new Map();

  for (let y = 0; y < CHAIN_TILE_SIZE; y++)
    for (let x = 0; x < CHAIN_TILE_SIZE; x++) {
      const cellVal = cells[y * CHAIN_TILE_SIZE + x]!;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "chain-cell";
      button.dataset.cell = `${x},${y}`;
      button.dataset.x = String(x);
      button.dataset.y = String(y);
      button.textContent = cellVal;
      button.style.background = classColor(cellVal);
      button.title = `Cell ${x},${y} · ${cellVal}${cellVal === tile.defaultCellClass ? " (default)" : ""}`;
      cellButtons.set(`${x},${y}`, button);
      grid.append(button);
    }

  const segmentOverlay = document.createElement("div");
  segmentOverlay.id = "chainSegmentOverlay";
  segmentOverlay.className = "chain-segment-overlay";

  const stageSegmentButtons: Map<string, HTMLButtonElement> = new Map();

  const updateStageSegmentButton = (
    btn: HTMLButtonElement,
    key: string,
  ) => {
    const { isPerimeter } = segmentDescriptor(key);
    const p = tile.segments?.[key];
    const passability = p?.passability;
    const adjacency = p?.adjacency;

    btn.className = "chain-stage-segment";
    btn.classList.add(key.startsWith("v") ? "v" : "h");
    if (isPerimeter) btn.classList.add("perimeter");
    else btn.classList.add("interior");

    if (passability === "passable") btn.classList.add("passable");
    else if (passability === "not-passable-hint") btn.classList.add("wall");
    else if (passability === "any") btn.classList.add("any");
    else btn.classList.add("unstated");

    if (selectedSegment === key) btn.classList.add("selected");

    btn.replaceChildren();
    if (isPerimeter && adjacency) {
      const dot = document.createElement("span");
      dot.className = "chain-adj-dot";
      if (adjacency === "any") {
        dot.classList.add("any");
      } else {
        dot.style.background = classColor(adjacency);
      }
      dot.title = `Adjacency: ${adjacency}`;
      btn.append(dot);
    }

    btn.title = segmentTooltip(key, tile);
  };

  for (const axis of ["v", "h"] as const) {
    for (let l = 0; l <= CHAIN_TILE_SIZE; l++) {
      for (let offset = 0; offset < CHAIN_TILE_SIZE; offset++) {
        const key = `${axis}:${l},${offset}`;
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.stageSegment = key;
        button.dataset.axis = axis;
        button.dataset.line = String(l);
        button.dataset.offset = String(offset);

        const linePct = (l / CHAIN_TILE_SIZE) * 100;
        const offsetPct = (offset / CHAIN_TILE_SIZE) * 100;
        const lengthPct = (1 / CHAIN_TILE_SIZE) * 100;

        if (axis === "v") {
          button.style.left = `${linePct}%`;
          button.style.top = `${offsetPct}%`;
          button.style.height = `${lengthPct}%`;
        } else {
          button.style.left = `${offsetPct}%`;
          button.style.top = `${linePct}%`;
          button.style.width = `${lengthPct}%`;
        }

        updateStageSegmentButton(button, key);

        button.addEventListener("pointerenter", () => {
          hoverReadout.textContent = button.title;
        });
        button.addEventListener("pointerleave", () => {
          hoverReadout.textContent = "";
        });

        button.addEventListener("pointerdown", (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          closePopup();
          selectedSegment = key;
          if (selectedPaintTool === "segment") {
            applySegmentBrush(tile, key, selectedSegmentBrush);
            changed();
          } else {
            render();
          }
        });

        button.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          closePopup();
          selectedSegment = key;
          openSegmentPopup(e.clientX, e.clientY, key, tile);
        });

        stageSegmentButtons.set(key, button);
        segmentOverlay.append(button);
      }
    }
  }

  grid.append(segmentOverlay);

  let isDragging = false;
  let lastPaintedCoord: { x: number; y: number } | null = null;
  let lastPointerPos: { x: number; y: number } | null = null;
  let rectStart: { x: number; y: number } | null = null;

  const updateGhost = (x0: number, y0: number, x1: number, y1: number) => {
    const minX = Math.min(x0, x1);
    const maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1);
    const maxY = Math.max(y0, y1);
    ghost.style.left = `${(minX / CHAIN_TILE_SIZE) * 100}%`;
    ghost.style.top = `${(minY / CHAIN_TILE_SIZE) * 100}%`;
    ghost.style.width = `${((maxX - minX + 1) / CHAIN_TILE_SIZE) * 100}%`;
    ghost.style.height = `${((maxY - minY + 1) / CHAIN_TILE_SIZE) * 100}%`;
    ghost.hidden = false;
  };

  const getCellCoords = (
    e: PointerEvent | MouseEvent,
  ): { x: number; y: number } | null => {
    const target = (e.target as HTMLElement | null)?.closest?.(
      "[data-cell]",
    ) as HTMLElement | null;
    if (target?.dataset.cell) {
      const [cx, cy] = target.dataset.cell.split(",").map(Number);
      if (cx !== undefined && cy !== undefined) return { x: cx, y: cy };
    }
    const r = grid.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    const u = Math.floor(
      ((e.clientX - r.left) / r.width) * CHAIN_TILE_SIZE,
    );
    const v = Math.floor(
      ((e.clientY - r.top) / r.height) * CHAIN_TILE_SIZE,
    );
    if (u >= 0 && u < CHAIN_TILE_SIZE && v >= 0 && v < CHAIN_TILE_SIZE) {
      return { x: u, y: v };
    }
    return null;
  };

  const paintSingleCell = (x: number, y: number) => {
    cells[y * CHAIN_TILE_SIZE + x] = selectedCellClass;
    const btn = cellButtons.get(`${x},${y}`);
    if (btn) {
      btn.textContent = selectedCellClass;
      btn.style.background = classColor(selectedCellClass);
      btn.title = `Cell ${x},${y} · ${selectedCellClass}${selectedCellClass === tile.defaultCellClass ? " (default)" : ""}`;
    }
  };

  grid.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    closePopup();

    if (selectedPaintTool === "segment") {
      e.preventDefault();
      isDragging = true;
      lastPointerPos = { x: e.clientX, y: e.clientY };
      const segKey = getNearestSegment(grid, e.clientX, e.clientY);
      if (segKey) {
        selectedSegment = segKey;
        applySegmentBrush(tile, segKey, selectedSegmentBrush);
        const btn = stageSegmentButtons.get(segKey);
        if (btn) updateStageSegmentButton(btn, segKey);
      }
      try {
        grid.setPointerCapture(e.pointerId);
      } catch {
        /* pointer capture optional */
      }
      return;
    }

    const coords = getCellCoords(e);
    if (!coords) return;
    const { x, y } = coords;

    if (e.altKey) {
      e.preventDefault();
      const sampled = cells[y * CHAIN_TILE_SIZE + x]!;
      selectedCellClass = sampled;
      updateSwatches();
      return;
    }

    if (selectedPaintTool === "fill") {
      e.preventDefault();
      floodFill(tile, x, y, selectedCellClass);
      changed();
      return;
    }

    if (selectedPaintTool === "rect") {
      e.preventDefault();
      isDragging = true;
      rectStart = { x, y };
      updateGhost(x, y, x, y);
      try {
        grid.setPointerCapture(e.pointerId);
      } catch {
        /* pointer capture optional */
      }
      return;
    }

    if (selectedPaintTool === "paint") {
      e.preventDefault();
      isDragging = true;
      lastPaintedCoord = { x, y };
      paintSingleCell(x, y);
      setCell(tile, x, y, selectedCellClass);
      try {
        grid.setPointerCapture(e.pointerId);
      } catch {
        /* pointer capture optional */
      }
    }
  });

  grid.addEventListener("pointermove", (e) => {
    if (selectedPaintTool === "segment") {
      const segKey = getNearestSegment(grid, e.clientX, e.clientY);
      if (segKey) {
        hoverReadout.textContent = segmentTooltip(segKey, tile);
      } else {
        hoverReadout.textContent = "";
      }
      if (!isDragging || !lastPointerPos) return;
      const dx = e.clientX - lastPointerPos.x;
      const dy = e.clientY - lastPointerPos.y;
      const dist = Math.hypot(dx, dy);
      const steps = Math.max(1, Math.ceil(dist / 8));
      for (let s = 1; s <= steps; s++) {
        const px = lastPointerPos.x + (dx * s) / steps;
        const py = lastPointerPos.y + (dy * s) / steps;
        const hitKey = getNearestSegment(grid, px, py);
        if (hitKey) {
          applySegmentBrush(tile, hitKey, selectedSegmentBrush);
          selectedSegment = hitKey;
          const btn = stageSegmentButtons.get(hitKey);
          if (btn) updateStageSegmentButton(btn, hitKey);
        }
      }
      lastPointerPos = { x: e.clientX, y: e.clientY };
      return;
    }

    const coords = getCellCoords(e);
    if (coords) {
      const { x, y } = coords;
      const cur = cells[y * CHAIN_TILE_SIZE + x] ?? tile.defaultCellClass;
      hoverReadout.textContent = `Cell ${x},${y} · ${cur}${cur === tile.defaultCellClass ? " (default)" : ""}`;
    } else {
      hoverReadout.textContent = "";
    }

    if (!isDragging) return;

    if (selectedPaintTool === "rect" && rectStart && coords) {
      updateGhost(rectStart.x, rectStart.y, coords.x, coords.y);
      return;
    }

    if (selectedPaintTool === "paint" && coords && lastPaintedCoord) {
      if (coords.x !== lastPaintedCoord.x || coords.y !== lastPaintedCoord.y) {
        const line = plotLine(
          lastPaintedCoord.x,
          lastPaintedCoord.y,
          coords.x,
          coords.y,
        );
        for (const pt of line) {
          paintSingleCell(pt.x, pt.y);
          setCell(tile, pt.x, pt.y, selectedCellClass);
        }
        lastPaintedCoord = { x: coords.x, y: coords.y };
      }
    }
  });

  const onPointerEnd = (e: PointerEvent) => {
    if (!isDragging) return;

    if (selectedPaintTool === "segment") {
      isDragging = false;
      lastPointerPos = null;
      try {
        grid.releasePointerCapture(e.pointerId);
      } catch {
        /* release optional */
      }
      changed();
      return;
    }

    if (selectedPaintTool === "rect" && rectStart) {
      const coords = getCellCoords(e) ?? rectStart;
      const minX = Math.min(rectStart.x, coords.x);
      const maxX = Math.max(rectStart.x, coords.x);
      const minY = Math.min(rectStart.y, coords.y);
      const maxY = Math.max(rectStart.y, coords.y);
      const toPaint: Array<{ x: number; y: number }> = [];
      for (let cy = minY; cy <= maxY; cy++) {
        for (let cx = minX; cx <= maxX; cx++) {
          toPaint.push({ x: cx, y: cy });
        }
      }
      setCells(tile, toPaint, selectedCellClass);
      ghost.hidden = true;
      rectStart = null;
      isDragging = false;
      try {
        grid.releasePointerCapture(e.pointerId);
      } catch {
        /* release optional */
      }
      changed();
      return;
    }

    if (selectedPaintTool === "paint") {
      isDragging = false;
      lastPaintedCoord = null;
      try {
        grid.releasePointerCapture(e.pointerId);
      } catch {
        /* release optional */
      }
      changed();
    }
  };

  grid.addEventListener("pointerup", onPointerEnd);
  grid.addEventListener("pointercancel", onPointerEnd);
  grid.addEventListener("pointerleave", () => {
    hoverReadout.textContent = "";
  });

  grid.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    closePopup();
    const coords = getCellCoords(e);
    if (!coords) return;
    const { x, y } = coords;
    const currentClass = cells[y * CHAIN_TILE_SIZE + x]!;

    const popup = document.createElement("div");
    popup.className = "chain-popup";
    popup.style.left = `${e.clientX + 4}px`;
    popup.style.top = `${e.clientY + 4}px`;

    const title = document.createElement("h4");
    title.textContent = `Cell ${x},${y} (${currentClass})`;
    popup.append(title);

    const pickBtn = document.createElement("button");
    pickBtn.type = "button";
    pickBtn.textContent = `Pick up "${currentClass}"`;
    pickBtn.onclick = () => {
      selectedCellClass = currentClass;
      updateSwatches();
      closePopup();
    };
    popup.append(pickBtn, document.createElement("hr"));

    const swatchContainer = document.createElement("div");
    swatchContainer.className = "row";
    for (const c of classes) {
      const b = document.createElement("button");
      b.type = "button";
      b.classList.toggle("active", c === currentClass);
      const dot = document.createElement("span");
      dot.className = "swatch";
      dot.style.background = classColor(c);
      const span = document.createElement("span");
      span.textContent = c;
      b.append(dot, span);
      b.onclick = () => {
        selectedCellClass = c;
        setCell(tile, x, y, c);
        closePopup();
        changed();
      };
      swatchContainer.append(b);
    }
    popup.append(swatchContainer, document.createElement("hr"));

    const fillRowBtn = document.createElement("button");
    fillRowBtn.type = "button";
    fillRowBtn.textContent = `Fill row ${y} with ${selectedCellClass}`;
    fillRowBtn.onclick = () => {
      const rowCoords = Array.from(
        { length: CHAIN_TILE_SIZE },
        (_, cx) => ({ x: cx, y }),
      );
      setCells(tile, rowCoords, selectedCellClass);
      closePopup();
      changed();
    };

    const fillColBtn = document.createElement("button");
    fillColBtn.type = "button";
    fillColBtn.textContent = `Fill col ${x} with ${selectedCellClass}`;
    fillColBtn.onclick = () => {
      const colCoords = Array.from(
        { length: CHAIN_TILE_SIZE },
        (_, cy) => ({ x, y: cy }),
      );
      setCells(tile, colCoords, selectedCellClass);
      closePopup();
      changed();
    };

    popup.append(fillRowBtn, fillColBtn);
    document.body.append(popup);
    activePopup = popup;

    popupDismissListener = (evt: MouseEvent) => {
      if (!popup.contains(evt.target as Node)) {
        closePopup();
      }
    };
    setTimeout(() => {
      if (popupDismissListener) {
        document.addEventListener("pointerdown", popupDismissListener);
      }
    }, 0);
  });

  stage.append(colsGutter, rowsGutter, grid);
  root.append(
    stage,
    hoverReadout,
    heading("Segment prescriptions"),
    paragraph(
      "Select any interior or perimeter segment on stage or in the list. Adjacency is available only on the perimeter. Written any remains distinct from an unstated field.",
    ),
  );
  const segments = document.createElement("div");
  segments.id = "chainSegments";
  segments.className = "chain-segments";
  for (const axis of ["v", "h"] as const)
    for (let l = 0; l <= CHAIN_TILE_SIZE; l++)
      for (let offset = 0; offset < CHAIN_TILE_SIZE; offset++) {
        const key = `${axis}:${l},${offset}`;
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.segment = key;
        button.textContent = key;
        button.classList.toggle("active", selectedSegment === key);
        button.classList.toggle("stated", !!tile.segments?.[key]);
        button.onclick = () => {
          selectedSegment = key;
          render();
        };
        segments.append(button);
      }
  root.append(segments);
  const prescription = tile.segments?.[selectedSegment] ?? {};
  const { isPerimeter: perimeter } = segmentDescriptor(selectedSegment);
  const controls = document.createElement("div");
  controls.className = "chain-segment-controls";
  const set = (dimension: keyof SegmentPrescription, value: string) => {
    setSegmentProp(
      tile,
      selectedSegment,
      dimension as "adjacency" | "passability",
      value || undefined,
    );
    changed();
  };
  const titleP = paragraph(`Selected ${selectedSegment}`);
  const badge = document.createElement("span");
  badge.className = `chain-badge ${perimeter ? "perimeter" : "interior"}`;
  badge.textContent = perimeter
    ? "Perimeter (adjacency & passability)"
    : "Interior (passability only)";
  titleP.append(badge);
  controls.append(titleP);

  if (perimeter)
    controls.append(
      choice(
        "Across-tile adjacency",
        "chainSegmentAdjacency",
        ["", "any", ...Object.keys(library.cellClasses)],
        prescription.adjacency ?? "",
        (v) => set("adjacency", v),
      ),
    );
  controls.append(
    choice(
      "Passability",
      "chainSegmentPassability",
      ["", "any", "passable", "not-passable-hint"],
      prescription.passability ?? "",
      (v) => set("passability", v),
      { "not-passable-hint": "Prefer occupied (hint)" },
    ),
    paragraph(
      "Passable guarantees a crossing. Any is a written don't-care statement; two facing any statements guarantee a crossing. Prefer occupied is optional architectural guidance, never an impassability requirement. A facing passable statement still guarantees a crossing; any facing this hint does not. Unspecified stays distinct from any. Open span / aperture geometry is deferred to micro/region strategies in chain v3 (docs 20.2, 52).",
    ),
  );
  root.append(controls);
  renderPreview(tile);
}
function renderPreview(tile: ChainTileDesign): void {
  const box = $("chainPreview");
  box.replaceChildren(heading("Derived portal preview"));
  box.append(
    paragraph(
      `Tile-local view at orientation 0°. A portal must be straight and at least ${MIN_PORTAL_LENGTH} segments long. Perimeter statements are provisional until neighbors settle, and may extend or resolve an any cell.`,
    ),
  );
  try {
    const design = orientDesign(tile, 0);
    const cells = design.cells.map((id) => (id === "any" ? "open" : id));
    const segments: ResolvedLayout["segments"] = {};
    const sameClass: string[] = [],
      perimeter: string[] = [];
    for (const [key, prescription] of design.segments) {
      if (prescription.passability !== "passable" && prescription.passability !== "any") continue;
      const [axis, coord] = key.split(":");
      const [x, y] = coord!.split(",").map(Number);
      const edge =
        axis === "v"
          ? x === 0 || x === CHAIN_TILE_SIZE
          : y === 0 || y === CHAIN_TILE_SIZE;
      if (edge) {
        perimeter.push(key);
        continue;
      }
      const first =
        axis === "v"
          ? cells[y! * CHAIN_TILE_SIZE + x! - 1]
          : cells[(y! - 1) * CHAIN_TILE_SIZE + x!];
      const second = cells[y! * CHAIN_TILE_SIZE + x!];
      if (first === second) sameClass.push(key);
      segments[key] = {
        guarantee: "guaranteed",
        stated: [prescription.passability, prescription.passability],
      };
    }
    const resolved = {
      width: CHAIN_TILE_SIZE,
      height: CHAIN_TILE_SIZE,
      cells,
      segments,
    } as ResolvedLayout;
    const found = regions(resolved, "chain-author-preview");
    const list = document.createElement("ul");
    for (const portal of found.portals) {
      const item = document.createElement("li");
      item.textContent = `${portal.axis}:${portal.x},${portal.y} · ${portal.length} segment${portal.length === 1 ? "" : "s"} · ${portal.a} ↔ ${portal.b}`;
      list.append(item);
    }
    box.append(
      paragraph(
        `${found.portals.length} tile-local portal${found.portals.length === 1 ? "" : "s"} derived.`,
      ),
      list,
    );
    const rightAngles: string[] = [];
    for (let i = 0; i < found.portals.length; i++)
      for (let j = i + 1; j < found.portals.length; j++) {
        const a = found.portals[i]!,
          b = found.portals[j]!;
        if (
          a.axis === b.axis ||
          a.length >= MIN_PORTAL_LENGTH ||
          b.length >= MIN_PORTAL_LENGTH
        )
          continue;
        const ends = (p: typeof a): string[] =>
          p.axis === "h"
            ? [`${p.x},${p.y}`, `${p.x + p.length},${p.y}`]
            : [`${p.x},${p.y}`, `${p.x},${p.y + p.length}`];
        if (ends(a).some((point) => ends(b).includes(point)))
          rightAngles.push(
            `${a.axis}:${a.x},${a.y} and ${b.axis}:${b.x},${b.y} meet at a right angle; they remain separate short portals.`,
          );
      }
    const warnings = [
      ...portalViolations(found),
      ...rightAngles,
      ...sameClass.map(
        (key) =>
          `${key}: passable prescription has the same region class on both sides; it forms no portal.`,
      ),
      ...perimeter.map(
        (key) =>
          `${key}: perimeter passability is provisional; adjacent tile and full layout determine its portal.`,
      ),
    ];
    if (warnings.length) {
      const issues = document.createElement("ul");
      issues.className = "chain-warnings";
      for (const warning of warnings) {
        const item = document.createElement("li");
        item.textContent = warning;
        issues.append(item);
      }
      box.append(issues);
    }
  } catch (error) {
    box.append(paragraph(`Preview unavailable: ${String(error)}`));
  }
}
let tileSetFilter = "";

function renderTileSets(root: HTMLElement): void {
  const entry = current() as ChainLibrary["tileSets"][number];
  if (!entry) return;

  const container = document.createElement("div");
  container.className = "chain-sets-container";

  container.append(
    paragraph(
      "Click tiles in the Available list to add them, or click tiles in the Members list to remove them.",
    ),
  );

  // Members section
  const membersSection = document.createElement("div");
  membersSection.className = "chain-sets-section";

  const membersHead = document.createElement("div");
  membersHead.className = "chain-sets-section-head";
  const membersTitle = document.createElement("h4");
  membersTitle.id = "setMembersTitle";
  membersTitle.textContent = `Members (${entry.members.length})`;
  membersHead.append(membersTitle);

  const membersGallery = document.createElement("div");
  membersGallery.id = "setMembersGallery";
  membersGallery.className = "chain-gallery-grid";
  membersGallery.setAttribute("aria-label", "Tiles in this set");

  membersSection.append(membersHead, membersGallery);

  // Available section
  const availableSection = document.createElement("div");
  availableSection.className = "chain-sets-section";

  const availableHead = document.createElement("div");
  availableHead.className = "chain-sets-section-head";
  const availableTitle = document.createElement("h4");
  availableTitle.textContent = "Available Tiles";

  const filterWrap = document.createElement("label");
  filterWrap.className = "grow";
  const filterInput = document.createElement("input");
  filterInput.id = "setAvailableFilter";
  filterInput.placeholder = "filter by ID, class, or label...";
  filterInput.spellcheck = false;
  filterInput.value = tileSetFilter;
  filterWrap.append(filterInput);

  availableHead.append(availableTitle, filterWrap);

  const availableGallery = document.createElement("div");
  availableGallery.id = "setAvailableGallery";
  availableGallery.className = "chain-gallery-grid";
  availableGallery.setAttribute("aria-label", "Available tiles");

  availableSection.append(availableHead, availableGallery);

  container.append(membersSection, availableSection);
  root.append(container);

  function populateMembers(): void {
    membersTitle.textContent = `Members (${entry.members.length})`;
    if (!entry.members.length) {
      const empty = document.createElement("p");
      empty.className = "gallery-empty";
      empty.textContent =
        "No tiles in this set. Chain validation requires at least one member.";
      membersGallery.replaceChildren(empty);
      return;
    }

    const cards = entry.members.map((memberId) => {
      const tile = library.tiles.find((t) => t.id === memberId);
      const card = document.createElement("button");
      card.type = "button";
      card.className = "tile-card member-card";
      card.dataset.tile = memberId;
      card.title = `Click to remove "${memberId}" from set`;

      const name = document.createElement("span");
      name.className = "tile-card-name";
      name.textContent = memberId;

      if (tile) {
        card.append(tileThumbnail(tile), name);
      } else {
        const placeholder = document.createElement("figure");
        placeholder.className = "orphan-thumbnail";
        card.append(placeholder, name);
      }

      card.onclick = () => {
        if (entry.members.length <= 1) {
          status(`Tile set "${entry.id}" must have at least one member to remain valid.`);
          return;
        }
        entry.members = entry.members.filter((id) => id !== memberId);
        changed();
      };
      return card;
    });

    membersGallery.replaceChildren(...cards);
  }

  function populateAvailable(): void {
    const inSet = new Set(entry.members);
    const available = library.tiles.filter((t) => !inSet.has(t.id));
    const filter = tileSetFilter.trim().toLowerCase();

    if (!available.length) {
      const empty = document.createElement("p");
      empty.className = "gallery-empty";
      empty.textContent = "All library tiles are members of this set.";
      availableGallery.replaceChildren(empty);
      return;
    }

    const matching = available.filter((t) => {
      if (!filter) return true;
      if (t.id.toLowerCase().includes(filter)) return true;
      if (t.defaultCellClass.toLowerCase().includes(filter)) return true;
      if (t.labels?.some((l) => l.toLowerCase().includes(filter))) return true;
      if (
        Object.values(t.legend ?? {}).some((c) =>
          c.toLowerCase().includes(filter),
        )
      )
        return true;
      return false;
    });

    if (!matching.length) {
      const empty = document.createElement("p");
      empty.className = "gallery-empty";
      empty.textContent = `No available tiles match "${tileSetFilter}".`;
      availableGallery.replaceChildren(empty);
      return;
    }

    const cards = matching.map((t) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "tile-card available-card";
      card.dataset.tile = t.id;
      card.title = `Click to add "${t.id}" to set`;

      const name = document.createElement("span");
      name.className = "tile-card-name";
      name.textContent = t.id;

      card.append(tileThumbnail(t), name);

      card.onclick = () => {
        if (!entry.members.includes(t.id)) {
          entry.members.push(t.id);
          changed();
        }
      };
      return card;
    });

    availableGallery.replaceChildren(...cards);
  }

  filterInput.oninput = () => {
    tileSetFilter = filterInput.value;
    populateAvailable();
  };

  populateMembers();
  populateAvailable();
}
function slotEditor(
  slot: ChainSetPieceSlot,
  index: number,
  slots: ChainSetPieceSlot[],
): HTMLElement {
  const row = document.createElement("div");
  row.className = "chain-slot";
  row.append(
    field(
      "dx",
      `chainSlotX${index}`,
      slot.dx,
      (v) => {
        slot.dx = Number(v);
      },
      "number",
    ),
    field(
      "dy",
      `chainSlotY${index}`,
      slot.dy,
      (v) => {
        slot.dy = Number(v);
      },
      "number",
    ),
    choice(
      "Tile set",
      `chainSlotSet${index}`,
      library.tileSets.map((s) => s.id),
      slot.tileSetId,
      (v) => {
        slot.tileSetId = v;
      },
    ),
    choice(
      "Orientation",
      `chainSlotOrientation${index}`,
      ["", "0", "90", "180", "270"],
      slot.orientation === undefined ? "" : String(slot.orientation),
      (v) => {
        if (v) slot.orientation = Number(v);
        else delete slot.orientation;
      },
    ),
  );
  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "Remove slot";
  remove.onclick = () => {
    slots.splice(index, 1);
    changed();
  };
  row.append(remove);
  return row;
}
function renderSetPieces(root: HTMLElement): void {
  const piece = current() as ChainLibrary["setPieces"][number];
  if (!piece) return;
  root.append(
    choice(
      "Primary region class (editor hint)",
      "chainPrimaryClass",
      ["", ...Object.keys(library.cellClasses)],
      piece.primaryRegionClass ?? "",
      (v) => {
        if (v) piece.primaryRegionClass = v;
        else delete piece.primaryRegionClass;
      },
    ),
    field(
      "Eligible tiers (blank = all)",
      "chainPieceTiers",
      (piece.eligibleTiers ?? []).join(", "),
      (v) => {
        if (v.trim()) piece.eligibleTiers = numberList(v);
        else delete piece.eligibleTiers;
      },
    ),
    heading("Slots"),
  );
  piece.tiles.forEach((slot, index) =>
    root.append(slotEditor(slot, index, piece.tiles)),
  );
  const add = document.createElement("button");
  add.type = "button";
  add.textContent = "Add slot";
  add.onclick = () => {
    piece.tiles.push({
      dx: piece.tiles.length,
      dy: 0,
      tileSetId: library.tileSets[0]?.id ?? "",
    });
    changed();
  };
  root.append(add);
}
function renderSetPieceClasses(root: HTMLElement): void {
  const group = current() as ChainLibrary["setPieceClasses"][number];
  if (!group) return;
  root.append(
    choice(
      "Placement rule",
      "chainPlacementRule",
      ["start", "end", "enormous", "medium", "small", "charger"],
      group.placementRule,
      (v) => {
        group.placementRule = v as typeof group.placementRule;
      },
    ),
    field(
      "Quota",
      "chainQuota",
      group.quota,
      (v) => {
        group.quota = Number(v);
      },
      "number",
    ),
    heading("Set pieces"),
  );
  for (const piece of library.setPieces) {
    const label = document.createElement("label");
    label.className = "chain-check";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = group.setPieces.includes(piece.id);
    input.onchange = () => {
      group.setPieces = input.checked
        ? [...group.setPieces, piece.id]
        : group.setPieces.filter((id) => id !== piece.id);
      changed();
    };
    label.append(input, piece.id);
    root.append(label);
  }
  root.append(coreFields(group));
}
function status(prefix = ""): void {
  const result = validateLibrary(library, declaredRegionTypeIds(library));
  $("chainStatus").textContent =
    `${prefix ? `${prefix}\n` : ""}${result.valid ? "Library valid for declared region type IDs. Strategy availability is not checked." : `${result.errors.length} validation issue(s):\n${result.errors.join("\n")}`}`;
  $("chainStatus").classList.toggle("invalid", !result.valid);
}
function changed(): void {
  savedDraftWarning = "";
  try {
    localStorage.setItem(KEY, JSON.stringify(library));
  } catch {
    /* storage is optional */
  }
  render();
}
function render(): void {
  closePopup();
  const names = entries();
  if (!names.includes(selectedId)) selectedId = names[0] ?? "";
  select("chainItem").replaceChildren(...names.map((id) => option(id)));
  select("chainItem").value = selectedId;
  renderGallery();
  const editor = $("chainEditor");
  editor.replaceChildren();
  $("chainPreview").replaceChildren();
  if (!selectedId) editor.append(paragraph("Add an entry to this section."));
  else {
    editor.append(
      heading(selectedId),
      field("ID", "chainId", selectedId, rename),
    );
    if (section() === "classes") renderClasses(editor);
    if (section() === "tiles") renderTiles(editor);
    if (section() === "tileSets") renderTileSets(editor);
    if (section() === "setPieces") renderSetPieces(editor);
    if (section() === "setPieceClasses") renderSetPieceClasses(editor);
  }
  area("chainSource").value = JSON.stringify(library, null, 2);
  status(savedDraftWarning);
}
function add(): void {
  const base =
    section() === "classes"
      ? "new-class"
      : section() === "tiles"
        ? "new-tile"
        : section() === "tileSets"
          ? "new-set"
          : section() === "setPieces"
            ? "new-piece"
            : "new-piece-class";
  let id = base,
    n = 2;
  while (entries().includes(id)) id = `${base}-${n++}`;
  if (section() === "classes") library.cellClasses[id] = { regionType: id };
  if (section() === "tiles")
    library.tiles.push({
      id,
      defaultCellClass: Object.keys(library.cellClasses)[0] ?? "any",
      orientations: [0],
    });
  if (section() === "tileSets")
    library.tileSets.push({
      id,
      members: library.tiles[0] ? [library.tiles[0].id] : [],
    });
  if (section() === "setPieces")
    library.setPieces.push({
      id,
      tiles: library.tileSets[0]
        ? [{ dx: 0, dy: 0, tileSetId: library.tileSets[0].id }]
        : [],
    });
  if (section() === "setPieceClasses")
    library.setPieceClasses.push({
      id,
      placementRule: "small",
      quota: 1,
      setPieces: library.setPieces[0] ? [library.setPieces[0].id] : [],
    });
  selectedId = id;
  changed();
}
function uniqueId(base: string, exists: (id: string) => boolean): string {
  let n = 1;
  while (exists(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

function clone(): void {
  if (!selectedId) return;
  if (section() === "classes") {
    const found = library.cellClasses[selectedId];
    if (!found) return;
    const copy = structuredClone(found);
    const newId = uniqueId(selectedId, (id) => id in library.cellClasses);
    copy.regionType = newId;
    library.cellClasses[newId] = copy;
    selectedId = newId;
    changed();
    return;
  }
  const items = list();
  const found = items.find((t) => t.id === selectedId);
  if (!found) return;
  const copy = structuredClone(found);
  copy.id = uniqueId(copy.id, (id) => items.some((t) => t.id === id));
  items.push(copy);
  selectedId = copy.id;
  changed();
}
function remove(): void {
  if (!selectedId) return;
  if (section() === "tiles") {
    const setsUsing = library.tileSets
      .filter((s) => s.members.includes(selectedId))
      .map((s) => s.id);
    const msg = setsUsing.length
      ? `Delete tile design "${selectedId}"? It is referenced in tile set(s): ${setsUsing.join(", ")}.`
      : `Delete tile design "${selectedId}"?`;
    if (!confirm(msg)) return;
  }
  if (section() === "tileSets") {
    const piecesUsing = library.setPieces
      .filter((p) => p.tiles.some((t) => t.tileSetId === selectedId))
      .map((p) => p.id);
    const msg = piecesUsing.length
      ? `Delete tile set "${selectedId}"? It is referenced in set piece(s): ${piecesUsing.join(", ")}. Referencing slot(s) will be removed automatically.`
      : `Delete tile set "${selectedId}"?`;
    if (!confirm(msg)) return;
    for (const piece of library.setPieces)
      piece.tiles = piece.tiles.filter((t) => t.tileSetId !== selectedId);
  }
  if (section() === "classes") delete library.cellClasses[selectedId];
  else {
    const items = list();
    items.splice(
      items.findIndex((entry) => entry.id === selectedId),
      1,
    );
  }
  selectedId = "";
  changed();
}
function accept(raw: unknown): void {
  const result = validateLibrary(raw, declaredRegionTypeIds(raw));
  if (!result.valid) throw Error(result.errors.join("\n"));
  library = raw as ChainLibrary;
  selectedId = "";
  changed();
}
function download(): void {
  const result = validateLibrary(library, declaredRegionTypeIds(library));
  if (!result.valid) {
    status("Export refused: fix validation issues first.");
    return;
  }
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(library, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "last-exit-chain-library-v3.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
select("chainSection").onchange = () => {
  selectedId = "";
  render();
};
select("chainItem").onchange = () => {
  selectedId = select("chainItem").value;
  render();
};
$("chainAdd").onclick = add;
$("chainClone").onclick = clone;
$("cloneTemplate").onclick = clone;
$("chainDelete").onclick = remove;
$("tileFilter").addEventListener("input", () => renderGallery());
$("chainExport").onclick = download;
$("chainApply").onclick = () => {
  try {
    accept(JSON.parse(area("chainSource").value));
  } catch (error) {
    status(`Import refused: ${String(error)}`);
  }
};
$("chainImport").addEventListener("change", async (event) => {
  try {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) accept(JSON.parse(await file.text()));
  } catch (error) {
    status(`Import refused: ${String(error)}`);
  }
});
declare global {
  interface Window {
    chainLab: { snapshot: () => unknown };
  }
}
/** The draft being authored, for the World tab to generate from. */
export function chainDraft(): ChainLibrary {
  return structuredClone(library);
}
/** Draw the tab; the lab calls it when the tab is shown. */
export { render as renderChainLibrary };
/**
 * Select a tile design or set piece of `source`, the library a World tab map was made from,
 * for editing. Where the draft's entry differs or is missing, the draft is replaced with
 * `source` only if the author agrees, since the draft may hold unexported work.
 */
export function openChainEntry(source: ChainLibrary, kind: "tiles" | "setPieces", id: string): void {
  const wanted = (source[kind] as Array<{ id: string }>).find((entry) => entry.id === id);
  const held = (library[kind] as Array<{ id: string }>).find((entry) => entry.id === id);
  select("chainSection").value = kind;
  if (wanted && JSON.stringify(held) !== JSON.stringify(wanted)) {
    const noun = kind === "tiles" ? "tile design" : "set piece";
    const question = held
      ? `The Chain Library draft's ${noun} ${id} differs from the map's. Replace the draft with the map's library?`
      : `The Chain Library draft has no ${noun} ${id}. Replace the draft with the map's library?`;
    if (!confirm(question)) {
      selectedId = held ? id : "";
      render();
      status(held ? `Showing the draft's ${noun} ${id}, not the map's.` : `The draft has no ${noun} ${id}.`);
      return;
    }
    library = structuredClone(source);
  }
  selectedId = id;
  changed();
}
/** The bundled library for the World tab's zone size, or the default one where none is authored. */
$("chainLoadBundled").onclick = () => {
  const width = Number(($("zoneWidth") as HTMLInputElement).value), height = Number(($("zoneHeight") as HTMLInputElement).value);
  accept(structuredClone(CHAIN_LIBRARIES.find((l) => l.zoneWidth === width && l.zoneHeight === height) ?? CHAIN_LIBRARY));
};
window.chainLab = Object.freeze({
  snapshot: () => ({
    library: structuredClone(library),
    valid: validateLibrary(library, declaredRegionTypeIds(library)).valid,
    section: section(),
    selectedId,
    portalText: $("chainPreview").textContent,
  }),
});
render();
