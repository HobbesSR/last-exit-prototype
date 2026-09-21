# -*- coding: utf-8 -*-
import re

with open("public/app.ts", "r", encoding="utf-8") as f:
    app = f.read()

new_build = """
let generationWorker: Worker | null = null;
const progressModal = document.getElementById("progressModal") as HTMLDialogElement;
const progressStatus = document.getElementById("progressStatus") as HTMLParagraphElement;
const progressBar = document.getElementById("progressBar") as HTMLDivElement;

document.getElementById("cancelGeneration")?.addEventListener("click", () => {
  if (generationWorker) {
    generationWorker.terminate();
    generationWorker = null;
  }
  progressModal?.close();
  $("status").textContent = "Generation canceled.";
  $("status").className = "error";
});

function build() {
  if (generationWorker) generationWorker.terminate();
  
  progressStatus.textContent = "Starting...";
  progressBar.style.width = "0%";
  progressModal?.showModal();

  generationWorker = new Worker(new URL("/src/worker/generator.worker.ts", window.location.href), { type: "module" });
  
  generationWorker.onmessage = (e) => {
    const data = e.data;
    if (data.type === "progress") {
      progressStatus.textContent = data.status;
      progressBar.style.width = `${Math.min(100, Math.max(0, data.progress * 100))}%`;
    } else if (data.type === "done") {
      progressModal?.close();
      generationWorker = null;
      
      const next = data.map;
      if (!next.validation.valid) {
        $("status").textContent = next.validation.errors.join("\\n");
        $("status").className = "error";
        return;
      }
      map = next;
      builtLibraryRevision = libraryRevision;
      const index = new Int32Array(map.grid.width * map.grid.height).fill(-1);
      map.regions.forEach((region: any, position: number) => {
        for (const cellIndex of region.cells) index[cellIndex] = position;
      });
      cellRegion = index;
      selected = null;
      routes = routePaths();
      fit();
      $("status").textContent = `Validated map: ${map.tiles.length} tiles, ${map.zones.length} zones, seed ${map.seed}`;
      $("status").className = "";
      $("extent").textContent = `${map.params.columns} x ${map.params.rows} tiles, ${map.width} x ${map.height} cells`;
    } else if (data.type === "error") {
      progressModal?.close();
      generationWorker = null;
      $("status").textContent = data.error;
      $("status").className = "error";
    }
  };

  generationWorker.postMessage({
    seed: input("seed").value,
    params: {
      zoneWidth: Number(input("zoneWidth").value),
      zoneHeight: Number(input("zoneHeight").value),
      exitCount: Number(input("exits").value),
    },
    library
  });
}
"""

app = re.sub(r'function build\(\) \{.*?(?=new ResizeObserver\(resize\)\.observe\(canvas\);)', new_build + '\n', app, flags=re.DOTALL)

with open("public/app.ts", "w", encoding="utf-8") as f:
    f.write(app)
