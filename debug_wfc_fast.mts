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
console.log("Domain size:", tiles.length);

for (let y = 0; y < 30; y++) {
  for (let x = 0; x < 60; x++) {
    grid.push({
      x, y,
      n: y > 0 ? (y - 1) * 60 + x : undefined,
      s: y < 29 ? (y + 1) * 60 + x : undefined,
      e: x < 59 ? y * 60 + (x + 1) : undefined,
      w: x > 0 ? y * 60 + (x - 1) : undefined,
      tl: y > 0 && x > 0 ? (y - 1) * 60 + (x - 1) : undefined,
      tr: y > 0 && x < 59 ? (y - 1) * 60 + (x + 1) : undefined,
      bl: y < 29 && x > 0 ? (y + 1) * 60 + (x - 1) : undefined,
      domain: [...tiles]
    });
  }
}

console.log("Start solve");
const start = Date.now();
const state = { iterations: 0, maxIterations: 10000 };
const solved = solveWfc(grid, 60, 30, lib.tiles, Math.random, state);
console.log("Done in", Date.now() - start, "ms", "Iterations:", state.iterations);
