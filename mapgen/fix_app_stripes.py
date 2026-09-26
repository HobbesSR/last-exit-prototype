import re
with open("public/app.ts", "r", encoding="utf-8") as f:
    app_code = f.read()

# Add a new option to the overlay select in index.html, or just handle it here.
# Actually, the user asked to change `region` to be stable colors, and `components` to be contiguous.
# "Maybe we save that distinct region coloring view as a new view, but when looking at regions, we let each region type have a disctinct color that is stable across the map."

# Let's search for the `select("overlay")` logic.
#   const overlay = select("overlay").value;
#   if (overlay === "region" || overlay === "class") {

region_color_logic = """
          const origClass = views.originalClass ? views.originalClass(i) : cellClass;
          const drawStripes = origClass === "any" && cellClass !== "open" && cellClass !== "any";
          
          let cellColor = "#5a6268";
          if (cellClass !== "open") {
            if (overlay === "components") cellColor = regionColor(regionIndexOf(i));
            else cellColor = `hsl(${hash(cellClass) % 360} 32% 30%)`;
          }
          
          ctx.fillStyle = false ? "#0a1419" : cellColor;
          ctx.fillRect(x, y, 1, 1);
          
          if (drawStripes) {
            ctx.fillStyle = "#5a6268";
            ctx.fillRect(x, y, 1, 1);
            
            ctx.fillStyle = cellColor; // stripe color
            // Thinner stripes (e.g., 3-4 per cell)
            ctx.beginPath();
            for(let o = -1; o < 2; o += 0.5) {
              ctx.moveTo(x + o, y);
              ctx.lineTo(x + o + 0.25, y);
              ctx.lineTo(x + o + 1.25, y + 1);
              ctx.lineTo(x + o + 1, y + 1);
            }
            ctx.fill();
          }
"""

pattern_cell = re.compile(r'const origClass = views\.originalClass \?.*?ctx\.fill\(\);\s*\}', re.DOTALL)
app_code = pattern_cell.sub(region_color_logic.strip(), app_code)

# Remove the old constraint painting inside the cell loop
pattern_old_constraints = re.compile(r'const constraint = views\.constraints \? views\.constraints\(i\) : "any";\s*if \(constraint !== "any"\) \{.*?\}\s*\}', re.DOTALL)
app_code = pattern_old_constraints.sub('}', app_code)

# Now we need to draw segment constraints AFTER the cell loop, or in the segment loop if there is one.
# There is a segment loop in `app.ts`? "for (let y = 0; y <= map.grid.height; y++) {"
# Let's find it.
# Actually, let's just append a dedicated loop for segment constraints right after the cell loop.
# The cell loop is:
#       for (let y = 0; y < map.grid.height; y++)
#         for (let x = 0; x < map.grid.width; x++) { ... }
#     } else {
# Let's insert before `} else {`

segment_constraint_loop = """
      if (views.constraints) {
        const W = map.grid.width;
        const H = map.grid.height;
        const vOffset = (W + 1) * H;
        
        for (let y = 0; y <= H; y++) {
          for (let x = 0; x <= W; x++) {
            if (x < W) {
              const hIdx = y * (W + 1) + x;
              const hCon = views.constraints(hIdx);
              if (hCon && hCon !== "any") {
                ctx.fillStyle = hCon === "open" ? "#5a6268" : `hsl(${hash(hCon) % 360} 32% 30%)`;
                ctx.fillRect(x, y - 0.1, 1, 0.2);
              }
            }
            if (y < H) {
              const vIdx = vOffset + y * W + x;
              const vCon = views.constraints(vIdx);
              if (vCon && vCon !== "any") {
                ctx.fillStyle = vCon === "open" ? "#5a6268" : `hsl(${hash(vCon) % 360} 32% 30%)`;
                ctx.fillRect(x - 0.1, y, 0.2, 1);
              }
            }
          }
        }
      }
"""

# Insert it at the end of the `if (overlay === "region" || ... )` block
app_code = app_code.replace(
    '      }\n  } else {',
    '      }\n' + segment_constraint_loop + '  } else {'
)

# And add "components" to the condition
app_code = app_code.replace(
    'if (overlay === "region" || overlay === "class") {',
    'if (overlay === "region" || overlay === "class" || overlay === "components") {'
)

with open("public/app.ts", "w", encoding="utf-8") as f:
    f.write(app_code)

with open("public/index.html", "r", encoding="utf-8") as f:
    html = f.read()

html = html.replace(
    '<option value="region">Region</option>',
    '<option value="region">Region</option>\n          <option value="components">Components</option>'
)

with open("public/index.html", "w", encoding="utf-8") as f:
    f.write(html)

print("done app")
