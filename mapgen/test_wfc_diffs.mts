import { readFileSync } from "fs";
import { getDifficulty } from "./src/wfc.js";

const lib = JSON.parse(readFileSync("content/default-library.json", "utf-8"));
for (const t of lib.tiles) {
  console.log(t.id, "Difficulty:", getDifficulty(t));
}
