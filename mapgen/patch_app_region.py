with open("public/app.ts", "r", encoding="utf-8") as f:
    code = f.read()

old_logic = """          ctx.fillStyle = false
            ? "#0a1419"
            : overlay === "region"
              ? regionColor(regionIndexOf(i))
              : `hsl(${hash(cellClass) % 360} 32% 30%)`;"""

new_logic = """          ctx.fillStyle = false
            ? "#0a1419"
            : overlay === "region"
              ? cellClass === "open"
                ? "#6a7682"
                : regionColor(regionIndexOf(i))
              : cellClass === "open"
                ? "#6a7682"
                : `hsl(${hash(cellClass) % 360} 32% 30%)`;"""

if old_logic in code:
    with open("public/app.ts", "w", encoding="utf-8") as f:
        f.write(code.replace(old_logic, new_logic))
    print("SUCCESS")
else:
    print("FAILED")
