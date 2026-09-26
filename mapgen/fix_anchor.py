with open("src/core.ts", "r", encoding="utf-8") as f:
    content = f.read()

original = """
      const findAnchor = (design: TileDesign, _deg: number): Point => {
        const anyDesign = design as any;
        if (anyDesign.anchor) {
           return { x: anyDesign.anchor.x, y: anyDesign.anchor.y };
        }
        return { x: p.tileSize / 2, y: p.tileSize / 2 };
      };
"""

replacement = """
      const findAnchor = (design: TileDesign, deg: number): Point => {
        const anyDesign = design as any;
        if (anyDesign.anchor) {
           let ax = anyDesign.anchor.x;
           let ay = anyDesign.anchor.y;
           
           if (deg === 90) { let t = ax; ax = p.tileSize - ay; ay = t; }
           else if (deg === 180) { ax = p.tileSize - ax; ay = p.tileSize - ay; }
           else if (deg === 270) { let t = ax; ax = ay; ay = p.tileSize - t; }
           
           return { x: ax, y: ay };
        }
        return { x: p.tileSize / 2, y: p.tileSize / 2 };
      };
"""

content = content.replace(original.strip(), replacement.strip())

with open("src/core.ts", "w", encoding="utf-8") as f:
    f.write(content)
