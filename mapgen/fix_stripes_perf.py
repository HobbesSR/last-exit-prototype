import re
with open("public/app.ts", "r", encoding="utf-8") as f:
    app_code = f.read()

perf_stripes = """
            ctx.fillStyle = "#5a6268";
            ctx.fillRect(x, y, 1, 1);
            if (zoom > 3) {
              ctx.fillStyle = cellColor;
              ctx.beginPath();
              ctx.moveTo(x - 0.5, y); ctx.lineTo(x - 0.2, y); ctx.lineTo(x + 0.8, y + 1); ctx.lineTo(x + 0.5, y + 1);
              ctx.moveTo(x + 0.5, y); ctx.lineTo(x + 0.8, y); ctx.lineTo(x + 1.8, y + 1); ctx.lineTo(x + 1.5, y + 1);
              ctx.fill();
            } else {
              // When zoomed out, just draw a blended color
              ctx.fillStyle = cellColor;
              ctx.globalAlpha = 0.5;
              ctx.fillRect(x, y, 1, 1);
              ctx.globalAlpha = 1.0;
            }
"""

# Replace the stripe logic
# We need to find the `ctx.fillStyle = "#5a6268"; ctx.fillRect(x, y, 1, 1); ... ctx.fill();` block
app_code = re.sub(
    r'ctx\.fillStyle = "\#5a6268";\s*ctx\.fillRect\(x, y, 1, 1\);\s*ctx\.fillStyle = cellColor; // stripe color\s*// Thinner stripes .*?ctx\.fill\(\);',
    perf_stripes.strip(),
    app_code,
    flags=re.DOTALL
)

with open("public/app.ts", "w", encoding="utf-8") as f:
    f.write(app_code)
print("done")
