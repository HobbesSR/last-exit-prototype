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
import { DEFAULT_CHAIN_PARAMS } from "../../macro/src/chain/placement.ts";
import { chainMapToBson, chainMapToJson } from "../../macro/src/chain/saving.ts";
import type { ChainParams } from "../../macro/src/chain/types.ts";
import type { BrokenPromise } from "../../micro/diagnose.ts";
import { elementShapes } from "../../micro/geometry.ts";
import type { RegionElement } from "../../micro/types.ts";
import { outline } from "../../../shared/shape.ts";
import { chainDraft, renderChainLibrary } from "./chain-author.ts";
import type { LabReply, LabRequest } from "./worker.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);
const select = (id: string) => $<HTMLSelectElement>(id);
const canvas = $<HTMLCanvasElement>("map");
const ctx = canvas.getContext("2d")!;

type Field = "regions" | "resolved" | "declared" | "proof" | "zones" | "none";
const NUMERIC = ["zoneWidth", "zoneHeight", "exitCount", "contestantCount", "hunterCount"] as const;

// ── State ───────────────────────────────────────────────────────────────────

let map: ToolMap | null = null;
let views: MapViews<RegionElement> | null = null;
let check: MapCheck | null = null;
let diagnosis: { brokenPromises: BrokenPromise[]; ms: number } | null = null;
let lastMs = 0;
let error = "";
let busy = false;
let selected: { x: number; y: number } | null = null;
/** Per cell: the index of its region in `views.regions.regions`, or -1 outside the mask. */
let regionAt = new Int32Array(0);
/** Drawn once per map and field, in cell units. */
let cellLayer: HTMLCanvasElement | null = null;
let defectLayer: HTMLCanvasElement | null = null;
let geometry: { path: Path2D; shapes: number } | null = null;
let camera = { zoom: 2, x: 0, y: 0 };
/** Until the viewer pans or zooms, the map is refitted whenever the canvas resizes. */
let fitted = true;

// ── Workers ─────────────────────────────────────────────────────────────────

const WORKER_URL = new URL("./worker.ts", import.meta.url);
let mapWorker: Worker | null = null;
let diagnoseWorker: Worker | null = null;

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
  fillParams(map.layout.params);
  input("seed").value = map.layout.seed;
  const { width, height } = views.resolved;
  regionAt = new Int32Array(width * height).fill(-1);
  views.regions.regions.forEach((region, i) => {
    for (const cell of region.cells) regionAt[cell] = i;
  });
  geometry = buildGeometry();
  cellLayer = paintField();
  defectLayer = paintDefects();
  fit();
  renderReport();
  renderDiagnosis();
  renderInspector();
  setStatus(`${map.layout.seed}: ${views.regions.regions.length} regions, ${check.valid ? "no defects" : `${check.defects.length} defects`}, generated in ${(lastMs / 1000).toFixed(2)} s`);
}

/** A steady colour for a name. */
function colour(name: string, saturation = 42, lightness = 40): [number, number, number] {
  let hash = 2166136261;
  for (let i = 0; i < name.length; i++) hash = Math.imul(hash ^ name.charCodeAt(i), 16777619);
  return hsl(((hash >>> 0) % 360) / 360, saturation / 100, lightness / 100);
}

function hsl(h: number, s: number, l: number): [number, number, number] {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const channel = (t: number) => {
    t = (t + 1) % 1;
    const v = t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
    return Math.round(v * 255);
  };
  return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)];
}

const css = ([r, g, b]: [number, number, number]) => `rgb(${r} ${g} ${b})`;

/** Each cell's name and colour under the chosen field, or null where nothing is drawn. */
function fieldOf(field: Field): ((cell: number) => string | null) | null {
  if (!views) return null;
  const v = views;
  switch (field) {
    case "none": return null;
    case "declared": return (cell) => v.declaredGrid.cells[cell] || null;
    case "resolved": return (cell) => v.resolved.cells[cell] || null;
    case "regions": return (cell) => (regionAt[cell]! >= 0 ? v.regions.regions[regionAt[cell]!]!.id : null);
    case "proof": {
      const component = new Map<string, number>();
      v.proof.components.forEach((ids, i) => ids.forEach((id) => component.set(id, i)));
      return (cell) => (regionAt[cell]! >= 0 ? `component ${component.get(v.regions.regions[regionAt[cell]!]!.id)}` : null);
    }
    case "zones": {
      const { width } = v.resolved;
      return (cell) => {
        if (!v.resolved.cells[cell]) return null;
        const x = cell % width, y = Math.floor(cell / width);
        const zone = v.zones.find(({ cells: b }) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1);
        return zone ? `tier ${zone.tier}` : null;
      };
    }
  }
}

function fieldColour(field: Field, name: string): [number, number, number] {
  if (field === "declared" && name === "any") return [70, 78, 84];
  if (field === "zones") return hsl(0.33 - Number(name.slice(5)) * 0.07, 0.45, 0.22 + Number(name.slice(5)) * 0.06);
  return colour(name);
}

function paintField(): HTMLCanvasElement | null {
  if (!views) return null;
  const field = select("field").value as Field, name = fieldOf(field);
  const { width, height } = views.resolved;
  const layer = document.createElement("canvas");
  layer.width = width;
  layer.height = height;
  const image = new ImageData(width, height), seen = new Map<string, [number, number, number]>();
  if (name)
    for (let cell = 0; cell < width * height; cell++) {
      const value = name(cell);
      if (value === null) continue;
      let rgb = seen.get(value);
      if (!rgb) seen.set(value, (rgb = fieldColour(field, value)));
      image.data.set([...rgb, 255], cell * 4);
    }
  layer.getContext("2d")!.putImageData(image, 0, 0);
  renderLegend(field, seen);
  return layer;
}

function renderLegend(field: Field, seen: Map<string, [number, number, number]>): void {
  const legend = $("legend");
  if (field === "regions" || seen.size > 40) {
    legend.textContent = field === "none" ? "" : `${seen.size} ${field === "regions" ? "regions" : "values"}, each its own colour.`;
    return;
  }
  legend.replaceChildren(...[...seen].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })).map(([name, rgb]) => {
    const item = document.createElement("span");
    item.textContent = name;
    item.style.setProperty("--swatch", css(rgb));
    return item;
  }));
}

/** Regions any defect or broken promise names, washed red. */
function defectRegions(): Set<string> {
  const named = new Set<string>();
  for (const defect of check?.defects ?? []) for (const id of defect.regions ?? []) named.add(id);
  for (const broken of diagnosis?.brokenPromises ?? []) named.add(broken.region);
  return named;
}

function paintDefects(): HTMLCanvasElement | null {
  if (!views) return null;
  const { width, height } = views.resolved, named = defectRegions();
  const layer = document.createElement("canvas");
  layer.width = width;
  layer.height = height;
  if (!named.size) return layer;
  const image = new ImageData(width, height);
  views.regions.regions.forEach((region) => {
    if (named.has(region.id)) for (const cell of region.cells) image.data.set([235, 70, 60, 120], cell * 4);
  });
  layer.getContext("2d")!.putImageData(image, 0, 0);
  return layer;
}

/** The built map's colliders and gates (`elementShapes`), in cell units. */
function buildGeometry(): { path: Path2D; shapes: number } {
  const path = new Path2D();
  let shapes = 0;
  const { cellSize, regions } = views!.built;
  for (const region of regions)
    for (const element of region.elements)
      for (const shape of elementShapes(element, true)) {
        const points = outline(shape);
        points.forEach((p, i) => (i ? path.lineTo(p.x / cellSize, p.y / cellSize) : path.moveTo(p.x / cellSize, p.y / cellSize)));
        path.closePath();
        shapes++;
      }
  return { path, shapes };
}

// ── Drawing ─────────────────────────────────────────────────────────────────

const SITE_COLOURS: Record<string, string> = {
  spawn: "#7fd0ff", "hunter-spawn": "#ff7a6b", exit: "#c8f185", charger: "#ffd166", warp: "#c39bff",
};

function runLine(path: Path2D, run: { axis: "h" | "v"; x: number; y: number; length: number }): void {
  path.moveTo(run.x, run.y);
  path.lineTo(run.axis === "h" ? run.x + run.length : run.x, run.axis === "v" ? run.y + run.length : run.y);
}

function draw(): void {
  const dpr = devicePixelRatio || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!views) return;
  const { zoom, x, y } = camera, px = 1 / zoom;
  ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * x, dpr * y);
  ctx.imageSmoothingEnabled = false;
  if (cellLayer) ctx.drawImage(cellLayer, 0, 0);
  if (input("showDefects").checked && defectLayer) ctx.drawImage(defectLayer, 0, 0);
  if (input("showGeometry").checked && geometry) {
    ctx.fillStyle = "#b9c4bfcc";
    ctx.fill(geometry.path);
  }
  if (input("showPortals").checked) {
    const boundaries = new Path2D(), portals = new Path2D();
    for (const boundary of views.regions.boundaries) runLine(boundaries, boundary.run);
    for (const portal of views.regions.portals) runLine(portals, portal);
    ctx.lineCap = "butt";
    ctx.strokeStyle = "#0b1015";
    ctx.lineWidth = 1.5 * px;
    ctx.stroke(boundaries);
    ctx.strokeStyle = "#e9f7c4";
    ctx.lineWidth = Math.max(0.25, 3 * px);
    ctx.stroke(portals);
  }
  const { cellSize } = views.built;
  if (input("showLoot").checked) {
    ctx.fillStyle = "#f2ca55";
    for (const region of views.built.regions)
      for (const loot of region.loot) {
        ctx.beginPath();
        ctx.arc(loot.x / cellSize, loot.y / cellSize, Math.max(0.15, 2 * px), 0, Math.PI * 2);
        ctx.fill();
      }
  }
  if (input("showSites").checked)
    for (const region of views.built.regions)
      for (const site of region.coreElements) {
        ctx.beginPath();
        ctx.arc(site.x / cellSize, site.y / cellSize, Math.max(0.6, 5 * px), 0, Math.PI * 2);
        ctx.fillStyle = SITE_COLOURS[site.kind] ?? "#fff";
        ctx.fill();
        ctx.strokeStyle = "#0b1015";
        ctx.lineWidth = px;
        ctx.stroke();
      }
  if (input("showDefects").checked)
    for (const defect of check?.defects ?? [])
      if (defect.site) {
        ctx.beginPath();
        ctx.arc(defect.site.x / cellSize, defect.site.y / cellSize, Math.max(1, 9 * px), 0, Math.PI * 2);
        ctx.strokeStyle = "#ff5a4a";
        ctx.lineWidth = 2 * px;
        ctx.stroke();
      }
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
  fitted = true;
  draw();
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
      defectLayer = paintDefects();
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

function inspection(): string {
  if (!views || !selected) return "Select a cell.";
  const { width } = views.resolved, cell = selected.y * width + selected.x;
  const lines = [`Cell ${selected.x}, ${selected.y}`, `Declared: ${views.declaredGrid.cells[cell] || "outside the mask"}`];
  if (!views.resolved.cells[cell]) return lines.join("\n");
  lines.push(`Resolved: ${views.resolved.cells[cell]}`);
  const zone = views.zones.find(({ cells: b }) => selected!.x >= b.x0 && selected!.x <= b.x1 && selected!.y >= b.y0 && selected!.y <= b.y1);
  if (zone) lines.push(`Zone ${zone.id}: tier ${zone.tier}, bonus ${zone.bonus}`);
  const region = views.regions.regions[regionAt[cell]!];
  if (!region) return lines.join("\n");
  const component = views.proof.components.findIndex((ids) => ids.includes(region.id));
  const built = views.built.regions.find((result) => result.brief.id === region.id);
  lines.push("", `Region ${region.id}`, `Class ${region.class}, ${region.cells.length} cells, seed ${region.seed}`, `Proof component ${component}`);
  if (built) {
    lines.push(`Type ${built.brief.type}, ${built.brief.portals.length} portals`, `${built.elements.length} elements, ${built.loot.length} loot`);
    if (built.coreElements.length) lines.push(`Core elements: ${built.coreElements.map((site) => site.kind).join(", ")}`);
  }
  for (const defect of check?.defects ?? []) if (defect.regions?.includes(region.id)) lines.push(`Defect, ${defect.kind}: ${defect.message}`);
  for (const broken of diagnosis?.brokenPromises ?? []) if (broken.region === region.id) lines.push(`Broken promise: ${broken.errors.join("; ")}`);
  return lines.join("\n");
}

function renderInspector(): void {
  $("inspector").textContent = inspection();
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
$("fit").onclick = fit;
$("diagnose").onclick = startDiagnosis;
$("cancelDiagnose").onclick = cancelDiagnosis;
select("field").onchange = () => {
  cellLayer = paintField();
  draw();
};
for (const id of ["showPortals", "showGeometry", "showSites", "showLoot", "showDefects"]) input(id).onchange = draw;
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
  if (!drag) return;
  const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
  if (!drag.moved) return;
  camera = { ...drag.camera, x: drag.camera.x + dx, y: drag.camera.y + dy };
  fitted = false;
  draw();
};
canvas.onpointerup = (event) => {
  const click = drag && !drag.moved;
  drag = null;
  if (!click || !views) return;
  const box = canvas.getBoundingClientRect();
  const x = Math.floor((event.clientX - box.left - camera.x) / camera.zoom);
  const y = Math.floor((event.clientY - box.top - camera.y) / camera.zoom);
  const { width, height } = views.resolved;
  selected = x >= 0 && y >= 0 && x < width && y < height ? { x, y } : null;
  renderInspector();
  draw();
};
canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  const box = canvas.getBoundingClientRect(), px = event.clientX - box.left, py = event.clientY - box.top;
  const zoom = Math.max(0.1, Math.min(80, camera.zoom * Math.exp(-event.deltaY * 0.0015)));
  camera = { zoom, x: px - ((px - camera.x) / camera.zoom) * zoom, y: py - ((py - camera.y) / camera.zoom) * zoom };
  fitted = false;
  draw();
}, { passive: false });
new ResizeObserver(resize).observe(canvas);

// ── For the browser test ────────────────────────────────────────────────────

declare global {
  interface Window {
    mapLab: { snapshot: () => unknown };
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
    shapes: geometry?.shapes ?? 0,
    sites: views?.built.regions.reduce((sum, region) => sum + region.coreElements.length, 0) ?? 0,
    report: check ? { valid: check.valid, defects: check.defects.length, coreElements: check.coreElements } : null,
    diagnosing: !!diagnoseWorker,
    diagnosis: diagnosis ? { brokenPromises: diagnosis.brokenPromises } : null,
    inspector: $("inspector").textContent,
  }),
});

fillParams(DEFAULT_CHAIN_PARAMS);
generateMap();
