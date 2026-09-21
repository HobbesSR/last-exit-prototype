with open("public/app.ts", "r", encoding="utf-8") as f:
    app_code = f.read()

# Fix the hIdx and vIdx in app.ts
old_loop = """            if (x < W) {
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
            }"""

new_loop = """            if (x < W) {
              // horizontal: vOffset + line(y) * width + offset(x)
              const hIdx = vOffset + y * W + x;
              const hCon = views.constraints(hIdx);
              if (hCon && hCon !== "any") {
                ctx.fillStyle = hCon === "open" ? "#5a6268" : `hsl(${hash(hCon) % 360} 32% 30%)`;
                ctx.fillRect(x, y - 0.1, 1, 0.2);
              }
            }
            if (y < H) {
              // vertical: offset(y) * (width + 1) + line(x)
              const vIdx = y * (W + 1) + x;
              const vCon = views.constraints(vIdx);
              if (vCon && vCon !== "any") {
                ctx.fillStyle = vCon === "open" ? "#5a6268" : `hsl(${hash(vCon) % 360} 32% 30%)`;
                ctx.fillRect(x - 0.1, y, 0.2, 1);
              }
            }"""

app_code = app_code.replace(old_loop, new_loop)

with open("public/app.ts", "w", encoding="utf-8") as f:
    f.write(app_code)
print("done")
