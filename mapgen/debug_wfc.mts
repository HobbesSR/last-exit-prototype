import { getDifficulty, solveWfc, WfcGrid, propagate } from "./src/wfc.js";
import { readFileSync } from "fs";

const lib = JSON.parse(readFileSync("content/default-library.json", "utf-8"));
const grid: WfcGrid = [];

const tiles = lib.tiles.map(t => ({
  templateId: t.id,
  orientation: 0,
  difficulty: getDifficulty(t)
}));

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

console.log("Start solve");
const start = Date.now();
const solved = solveWfc(grid, 10, 10, lib.tiles, Math.random);
console.log("Done in", Date.now() - start, "ms");
