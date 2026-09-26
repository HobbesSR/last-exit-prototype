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

for (let y = 0; y < 10; y++) {
  for (let x = 0; x < 10; x++) {
    grid.push({
      x, y,
      n: y > 0 ? (y - 1) * 10 + x : undefined,
      s: y < 9 ? (y + 1) * 10 + x : undefined,
      e: x < 9 ? y * 10 + (x + 1) : undefined,
      w: x > 0 ? y * 10 + (x - 1) : undefined,
      tl: y > 0 && x > 0 ? (y - 1) * 10 + (x - 1) : undefined,
      tr: y > 0 && x < 9 ? (y - 1) * 10 + (x + 1) : undefined,
      bl: y < 9 && x > 0 ? (y + 1) * 10 + (x - 1) : undefined,
      domain: [...tiles]
    });
  }
}

const start = Date.now();
const state = { iterations: 0, maxIterations: 10000 };
console.log("Start 10x10 solve");
solveWfc(grid, 10, 10, lib.tiles, Math.random, state);
console.log("Done 10x10 in", Date.now() - start, "ms", state.iterations);
