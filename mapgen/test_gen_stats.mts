import { generateMap } from "./src/core.js";
import { readFileSync } from "fs";

const lib = JSON.parse(readFileSync("content/default-library.json", "utf-8"));
try {
  const map = generateMap("test", {columns: 10, rows: 10}, lib, () => {});
  const counts: Record<string, number> = {};
  for (const t of map.tiles) {
    counts[t.templateId] = (counts[t.templateId] || 0) + 1;
  }
  console.log(counts);
} catch (e) { console.error(e); }
