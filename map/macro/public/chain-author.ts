import {
  CHAIN_LIBRARY_VERSION,
  CHAIN_TILE_SIZE,
  validateLibrary,
} from "/src/chain/library.ts";
import type {
  ChainLibrary,
  ChainTileDesign,
  ChainSetPieceSlot,
  SegmentPrescription,
} from "/src/chain/library.ts";
import { orientDesign } from "/src/chain/declared-grid.ts";
import { regions, portalViolations } from "/src/chain/regions.ts";
import type { ResolvedLayout } from "/src/chain/types.ts";
import { CORE_ELEMENT_KINDS } from "../../kernel/contract.ts";
import { MIN_PORTAL_LENGTH } from "../../kernel/scale.ts";

const $ = (id: string): HTMLElement => document.getElementById(id)!;
const select = (id: string): HTMLSelectElement => $(id) as HTMLSelectElement;
const area = (id: string): HTMLTextAreaElement => $(id) as HTMLTextAreaElement;
const starter: ChainLibrary = {
  version: CHAIN_LIBRARY_VERSION,
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
const KEY = "last-exit-chain-library-v2";
let library: ChainLibrary = structuredClone(starter);
try {
  const saved = localStorage.getItem(KEY);
  if (saved) library = JSON.parse(saved) as ChainLibrary;
} catch {
  /* malformed saved drafts are diagnosed below */
}
let selectedSegment = "v:3,2";
let selectedCellClass = "hut";
let selectedId = "";

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
): HTMLElement {
  const wrap = document.createElement("label");
  wrap.textContent = label;
  const input = document.createElement("select");
  input.id = id;
  input.replaceChildren(...values.map((v) => option(v, v || "Unspecified")));
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
  coreElements?: Record<string, number | "exitCount">;
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
    input.placeholder = "Unspecified, count, or exitCount";
    input.onchange = () => {
      const raw = input.value.trim();
      const next = { ...value.coreElements };
      if (!raw) delete next[kind];
      else next[kind] = raw === "exitCount" ? "exitCount" : Number(raw);
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
function tileCells(tile: ChainTileDesign): string[] {
  const oriented = orientDesign(tile, 0);
  return oriented.cells;
}
function setCell(
  tile: ChainTileDesign,
  x: number,
  y: number,
  value: string,
): void {
  const cells = tileCells(tile);
  cells[y * CHAIN_TILE_SIZE + x] = value;
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
  root.append(
    heading("Paint cells"),
    choice("Brush class", "chainCellBrush", classes, selectedCellClass, (v) => {
      selectedCellClass = v;
    }),
  );
  const grid = document.createElement("div");
  grid.id = "chainGrid";
  grid.className = "chain-grid";
  const cells = tileCells(tile);
  for (let y = 0; y < CHAIN_TILE_SIZE; y++)
    for (let x = 0; x < CHAIN_TILE_SIZE; x++) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.cell = `${x},${y}`;
      button.textContent = cells[y * CHAIN_TILE_SIZE + x]!;
      button.title = `Cell ${x},${y}`;
      button.onclick = () => {
        setCell(tile, x, y, selectedCellClass);
        changed();
      };
      grid.append(button);
    }
  root.append(
    grid,
    heading("Segment prescriptions"),
    paragraph(
      "Select any interior or perimeter segment. Adjacency is available only on the perimeter. Written any remains distinct from an unstated field.",
    ),
  );
  const segments = document.createElement("div");
  segments.id = "chainSegments";
  segments.className = "chain-segments";
  for (const axis of ["v", "h"] as const)
    for (let line = 0; line <= CHAIN_TILE_SIZE; line++)
      for (let offset = 0; offset < CHAIN_TILE_SIZE; offset++) {
        const key = `${axis}:${line},${offset}`;
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
  const line = Number(selectedSegment.split(":")[1]!.split(",")[0]);
  const perimeter = line === 0 || line === CHAIN_TILE_SIZE;
  const controls = document.createElement("div");
  controls.className = "chain-segment-controls";
  const set = (dimension: keyof SegmentPrescription, value: string) => {
    tile.segments ??= {};
    const next = (tile.segments[selectedSegment] ??= {});
    if (value) {
      if (dimension === "adjacency") next.adjacency = value;
      else next.passability = value as SegmentPrescription["passability"];
    } else delete next[dimension];
    if (!Object.keys(next).length) delete tile.segments[selectedSegment];
    if (!Object.keys(tile.segments).length) delete tile.segments;
    changed();
  };
  controls.append(
    paragraph(
      `Selected ${selectedSegment} · ${perimeter ? "perimeter" : "interior"}`,
    ),
  );
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
      ["", "any", "passable"],
      prescription.passability ?? "",
      (v) => set("passability", v),
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
      if (prescription.passability !== "passable") continue;
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
        stated: ["passable", "passable"],
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
function renderTileSets(root: HTMLElement): void {
  const entry = current() as ChainLibrary["tileSets"][number];
  if (!entry) return;
  root.append(
    heading("Members"),
    paragraph("Select one or more tile designs."),
  );
  for (const tile of library.tiles) {
    const label = document.createElement("label");
    label.className = "chain-check";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = entry.members.includes(tile.id);
    input.onchange = () => {
      entry.members = input.checked
        ? [...entry.members, tile.id]
        : entry.members.filter((id) => id !== tile.id);
      changed();
    };
    label.append(input, tile.id);
    root.append(label);
  }
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
  const ids = new Set(
    Object.values(library.cellClasses).map((entry) => entry.regionType),
  );
  const result = validateLibrary(library, ids);
  $("chainStatus").textContent =
    `${prefix ? `${prefix}\n` : ""}${result.valid ? "Library valid for declared region type IDs. Strategy availability awaits the B2 catalogue." : `${result.errors.length} validation issue(s):\n${result.errors.join("\n")}`}`;
  $("chainStatus").classList.toggle("invalid", !result.valid);
}
function changed(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(library));
  } catch {
    /* storage is optional */
  }
  render();
}
function render(): void {
  const names = entries();
  if (!names.includes(selectedId)) selectedId = names[0] ?? "";
  select("chainItem").replaceChildren(...names.map((id) => option(id)));
  select("chainItem").value = selectedId;
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
  status();
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
    library.tiles.push({ id, defaultCellClass: "open", orientations: [0] });
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
function remove(): void {
  if (!selectedId || (selectedId === "open" && section() === "classes")) return;
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
  if (
    !raw ||
    typeof raw !== "object" ||
    !("cellClasses" in raw) ||
    !raw.cellClasses ||
    typeof raw.cellClasses !== "object"
  )
    throw Error("Missing cellClasses");
  const ids = new Set(
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
  const result = validateLibrary(raw, ids);
  if (!result.valid) throw Error(result.errors.join("\n"));
  library = raw as ChainLibrary;
  selectedId = "";
  changed();
}
function download(): void {
  const ids = new Set(
    Object.values(library.cellClasses).map((entry) => entry.regionType),
  );
  const result = validateLibrary(library, ids);
  if (!result.valid) {
    status("Export refused: fix validation issues first.");
    return;
  }
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(library, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "last-exit-chain-library-v2.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$("chainTab").onclick = () => {
  for (const id of [
    "worldViewContainer",
    "authorViewContainer",
    "setsViewContainer",
    "setPiecesViewContainer",
  ])
    $(id).hidden = true;
  for (const id of ["mapTab", "authorTab", "setsTab", "setPiecesTab"])
    $(id).classList.remove("active");
  $("chainViewContainer").hidden = false;
  $("chainTab").classList.add("active");
  render();
};
for (const id of ["mapTab", "authorTab", "setsTab", "setPiecesTab"])
  $(id).addEventListener("click", () => {
    $("chainViewContainer").hidden = true;
    $("chainTab").classList.remove("active");
  });
select("chainSection").onchange = () => {
  selectedId = "";
  render();
};
select("chainItem").onchange = () => {
  selectedId = select("chainItem").value;
  render();
};
$("chainAdd").onclick = add;
$("chainDelete").onclick = remove;
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
window.chainLab = Object.freeze({
  snapshot: () => ({
    library: structuredClone(library),
    valid: validateLibrary(
      library,
      new Set(
        Object.values(library.cellClasses).map((entry) => entry.regionType),
      ),
    ).valid,
    section: section(),
    selectedId,
    portalText: $("chainPreview").textContent,
  }),
});
render();
