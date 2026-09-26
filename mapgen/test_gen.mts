import fs from "fs";
import { generateMap, validateMap } from "./src/core.ts";

try {
  const map = generateMap("v2-test");
  const res = validateMap(map);
  console.log("Map generated. Valid:", res.valid);
  if (!res.valid) {
    console.log(JSON.stringify(res.errors.slice(0, 5), null, 2));
  }
} catch (e) {
  console.error(e);
}
