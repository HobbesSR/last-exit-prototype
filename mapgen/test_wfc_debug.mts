import { generateMap } from "./src/core.js";
import { readFileSync } from "fs";

const lib = JSON.parse(readFileSync("content/default-library.json", "utf-8"));
const map = generateMap(12345, { columns: 10, rows: 10, tileSize: 6, contestantRadius: 0.55, hunterRadius: 0.9 }, lib);

const counts: Record<string, number> = {};
for (const tile of map.tiles) {
  counts[tile.templateId] = (counts[tile.templateId] || 0) + 1;
}

console.log("Tile Placement Counts:");
for (const [id, count] of Object.entries(counts)) {
  console.log(`${id}: ${count}`);
}
