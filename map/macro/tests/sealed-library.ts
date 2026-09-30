/**
 * A library whose only design besides the street seals its own interior (#34).
 * V2 places it today and returns an invalid map.
 */
import { DEFAULT_LIBRARY } from "../src/core.ts";
import type { Library } from "../src/types.ts";

export const SEALED_PARAMS = { mode: "playground" as const, zoneWidth: 2, zoneHeight: 1 };

export function sealedLibrary(): Library {
  const sealed = {
    id: "sealed",
    defaultCellClass: "court",

    orientations: [0] as const,
    ports: {
      N: ["any", "any", "any", "any", "any", "any"],
      E: ["any", "any", "any", "any", "any", "any"],
      S: ["any", "any", "any", "any", "any", "any"],
      W: "any",
    },
    // A ring on the margin: every seam opens onto a one-cell strip that no
    // body fits through, and nothing inside is reachable from outside.
    walls: [
      { x1: 1, y1: 1, x2: 5, y2: 1 },
      { x1: 1, y1: 5, x2: 5, y2: 5 },
      { x1: 1, y1: 1, x2: 1, y2: 5 },
      { x1: 5, y1: 1, x2: 5, y2: 5 },
    ],
  };
  const library = structuredClone(DEFAULT_LIBRARY);
  library.tiles = [
    library.tiles.find((t) => t.id === "street")!,
    sealed as unknown as (typeof library.tiles)[number],
  ];
  library.tileSets = [{ id: "all", members: ["street", "sealed"] }];
  library.setPieces = [];
  library.cellClasses = { ...library.cellClasses, court: {} };
  return library;
}
