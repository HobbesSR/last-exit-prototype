import re
with open("public/app.ts", "r", encoding="utf-8") as f:
    app_code = f.read()

pattern = re.compile(r'ctx\.fillStyle = false \? "#0a1419" : overlay === "region" \? \(cellClass === "open" \? "#5a6268" : regionColor\(regionIndexOf\(i\)\)\) : \(cellClass === "open" \? "#5a6268" : `hsl\(\$\{hash\(cellClass\) % 360\} 32% 30%\)`\);\s*ctx\.fillRect\(x, y, 1, 1\);')

render_injection = """
          const origClass = views.originalClass ? views.originalClass(i) : cellClass;
          const drawStripes = origClass === "any" && cellClass !== "open" && cellClass !== "any";
          
          ctx.fillStyle = false ? "#0a1419" : overlay === "region" ? (cellClass === "open" ? "#5a6268" : regionColor(regionIndexOf(i))) : (cellClass === "open" ? "#5a6268" : `hsl(${hash(cellClass) % 360} 32% 30%)`);
          ctx.fillRect(x, y, 1, 1);
          
          if (drawStripes) {
            ctx.fillStyle = "#ffffff33";
            ctx.beginPath();
            ctx.moveTo(x, y + 0.5); ctx.lineTo(x + 0.5, y + 1); ctx.lineTo(x + 1, y + 1); ctx.lineTo(x + 1, y + 0.5); ctx.lineTo(x + 0.5, y); ctx.lineTo(x, y);
            ctx.fill();
            
            ctx.fillStyle = "#00000033";
            ctx.beginPath();
            ctx.moveTo(x + 0.5, y); ctx.lineTo(x + 1, y + 0.5); ctx.lineTo(x + 1, y);
            ctx.fill();
            ctx.beginPath();
            ctx.moveTo(x, y + 0.5); ctx.lineTo(x + 0.5, y + 1); ctx.lineTo(x, y + 1);
            ctx.fill();
          }
"""

app_code = pattern.sub(render_injection.strip(), app_code)

with open("public/app.ts", "w", encoding="utf-8") as f:
    f.write(app_code)
print("done")
