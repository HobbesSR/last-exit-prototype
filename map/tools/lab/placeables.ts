import { DEFAULT_CELL_SIZE } from "../engines.ts";
import { PLACEABLES, buildPlaceable } from "../../micro/placeables/index.ts";
import { demandShapes, placeableErrors, placedElements } from "../../micro/placeables/placeable.ts";
import type { ParamSpec, Placeable, Placed, Refusal } from "../../micro/placeables/placeable.ts";
import { designsNotUsed, drawAllocation, drawOpenings, guidanceNotMet, traceSummary } from "../../micro/building/draw.ts";
import type { BuildingTrace } from "../../micro/building/trace.ts";
import { outline } from "../../../shared/shape.ts";
import { PARTS, PART_FILL, addElementParts, partPaths } from "./parts.ts";

/**
 * The Placeables tab (#433, 20.8): every placeable in `PLACEABLES`, a preview of each example,
 * and its parameters editable within their specs. Edited parameters go through
 * `buildPlaceable`, as a tool's unchecked input would, so the tab shows `placeableErrors` or a
 * refusal's reason rather than a preview the specs don't allow.
 */

/** Previews build at the brief's default cell size, as a region would. */
const CELL = DEFAULT_CELL_SIZE;
const BODY = "#c8f185", CLEAR = "#f2b787", GRID = "rgba(154, 171, 183, 0.18)";

const ids = Object.keys(PLACEABLES);
let selected = ids[0]!;
/** The parameters being edited, as typed: possibly outside their specs. */
let params: Record<string, unknown> = { ...PLACEABLES[selected]!.examples[0] };
let traced = true;
/** Paints the tab's canvases while it shows. A canvas's bitmap is sized when painted, so a resize repaints. */
let repaint = () => {};
let resizes: ResizeObserver | undefined;

type Result = { errors: string[] } | Refusal | Placed<unknown>;

/** What `params` build, or why they don't. A defect `build` throws is shown, not swallowed silently. */
function result(placeable: Placeable<any, unknown>, raw: unknown): Result {
  const errors = placeableErrors(placeable, raw);
  if (errors.length) return { errors };
  try {
    return buildPlaceable(placeable.id, raw, CELL);
  } catch (error) {
    return { errors: [`Defect: ${(error as Error).message}`] };
  }
}

/** A building placeable's details carry its design, allocation and realization: the trace the drill-down draws. */
function traceOf(placed: Placed<unknown>, label: string): BuildingTrace | undefined {
  const d = placed.details as Partial<BuildingTrace> | undefined;
  if (!d?.design || !d.allocation || !d.realization) return undefined;
  return { label, origin: { x: 0, y: 0 }, cellSize: CELL, design: d.design, allocation: d.allocation, realization: d.realization, rejected: d.rejected };
}

/** Draws the demand (body, then clear boxes), the elements' parts and, optionally, the building trace, fitted to the canvas. */
function paint(canvas: HTMLCanvasElement, placed: Placed<unknown>, label: string, withTrace: boolean): void {
  // Sized from layout alone: a hidden or collapsed canvas has nothing to fit, and the resize that shows it repaints.
  const ratio = window.devicePixelRatio || 1, width = canvas.clientWidth, height = canvas.clientHeight;
  if (width <= 0 || height <= 0) return;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const g = canvas.getContext("2d")!;
  g.setTransform(ratio, 0, 0, ratio, 0, 0);
  g.clearRect(0, 0, width, height);
  const { body, clear } = placed.demand;
  const boxes = [{ x: 0, y: 0, ...body }, ...clear];
  const x0 = Math.min(...boxes.map((b) => b.x)) - 1, y0 = Math.min(...boxes.map((b) => b.y)) - 1;
  const x1 = Math.max(...boxes.map((b) => b.x + b.w)) + 1, y1 = Math.max(...boxes.map((b) => b.y + b.h)) + 1;
  const scale = Math.min(width / (x1 - x0), height / (y1 - y0)), px = 1 / scale;
  g.save();
  g.translate((width - (x1 - x0) * scale) / 2, (height - (y1 - y0) * scale) / 2);
  g.scale(scale, scale);
  g.translate(-x0, -y0);
  g.strokeStyle = GRID;
  g.lineWidth = px;
  g.beginPath();
  for (let x = x0; x <= x1; x++) { g.moveTo(x, y0); g.lineTo(x, y1); }
  for (let y = y0; y <= y1; y++) { g.moveTo(x0, y); g.lineTo(x1, y); }
  g.stroke();
  demandShapes(placed.demand, 0, 0, CELL).forEach((shape, i) => {
    const path = new Path2D();
    outline(shape).forEach((p, j) => (j ? path.lineTo(p.x / CELL, p.y / CELL) : path.moveTo(p.x / CELL, p.y / CELL)));
    path.closePath();
    g.globalAlpha = 0.12;
    g.fillStyle = i ? CLEAR : BODY;
    g.fill(path);
    g.globalAlpha = 1;
    g.strokeStyle = i ? CLEAR : BODY;
    g.lineWidth = 2 * px;
    g.setLineDash(i ? [6 * px, 4 * px] : []);
    g.stroke(path);
  });
  g.setLineDash([]);
  const paths = partPaths();
  for (const element of placedElements(placed, label, 0, 0, CELL)) addElementParts(element, CELL, paths, () => {});
  g.globalAlpha = 0.35;
  g.fillStyle = PART_FILL.roofs;
  g.fill(paths.roofs);
  g.globalAlpha = 1;
  const trace = withTrace ? traceOf(placed, label) : undefined;
  if (trace) {
    g.save();
    g.scale(1 / CELL, 1 / CELL);
    drawAllocation(g, [trace], px * CELL);
    g.restore();
  }
  for (const part of PARTS) {
    if (part === "roofs") continue;
    g.fillStyle = PART_FILL[part];
    g.fill(paths[part]);
  }
  if (trace) {
    g.save();
    g.scale(1 / CELL, 1 / CELL);
    drawOpenings(g, [trace], px * CELL);
    g.restore();
  }
  g.restore();
}

/** An element with properties such as `className`, `type` or `checked`, and children. */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: Array<Node | string>): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

/**
 * One parameter's control, and a function that shows the current value in it. A value that
 * won't parse is kept as typed, so `placeableErrors` names it. An edit calls `changed` and
 * leaves the control in place, so focus, spinners and typing carry on.
 */
function field(spec: ParamSpec, changed: () => void): { control: HTMLElement; show: () => void } {
  const set = (next: unknown) => { params = { ...params, [spec.name]: next }; changed(); };
  if (spec.kind === "boolean") {
    const input = el("input", { type: "checkbox", name: spec.name });
    input.onchange = () => set(input.checked);
    return { control: el("label", { className: "placeable-check", title: spec.summary }, input, spec.name), show: () => (input.checked = params[spec.name] === true) };
  }
  if (spec.kind === "enum") {
    const select = el("select", { name: spec.name }, ...spec.values.map((v) => el("option", { value: v }, v)));
    select.onchange = () => set(select.value);
    return { control: el("label", { title: spec.summary }, spec.name, select), show: () => (select.value = String(params[spec.name] ?? "")) };
  }
  // Bounds come from the spec; a number's granularity doesn't, so the browser shouldn't flag any.
  const input = el("input", { type: "number", name: spec.name, min: String(spec.min), max: String(spec.max), step: spec.kind === "int" ? "1" : "any" });
  input.oninput = () => set(input.value.trim() === "" ? undefined : Number(input.value));
  return { control: el("label", { title: spec.summary }, `${spec.name} (${spec.min}–${spec.max})`, input), show: () => (input.value = String(params[spec.name] ?? "")) };
}

/** The readout for a result: demand and elements, or what stopped it. */
function readout(r: Result, label: string): string[] {
  if ("errors" in r) return ["Invalid parameters:", ...r.errors];
  if ("refused" in r) return [`Refused: ${r.refused}`];
  const { body, clear } = r.demand, trace = traceOf(r, label);
  return [
    `Demand: body ${body.w} × ${body.h} cells${clear.length ? `, clear ${clear.map((b) => `${b.w} × ${b.h} at (${b.x}, ${b.y})`).join(", ")}` : ", nothing clear"}`,
    `${r.elements.length} element${r.elements.length === 1 ? "" : "s"}, ${r.elements.reduce((n, e) => n + e.template.parts.length, 0)} parts`,
    ...(trace ? [traceSummary(trace), ...designsNotUsed(trace), ...guidanceNotMet(trace)] : []),
  ];
}

/**
 * Builds the tab for the selected placeable. Choosing another placeable builds it again; an
 * edit or a chosen example only updates what depends on the parameters.
 */
export function renderPlaceables(root: HTMLElement): void {
  const placeable = PLACEABLES[selected]!;
  const list = el("div", { className: "placeable-list" }, ...ids.map((id) => {
    const p = PLACEABLES[id]!, button = el("button", { type: "button", className: id === selected ? "active" : "" },
      el("strong", {}, id), el("span", {}, p.version));
    button.dataset.placeable = id;
    button.onclick = () => { selected = id; params = { ...p.examples[0] }; renderPlaceables(root); };
    return button;
  }));
  const paints: Array<() => void> = [];
  const canvas = el("canvas", { className: "placeable-preview" }), out = el("pre"), json = el("pre");
  const cards = placeable.examples.map((example, i) => {
    const r = result(placeable, example), thumb = el("canvas");
    const card = el("button", { type: "button", title: JSON.stringify(example) }, thumb,
      "elements" in r ? `Example ${i + 1}` : `Example ${i + 1}: ${readout(r, placeable.id)[0]}`);
    card.onclick = () => { params = { ...example }; fields.forEach((f) => f.show()); update(); };
    if ("elements" in r) paints.push(() => paint(thumb, r, placeable.id, false));
    return card;
  });
  let current: Result = { errors: [] };
  const preview = () => { if ("elements" in current) paint(canvas, current, placeable.id, traced); };
  const update = () => {
    current = result(placeable, params);
    out.className = "readout" + ("elements" in current ? "" : " invalid");
    out.textContent = readout(current, placeable.id).join("\n");
    json.textContent = JSON.stringify(params, null, 2);
    const shown = JSON.stringify(params);
    placeable.examples.forEach((example, i) => cards[i]!.classList.toggle("active", JSON.stringify(example) === shown));
    canvas.hidden = !("elements" in current);
    preview();
  };
  paints.push(preview);
  const fields = placeable.params.map((spec) => field(spec, update));
  fields.forEach((f) => f.show());
  const traceToggle = el("input", { type: "checkbox", checked: traced });
  traceToggle.onchange = () => { traced = traceToggle.checked; preview(); };

  root.replaceChildren(
    el("div", { className: "chain-heading" }, el("div", {}, el("h2", {}, "Placeables"),
      el("p", {}, `Inspect builder objects at ${CELL} units a cell. Parameters try a preview; definitions are read-only.`))),
    el("div", { className: "chain-layout placeable-workspace" },
      el("aside", { className: "chain-sidebar" }, el("h3", {}, "Catalogue"), list),
      el("div", { className: "chain-work" },
        el("header", { className: "object-heading" }, el("span", {}, "Selected placeable"), el("h3", { className: "placeable-title" }, `${placeable.id} `, el("span", {}, placeable.version))),
        el("section", { className: "author-surface" },
          el("label", { className: "placeable-check" }, traceToggle, "Building trace: spaces, allocation and openings"),
          canvas,
          el("div", { className: "placeable-legend" },
            ...[["body", BODY], ["clear", CLEAR], ...PARTS.map((part) => [part, PART_FILL[part]])].map(([name, colour]) => {
              const swatch = el("i");
              swatch.style.background = colour!;
              return el("span", {}, swatch, name!);
            })),
          el("h3", {}, "Examples"),
          el("div", { className: "placeable-examples" }, ...cards),
        ),
      ),
      el("aside", { className: "chain-inspector chain-work placeable-inspector", ariaLabel: "Preview parameters and placement information" },
        el("h3", {}, "Preview parameters"),
        el("p", { className: "hint" }, placeable.summary),
        el("div", { className: "placeable-fields" }, ...fields.map((f) => f.control)),
        el("h3", {}, "Placement information"), out,
        el("details", {}, el("summary", {}, "Parameters as JSON"), json),
      ),
    ),
  );
  update();
  repaint = () => { if (!root.hidden) paints.forEach((p) => p()); };
  if (!resizes) (resizes = new ResizeObserver(() => repaint())).observe(root);
  repaint();
}
