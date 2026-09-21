import re
with open("public/app.ts", "r", encoding="utf-8") as f:
    app_code = f.read()

# We want to insert the constraint drawing after the stripes are drawn in the loop.
# The loop looks like:
#           if (drawStripes) { ... }
# We'll append the constraint drawing.

pattern = re.compile(r'(ctx\.fill\(\);\s*\}\s*)(?=\}\s*\} else \{)')

constraint_injection = """
          const constraint = views.constraints ? views.constraints(i) : "any";
          if (constraint !== "any") {
            ctx.fillStyle = constraint === "open" ? "#5a6268" : `hsl(${hash(constraint) % 360} 32% 30%)`;
            const tSize = 6;
            const w = 0.2; // 20% thickness
            if (x % tSize === 0) ctx.fillRect(x, y, w, 1);
            if (x % tSize === tSize - 1) ctx.fillRect(x + 1 - w, y, w, 1);
            if (y % tSize === 0) ctx.fillRect(x, y, 1, w);
            if (y % tSize === tSize - 1) ctx.fillRect(x, y + 1 - w, 1, w);
          }
"""

app_code = pattern.sub(r'\1' + constraint_injection.lstrip(), app_code)

with open("public/app.ts", "w", encoding="utf-8") as f:
    f.write(app_code)
print("done")
