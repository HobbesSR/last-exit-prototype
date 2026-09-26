import { generateMap } from "./src/core.js";
import { getRotatedEdge, matchEdge } from "./src/wfc.js";
import { readFileSync } from "fs";

const lib = JSON.parse(readFileSync("content/default-library.json", "utf-8"));

for (const sp of lib.setPieces || []) {
  // test horizontal and vertical adjacency
  for (let i = 0; i < sp.tiles.length; i++) {
    for (let j = i + 1; j < sp.tiles.length; j++) {
      const t1 = sp.tiles[i];
      const t2 = sp.tiles[j];
      
      const dx = t2.dx - t1.dx;
      const dy = t2.dy - t1.dy;
      
      if (Math.abs(dx) + Math.abs(dy) === 1) {
        // adjacent!
        const set1 = lib.tileSets.find(s => s.id === t1.tileSetId);
        const set2 = lib.tileSets.find(s => s.id === t2.tileSetId);
        
        for (const m1 of set1.members) {
          for (const m2 of set2.members) {
            const opt1 = { templateId: m1, orientation: t1.orientation };
            const opt2 = { templateId: m2, orientation: t2.orientation };
            
            let side1, side2;
            if (dx === 1) { side1 = "E"; side2 = "W"; }
            else if (dx === -1) { side1 = "W"; side2 = "E"; }
            else if (dy === 1) { side1 = "S"; side2 = "N"; }
            else if (dy === -1) { side1 = "N"; side2 = "S"; }
            
            if (!matchEdge(opt1 as any, side1 as any, opt2 as any, side2 as any, lib.tiles)) {
              console.log(`Mismatch in SetPiece ${sp.id}: ${m1} (${side1}) -> ${m2} (${side2})`);
              const e1 = getRotatedEdge(opt1 as any, side1 as any, lib.tiles);
              const e2 = getRotatedEdge(opt2 as any, side2 as any, lib.tiles);
              console.log(`  ${e1}`);
              console.log(`  ${e2}`);
            }
          }
        }
      }
    }
  }
}
