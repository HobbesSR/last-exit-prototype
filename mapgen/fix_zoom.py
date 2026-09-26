import re
with open("public/app.ts", "r", encoding="utf-8") as f:
    app_code = f.read()

# Let's add updateZoomUI
update_zoom_func = """
  function updateZoomUI() {
    const zl = document.getElementById("zoomLevel");
    if (zl) zl.textContent = Math.round(zoom * 100) + "%";
  }
"""
app_code = app_code.replace("function fit() {", update_zoom_func + "  function fit() {")

# Add updateZoomUI to fit()
app_code = app_code.replace("""  function fit() {
    if (!map) return;
    zoom = Math.min(
      (canvas.clientWidth - 70) / map.width,
      (canvas.clientHeight - 105) / map.height,
    );
    pan = {
      x: (canvas.clientWidth - map.width * zoom) / 2,
      y: (canvas.clientHeight - map.height * zoom) / 2 - 10,
    };
  }""", """  function fit() {
    if (!map) return;
    zoom = Math.min(
      (canvas.clientWidth - 70) / map.width,
      (canvas.clientHeight - 105) / map.height,
    );
    pan = {
      x: (canvas.clientWidth - map.width * zoom) / 2,
      y: (canvas.clientHeight - map.height * zoom) / 2 - 10,
    };
    updateZoomUI();
  }""")

# Find wheel event
# zoom = Math.max(1, Math.min(40, zoom * Math.exp(-e.deltaY * 0.001)));
app_code = app_code.replace(
    'zoom = Math.max(1, Math.min(40, zoom * Math.exp(-e.deltaY * 0.001)));',
    'zoom = Math.max(1, Math.min(40, zoom * Math.exp(-e.deltaY * 0.001))); updateZoomUI();'
)

# Wire up the buttons
# I will append to window.addEventListener('load') or just at the end.
# Actually there's a big block at the end.
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
app_code = app_code.replace('canvas.addEventListener("wheel",', button_wireup + 'canvas.addEventListener("wheel",')

with open("public/app.ts", "w", encoding="utf-8") as f:
    f.write(app_code)
print("done")
