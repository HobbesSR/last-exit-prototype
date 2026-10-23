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
/** Paints the tab's canvases. A canvas's bitmap is sized when painted, so a resize repaints. */
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
  const ratio = window.devicePixelRatio || 1, width = canvas.clientWidth || canvas.width, height = canvas.clientHeight || canvas.height;
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

/** One parameter's input. A value that won't parse is kept as typed, so `placeableErrors` names it. */
function field(spec: ParamSpec, rerender: () => void): HTMLElement {
  const value = params[spec.name], set = (next: unknown) => { params = { ...params, [spec.name]: next }; rerender(); };
  if (spec.kind === "boolean") {
    const input = el("input", { type: "checkbox", name: spec.name, checked: value === true });
    input.onchange = () => set(input.checked);
    return el("label", { className: "placeable-check", title: spec.summary }, input, spec.name);
  }
  if (spec.kind === "enum") {
    const select = el("select", { name: spec.name }, ...spec.values.map((v) => el("option", { value: v, selected: v === value }, v)));
    select.onchange = () => set(select.value);
    return el("label", { title: spec.summary }, spec.name, select);
  }
  const input = el("input", { type: "number", name: spec.name, min: String(spec.min), max: String(spec.max), step: spec.kind === "int" ? "1" : "0.05", value: String(value ?? "") });
  input.onchange = () => set(input.value.trim() === "" ? undefined : Number(input.value));
  return el("label", { title: spec.summary }, `${spec.name} (${spec.min}–${spec.max})`, input);
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

export function renderPlaceables(root: HTMLElement): void {
  const rerender = () => renderPlaceables(root);
  const paints: Array<() => void> = [];
  const placeable = PLACEABLES[selected]!;
  const list = el("div", { className: "placeable-list" }, ...ids.map((id) => {
    const p = PLACEABLES[id]!, button = el("button", { type: "button", className: id === selected ? "active" : "" },
      el("strong", {}, id), el("span", {}, p.version));
    button.dataset.placeable = id;
    button.onclick = () => { selected = id; params = { ...p.examples[0] }; rerender(); };
    return button;
  }));
  const fields = el("div", { className: "placeable-fields" }, ...placeable.params.map((spec) => field(spec, rerender)));
  const traceToggle = el("input", { type: "checkbox", checked: traced });
  traceToggle.onchange = () => { traced = traceToggle.checked; rerender(); };

  const current = result(placeable, params), canvas = el("canvas", { className: "placeable-preview" });
  const examples = el("div", { className: "placeable-examples" }, ...placeable.examples.map((example, i) => {
    const r = result(placeable, example), thumb = el("canvas"), same = JSON.stringify(example) === JSON.stringify(params);
    const card = el("button", { type: "button", className: same ? "active" : "", title: JSON.stringify(example) }, thumb,
      "elements" in r ? `Example ${i + 1}` : `Example ${i + 1}: ${readout(r, placeable.id)[0]}`);
    card.onclick = () => { params = { ...example }; rerender(); };
    if ("elements" in r) paints.push(() => paint(thumb, r, placeable.id, false));
    return card;
  }));

  root.replaceChildren(
    el("div", { className: "chain-heading" }, el("div", {}, el("h2", {}, "Placeables"),
      el("p", {}, `The things builders put down (20.8), built at ${CELL} units a cell. A builder chooses where; a placeable owns what it is and the area it demands.`))),
    el("div", { className: "chain-layout" },
      el("aside", { className: "chain-sidebar" }, list),
      el("div", { className: "chain-work" },
        el("div", {}, el("h3", { className: "placeable-title" }, `${placeable.id} `, el("span", {}, placeable.version)), el("p", { className: "hint" }, placeable.summary)),
        examples,
        el("h3", {}, "Parameters"),
        fields,
        el("pre", { className: "readout" + ("elements" in current ? "" : " invalid") }, readout(current, placeable.id).join("\n")),
        el("label", { className: "placeable-check" }, traceToggle, "Building trace: spaces, allocation and openings"),
        canvas,
        el("div", { className: "placeable-legend" },
          ...[["body", BODY], ["clear", CLEAR], ...PARTS.map((part) => [part, PART_FILL[part]])].map(([name, colour]) => {
            const swatch = el("i");
            swatch.style.background = colour!;
            return el("span", {}, swatch, name!);
          })),
        el("details", {}, el("summary", {}, "Parameters as JSON"), el("pre", {}, JSON.stringify(params, null, 2))),
      )),
  );
  if ("elements" in current) paints.push(() => paint(canvas, current, placeable.id, traced));
  repaint = () => paints.forEach((p) => p());
  if (!resizes) (resizes = new ResizeObserver(() => repaint())).observe(root);
  repaint();
}
