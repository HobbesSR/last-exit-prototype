with open("public/app.ts", "r", encoding="utf-8") as f:
    app_code = f.read()

button_wireup = """
  const zoomIn = document.getElementById("zoomIn");
  if (zoomIn) zoomIn.addEventListener("click", () => {
    const center = world({ x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 });
    zoom = Math.min(40, zoom * 1.5);
    pan = { x: canvas.clientWidth / 2 - center.x * zoom, y: canvas.clientHeight / 2 - center.y * zoom };
    updateZoomUI();
    requestAnimationFrame(draw);
  });
  const zoomOut = document.getElementById("zoomOut");
  if (zoomOut) zoomOut.addEventListener("click", () => {
    const center = world({ x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 });
    zoom = Math.max(1, zoom / 1.5);
    pan = { x: canvas.clientWidth / 2 - center.x * zoom, y: canvas.clientHeight / 2 - center.y * zoom };
    updateZoomUI();
    requestAnimationFrame(draw);
  });
"""

# Append just before `fetchAndRegenerate();` at the end
app_code = app_code.replace("fetchAndRegenerate();\n", button_wireup + "\nfetchAndRegenerate();\n")

with open("public/app.ts", "w", encoding="utf-8") as f:
    f.write(app_code)
print("done")
