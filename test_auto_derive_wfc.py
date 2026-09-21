import re

with open("src/wfc.ts", "r", encoding="utf-8") as f:
    wfc = f.read()

# I will replace `if (!prop) return def;` with logic to auto-derive from cells.
derive_logic = """
    if (!prop) {
      if (isVertex || !design.cells) return def;
      // auto-derive from cells
      const cells = design.cells;
      const getMark = (x: number, y: number) => {
        const c = cells[y]?.[x] || ".";
        if (c === ".") return design.defaultCellClass || "any";
        return design.legend?.[c] || "any";
      };
      
      const derived: string[] = [];
      if (sourceSide === "N") {
        for (let x = 0; x < 6; x++) derived.push(getMark(x, 0));
      } else if (sourceSide === "S") {
        for (let x = 0; x < 6; x++) derived.push(getMark(x, 5));
      } else if (sourceSide === "W") {
        for (let y = 0; y < 6; y++) derived.push(getMark(0, y));
      } else if (sourceSide === "E") {
        for (let y = 0; y < 6; y++) derived.push(getMark(5, y));
      }
      
      let reversed = false;
      if (opt.orientation === 90 && (sourceSide === "E" || sourceSide === "W")) reversed = !reversed;
      if (opt.orientation === 180) reversed = !reversed;
      if (opt.orientation === 270 && (sourceSide === "N" || sourceSide === "S")) reversed = !reversed;
      if (reversed) derived.reverse();
      
      return derived;
    }
"""

wfc = wfc.replace("if (!prop) return def;", derive_logic)

with open("src/wfc.ts", "w", encoding="utf-8") as f:
    f.write(wfc)
