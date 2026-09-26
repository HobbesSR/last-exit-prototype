import { matchEdge, getRotatedEdge } from "./src/wfc.js";
import { readFileSync } from "fs";

const lib = JSON.parse(readFileSync("content/default-library.json", "utf-8"));

const edge = { templateId: "open-hut-edge", orientation: 0, difficulty: 0, weight: 1, id: 0 };
const street = { templateId: "street", orientation: 0, difficulty: 0, weight: 1, id: 1 };

console.log("Edge S:", getRotatedEdge(edge as any, "S", lib.tiles));
console.log("Street N:", getRotatedEdge(street as any, "N", lib.tiles));

console.log("Match Edge S -> Street N:", matchEdge(edge as any, "S", street as any, "N", lib.tiles));
