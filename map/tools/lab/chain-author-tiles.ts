/** Tile painting, segment editing, thumbnails and portal previews. */
import { CHAIN_TILE_SIZE } from "../../macro/src/chain/library.ts";
import type { ChainTileDesign, PassabilityPrescription, SegmentPrescription } from "../../macro/src/chain/library.ts";
import { orientDesign } from "../../macro/src/chain/declared-grid.ts";
import { regions, portalViolations } from "../../macro/src/chain/regions.ts";
import type { ResolvedLayout } from "../../macro/src/chain/types.ts";
import { MIN_PORTAL_LENGTH } from "../../kernel/scale.ts";
import {
  state, $, section, current, field, choice, heading, paragraph, csv, numberList,
  changed, edited, closePopup, showPopup, dismissPopupOutside, tileMatches, render,
  type PaintTool, type SegmentBrush,
} from "./chain-author-shared.ts";
function hash(s: unknown): number {
  return [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 0);
}
export function classColor(name: string): string {
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

    const adjChoices = ["", "any", ...Object.keys(state.library.cellClasses)];
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

  showPopup(popup, clientX, clientY);

  dismissPopupOutside(popup);
}
export function tileCells(tile: ChainTileDesign): string[] {
  const oriented = orientDesign(tile, 0);
  return oriented.cells;
}
export function tileThumbnail(t: ChainTileDesign): HTMLElement {
  const figure = document.createElement("figure");
  figure.className = "tile-thumb";
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

export function renderGallery(): void {
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

  const shown = state.library.tiles.filter((t) => tileMatches(t, filter));

  if (!shown.length) {
    const empty = document.createElement("p");
    empty.className = "gallery-empty";
    empty.textContent = `No tile matches "${filter}".`;
    gallery.replaceChildren(empty);
    return;
  }

  const cards = shown.map(galleryCard);
  if (cards.length !== gallery.children.length || cards.some((card, i) => gallery.children[i] !== card))
    gallery.replaceChildren(...cards);
}
/** Each tile's gallery card, kept while what its thumbnail draws is unchanged. */
const galleryCards = new WeakMap<ChainTileDesign, { drawn: string; card: HTMLButtonElement }>();
function galleryCard(t: ChainTileDesign): HTMLButtonElement {
  let held = galleryCards.get(t);
  if (!held) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "tile-card";
    const name = document.createElement("span");
    name.className = "tile-card-name";
    card.append(document.createElement("figure"), name);
    card.onclick = () => {
      state.selectedId = t.id;
      render();
    };
    held = { drawn: "", card };
    galleryCards.set(t, held);
  }
  const { card } = held;
  const drawn = JSON.stringify([t.defaultCellClass, t.cells, t.legend, t.segments]);
  if (held.drawn !== drawn) {
    card.firstElementChild!.replaceWith(tileThumbnail(t));
    held.drawn = drawn;
  }
  card.dataset.tile = t.id;
  card.classList.toggle("active", t.id === state.selectedId);
  card.title = `${t.id} · default ${t.defaultCellClass}${t.labels?.length ? ` · [${t.labels.join(", ")}]` : ""}`;
  card.lastElementChild!.textContent = t.id;
  return card;
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
export function renderTiles(properties: HTMLElement, root: HTMLElement): void {
  const tile = current() as ChainTileDesign;
  if (!tile) return;
  const classes = ["any", ...Object.keys(state.library.cellClasses)];
  if (!classes.includes(state.selectedCellClass)) state.selectedCellClass = classes[0]!;
  properties.append(
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
      edited();
    };
    label.append(input, `${angle}°`);
    orientations.append(label);
  }
  properties.append(
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
  // `fillable: false` leaves the tile to set pieces; absent means fillable (17.2.2, #849).
  const fillable = document.createElement("label");
  fillable.className = "chain-checks";
  const fillableInput = document.createElement("input");
  fillableInput.type = "checkbox";
  fillableInput.id = "chainFillable";
  fillableInput.checked = tile.fillable !== false;
  fillableInput.onchange = () => {
    if (fillableInput.checked) delete tile.fillable;
    else tile.fillable = false;
    edited();
  };
  fillable.append(fillableInput, "Fillable (the fill may place it; unchecked leaves it to set pieces)");
  properties.append(fillable);
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
      btn.classList.toggle("active", btn.dataset.class === state.selectedCellClass);
    }
    const selectEl = document.getElementById(
      "chainCellBrush",
    ) as HTMLSelectElement | null;
    if (selectEl && selectEl.value !== state.selectedCellClass) {
      selectEl.value = state.selectedCellClass;
    }
    for (let x = 0; x < colGutterButtons.length; x++) {
      colGutterButtons[x]!.title = `Paint column ${x} with ${state.selectedCellClass}`;
    }
    for (let y = 0; y < rowGutterButtons.length; y++) {
      rowGutterButtons[y]!.title = `Paint row ${y} with ${state.selectedCellClass}`;
    }
    for (const pb of patternButtons) {
      pb.btn.title = `${pb.desc} with ${state.selectedCellClass}`;
    }
  };

  classes.forEach((c, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chain-swatch-button";
    btn.dataset.class = c;
    btn.classList.toggle("active", c === state.selectedCellClass);
    btn.title = i < 9 ? `Select brush "${c}" (Hotkey: ${i + 1})` : `Select brush "${c}"`;
    const dot = document.createElement("span");
    dot.className = "swatch";
    dot.style.background = classColor(c);
    const label = document.createElement("span");
    label.textContent = c;
    btn.append(dot, label);
    btn.onclick = () => {
      state.selectedCellClass = c;
      updateSwatches();
    };
    swatchesContainer.append(btn);
    swatchButtons.push(btn);
  });

  const brushSelect = choice(
    "Brush class",
    "chainCellBrush",
    classes,
    state.selectedCellClass,
    (v) => {
      state.selectedCellClass = v;
      updateSwatches();
    },
  );

  swatchRow.append(brushSelect, swatchesContainer);

  const toolsRow = document.createElement("div");
  toolsRow.className = "chain-palette-row";

  const toolGroup = document.createElement("div");
  toolGroup.className = "chain-tool-group";
  const toolDefs: Array<[PaintTool, string, string]> = [
    ["paint", "Paint (D)", "Click or drag to apply active brush (Hotkey: D or B)"],
    ["fill", "Fill (F)", "Flood-fill connected cells of matching class (Hotkey: F)"],
    ["rect", "Rect (R)", "Drag a box to fill covered cells (Hotkey: R)"],
    ["segment", "Segments (S)", "Click or drag across boundaries to stamp segment passability (Hotkey: S)"],
  ];
  for (const [t, label, title] of toolDefs) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.tool = t;
    b.textContent = label;
    b.title = title;
    b.classList.toggle("active", t === state.selectedPaintTool);
    b.onclick = () => {
      state.selectedPaintTool = t;
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
    pb.title = `${title} with ${state.selectedCellClass}`;
    pb.onclick = () => {
      setCells(tile, getCoords(), state.selectedCellClass);
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
    b.classList.toggle("active", state.selectedSegmentBrush === sb && state.selectedPaintTool === "segment");
    const dot = document.createElement("span");
    dot.className = "swatch";
    dot.style.background = swatch;
    const lbl = document.createElement("span");
    lbl.textContent = label;
    b.append(dot, lbl);
    b.onclick = () => {
      state.selectedSegmentBrush = sb;
      state.selectedPaintTool = "segment";
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

  root.append(palette);

  const stage = document.createElement("div");
  stage.className = "chain-tile-stage";
  stage.classList.toggle("mode-segment", state.selectedPaintTool === "segment");

  const colsGutter = document.createElement("div");
  colsGutter.className = "chain-gutter cols";
  for (let x = 0; x < CHAIN_TILE_SIZE; x++) {
    const gb = document.createElement("button");
    gb.type = "button";
    gb.textContent = String(x);
    gb.title = `Paint column ${x} with ${state.selectedCellClass}`;
    gb.onclick = () => {
      const coords = Array.from({ length: CHAIN_TILE_SIZE }, (_, y) => ({
        x,
        y,
      }));
      setCells(tile, coords, state.selectedCellClass);
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
    gb.title = `Paint row ${y} with ${state.selectedCellClass}`;
    gb.onclick = () => {
      const coords = Array.from({ length: CHAIN_TILE_SIZE }, (_, x) => ({
        x,
        y,
      }));
      setCells(tile, coords, state.selectedCellClass);
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
  hoverReadout.id = "chainHoverReadout";
  hoverReadout.className = "chain-hover-readout";

  const cells = tileCells(tile);
  const cellButtons: Map<string, HTMLButtonElement> = new Map();
  function drawCell(x: number, y: number): void {
    const cellVal = cells[y * CHAIN_TILE_SIZE + x]!;
    const btn = cellButtons.get(`${x},${y}`)!;
    btn.textContent = cellVal;
    btn.style.background = classColor(cellVal);
    btn.title = `Cell ${x},${y} · ${cellVal}${cellVal === tile.defaultCellClass ? " (default)" : ""}`;
  }

  for (let y = 0; y < CHAIN_TILE_SIZE; y++)
    for (let x = 0; x < CHAIN_TILE_SIZE; x++) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "chain-cell";
      button.dataset.cell = `${x},${y}`;
      button.dataset.x = String(x);
      button.dataset.y = String(y);
      cellButtons.set(`${x},${y}`, button);
      drawCell(x, y);
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

    if (state.selectedSegment === key) btn.classList.add("selected");

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
          state.selectedSegment = key;
          if (state.selectedPaintTool === "segment") {
            applySegmentBrush(tile, key, state.selectedSegmentBrush);
            changed();
          } else {
            render();
          }
        });

        button.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          closePopup();
          state.selectedSegment = key;
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
    cells[y * CHAIN_TILE_SIZE + x] = state.selectedCellClass;
    drawCell(x, y);
  };

  grid.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    closePopup();

    if (state.selectedPaintTool === "segment") {
      e.preventDefault();
      isDragging = true;
      lastPointerPos = { x: e.clientX, y: e.clientY };
      const segKey = getNearestSegment(grid, e.clientX, e.clientY);
      if (segKey) {
        state.selectedSegment = segKey;
        applySegmentBrush(tile, segKey, state.selectedSegmentBrush);
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
      state.selectedCellClass = sampled;
      updateSwatches();
      return;
    }

    if (state.selectedPaintTool === "fill") {
      e.preventDefault();
      floodFill(tile, x, y, state.selectedCellClass);
      changed();
      return;
    }

    if (state.selectedPaintTool === "rect") {
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

    if (state.selectedPaintTool === "paint") {
      e.preventDefault();
      isDragging = true;
      lastPaintedCoord = { x, y };
      paintSingleCell(x, y);
      setCell(tile, x, y, state.selectedCellClass);
      try {
        grid.setPointerCapture(e.pointerId);
      } catch {
        /* pointer capture optional */
      }
    }
  });

  grid.addEventListener("pointermove", (e) => {
    if (state.selectedPaintTool === "segment") {
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
          applySegmentBrush(tile, hitKey, state.selectedSegmentBrush);
          state.selectedSegment = hitKey;
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

    if (state.selectedPaintTool === "rect" && rectStart && coords) {
      updateGhost(rectStart.x, rectStart.y, coords.x, coords.y);
      return;
    }

    if (state.selectedPaintTool === "paint" && coords && lastPaintedCoord) {
      if (coords.x !== lastPaintedCoord.x || coords.y !== lastPaintedCoord.y) {
        const line = plotLine(
          lastPaintedCoord.x,
          lastPaintedCoord.y,
          coords.x,
          coords.y,
        );
        for (const pt of line) {
          paintSingleCell(pt.x, pt.y);
          setCell(tile, pt.x, pt.y, state.selectedCellClass);
        }
        lastPaintedCoord = { x: coords.x, y: coords.y };
      }
    }
  });

  const onPointerEnd = (e: PointerEvent) => {
    if (!isDragging) return;

    if (state.selectedPaintTool === "segment") {
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

    if (state.selectedPaintTool === "rect" && rectStart) {
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
      setCells(tile, toPaint, state.selectedCellClass);
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

    if (state.selectedPaintTool === "paint") {
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

    const title = document.createElement("h4");
    title.textContent = `Cell ${x},${y} (${currentClass})`;
    popup.append(title);

    const pickBtn = document.createElement("button");
    pickBtn.type = "button";
    pickBtn.textContent = `Pick up "${currentClass}"`;
    pickBtn.onclick = () => {
      state.selectedCellClass = currentClass;
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
        state.selectedCellClass = c;
        setCell(tile, x, y, c);
        closePopup();
        changed();
      };
      swatchContainer.append(b);
    }
    popup.append(swatchContainer, document.createElement("hr"));

    const fillRowBtn = document.createElement("button");
    fillRowBtn.type = "button";
    fillRowBtn.textContent = `Fill row ${y} with ${state.selectedCellClass}`;
    fillRowBtn.onclick = () => {
      const rowCoords = Array.from(
        { length: CHAIN_TILE_SIZE },
        (_, cx) => ({ x: cx, y }),
      );
      setCells(tile, rowCoords, state.selectedCellClass);
      closePopup();
      changed();
    };

    const fillColBtn = document.createElement("button");
    fillColBtn.type = "button";
    fillColBtn.textContent = `Fill col ${x} with ${state.selectedCellClass}`;
    fillColBtn.onclick = () => {
      const colCoords = Array.from(
        { length: CHAIN_TILE_SIZE },
        (_, cy) => ({ x, y: cy }),
      );
      setCells(tile, colCoords, state.selectedCellClass);
      closePopup();
      changed();
    };

    popup.append(fillRowBtn, fillColBtn);
    showPopup(popup, e.clientX, e.clientY);

    dismissPopupOutside(popup);
  });

  stage.append(colsGutter, rowsGutter, grid);
  root.append(
    stage,
    hoverReadout,
    paragraph(
      "Click or drag to apply the active brush · Alt-click to eyedropper sample · Right-click for quick palette · Gutter buttons cover a whole row or column.",
    ),
  );
  properties.append(
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
        button.classList.toggle("active", state.selectedSegment === key);
        button.classList.toggle("stated", !!tile.segments?.[key]);
        button.onclick = () => {
          state.selectedSegment = key;
          render();
        };
        segments.append(button);
      }
  properties.append(segments);
  // A property edit redraws what reads it (default class, segment statements) on the stage as built.
  state.refreshEditor = () => {
    cells.splice(0, cells.length, ...tileCells(tile));
    for (let y = 0; y < CHAIN_TILE_SIZE; y++)
      for (let x = 0; x < CHAIN_TILE_SIZE; x++) drawCell(x, y);
    for (const [key, btn] of stageSegmentButtons) updateStageSegmentButton(btn, key);
    for (const btn of segments.querySelectorAll<HTMLElement>("[data-segment]"))
      btn.classList.toggle("stated", !!tile.segments?.[btn.dataset.segment!]);
    renderPreview(tile);
  };
  const prescription = tile.segments?.[state.selectedSegment] ?? {};
  const { isPerimeter: perimeter } = segmentDescriptor(state.selectedSegment);
  const controls = document.createElement("div");
  controls.className = "chain-segment-controls";
  const set = (dimension: keyof SegmentPrescription, value: string) => {
    setSegmentProp(
      tile,
      state.selectedSegment,
      dimension as "adjacency" | "passability",
      value || undefined,
    );
  };
  const titleP = paragraph(`Selected ${state.selectedSegment}`);
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
        ["", "any", ...Object.keys(state.library.cellClasses)],
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
  properties.append(controls);
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
          `${key}: passable prescription has the same region class on both sides; it forms no external portal, but the internal guarantee still requires a clear margin.`,
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
