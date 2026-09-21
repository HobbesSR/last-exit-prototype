import { generateMap } from "./src/core.js";
import { readFileSync } from "fs";

const lib = JSON.parse(readFileSync("content/default-library.json", "utf-8"));
const map = generateMap(12345, { columns: 10, rows: 10, tileSize: 6, contestantRadius: 0.55, hunterRadius: 0.9 }, lib);
console.log(map.tiles.length, map.width, map.height);
