import re

with open("src/core.ts", "r", encoding="utf-8") as f:
    content = f.read()

replacement = """
      let reservedStreets;
      try {
        reservedStreets = planStreets(tiles, adj, grid, p, spawn, seedText);
      } catch (e) {
        console.log("planStreets failed:", e.message);
        continue; // Failed route, try next sample
      }
"""

content = re.sub(r'      let reservedStreets;\n      try \{\n        reservedStreets = planStreets\(tiles, adj, grid, p, spawn, seedText\);\n      \} catch \(e\) \{\n        continue; // Failed route, try next sample\n      \}', replacement.strip(), content, flags=re.DOTALL)

with open("src/core.ts", "w", encoding="utf-8") as f:
    f.write(content)
