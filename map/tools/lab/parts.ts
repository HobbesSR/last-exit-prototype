import { elementShapes } from "../../micro/geometry.ts";
import type { RegionElement } from "../../micro/types.ts";
import { outline } from "../../../shared/shape.ts";
import type { ObstacleKind } from "../../../shared/types.ts";

/** What a built element's parts are, each drawn in a colour of its own: by the World tab's layers and the Placeables tab. */
export type Part = "walls" | "ruins" | "cover" | "windows" | "pipes" | "doors" | "roofs";
export const PARTS: Part[] = ["walls", "ruins", "cover", "windows", "pipes", "doors", "roofs"];
// Chain maps place every door closed and unlocked (micro's adapter), so one colour says it.
export const PART_FILL: Record<Part, string> = {
  walls: "#c3ccc7", ruins: "#9b8a72", cover: "#6e9a72", windows: "#6fc8ff", pipes: "#c79a5b", doors: "#d66955", roofs: "#7a4f74",
};
/** Every obstacle kind's part, so a new kind can't be drawn as nothing. */
const OBSTACLE_PART: Record<ObstacleKind, Part> = {
  building: "walls", "ruin-wall": "ruins", container: "cover", crate: "cover", tree: "cover", hedge: "cover", window: "windows", pipe: "pipes",
};

export const partPaths = (): Record<Part, Path2D> => Object.fromEntries(PARTS.map((part) => [part, new Path2D()])) as Record<Part, Path2D>;

/**
 * An element's colliders and gates (`elementShapes`) and roofs (an enclosing element's
 * footprint), added to `paths` in cell units, with `add` called once for each part.
 * `elementShapes` gives one shape per obstacle or gate part, in part order, so each shape
 * takes the part it came from.
 */
export function addElementParts(element: RegionElement, cellSize: number, paths: Record<Part, Path2D>, add: (part: Part) => void): void {
  const drawn = element.template.parts.filter((part) => part.part === "obstacle" || part.part === "gate");
  elementShapes(element, true).forEach((shape, i) => {
    const source = drawn[i]!, part = source.part === "obstacle" ? OBSTACLE_PART[source.kind] : "doors";
    outline(shape).forEach((p, j) => (j ? paths[part].lineTo(p.x / cellSize, p.y / cellSize) : paths[part].moveTo(p.x / cellSize, p.y / cellSize)));
    paths[part].closePath();
    add(part);
  });
  if (element.template.roofs?.length) {
    for (const roof of element.template.roofs) {
      const rx = (element.x + (roof.origin?.x ?? 0)) / cellSize;
      const ry = (element.y + (roof.origin?.y ?? 0)) / cellSize;
      for (const c of roof.cells) {
        paths.roofs.rect(rx + c.x, ry + c.y, 1, 1);
      }
      add("roofs");
    }
  } else if (element.template.encloses) {
    paths.roofs.rect(element.x / cellSize, element.y / cellSize, element.template.w / cellSize, element.template.h / cellSize);
    add("roofs");
  }
}
