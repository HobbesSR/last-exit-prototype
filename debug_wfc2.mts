import { getDifficulty, solveWfc, WfcGrid } from "./src/wfc.js";
import { readFileSync } from "fs";

const lib = JSON.parse(readFileSync("content/default-library.json", "utf-8"));
const grid: WfcGrid = [];

const tiles = lib.tiles.map(t => ({
  templateId: t.id,
  orientation: 0,
  difficulty: getDifficulty(t)
}));

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
const solved = solveWfc(grid, 60, 30, lib.tiles, Math.random);
console.log("Done in", Date.now() - start, "ms");
