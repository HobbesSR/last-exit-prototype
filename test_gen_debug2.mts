import { generateMap } from "./src/core.js";
import { readFileSync } from "fs";

const lib = JSON.parse(readFileSync("content/default-library.json", "utf-8"));
try {
  generateMap("test", {}, lib, (s) => console.log(s));
  console.log("Success");
} catch (e) {
  console.log(e.message);
}
