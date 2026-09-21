import { generateMap } from "./src/core.js";
import { readFileSync } from "fs";

const lib = JSON.parse(readFileSync("content/default-library.json", "utf-8"));

// monkey patch console to catch errors inside generateMap?
// generateMap throws if attempt hits 50!
// So it MUST have succeeded on SOME attempt!
console.log("Running...");
const map = generateMap(12345, { columns: 10, rows: 10 }, lib);
console.log("Success! map tiles length:", map.tiles.length);
