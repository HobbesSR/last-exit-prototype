import { getDifficulty, solveWfc, WfcGrid, TileOption } from "./src/wfc.js";
import { readFileSync } from "fs";

const lib = JSON.parse(readFileSync("content/default-library.json", "utf-8"));
const grid: WfcGrid = [];

const tiles: TileOption[] = lib.tiles.flatMap(t => 
  (t.orientations || [0]).map(o => ({
    templateId: t.id,
    orientation: o,
    difficulty: getDifficulty(t),
    weight: t.weight || 1
  }))
);

for (let y = 0; y < 2; y++) {
  for (let x = 0; x < 2; x++) {
    grid.push({
      x, y,
      n: y > 0 ? (y - 1) * 2 + x : undefined,
      s: y < 1 ? (y + 1) * 2 + x : undefined,
      e: x < 1 ? y * 2 + (x + 1) : undefined,
      w: x > 0 ? y * 2 + (x - 1) : undefined,
      tl: y > 0 && x > 0 ? (y - 1) * 2 + (x - 1) : undefined,
      tr: y > 0 && x < 1 ? (y - 1) * 2 + (x + 1) : undefined,
      bl: y < 1 && x > 0 ? (y + 1) * 2 + (x - 1) : undefined,
      domain: [...tiles]
    });
  }
}

const state = { iterations: 0, maxIterations: 10000 };
console.log("Start 2x2 solve");
const res = solveWfc(grid, 2, 2, lib.tiles, Math.random, state);
console.log("Done", res !== null);
