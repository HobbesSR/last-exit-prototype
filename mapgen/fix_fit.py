with open("public/app.ts", "r", encoding="utf-8") as f:
    app_code = f.read()

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

with open("public/app.ts", "w", encoding="utf-8") as f:
    f.write(app_code)
print("done")
