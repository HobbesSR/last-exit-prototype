/** Diagnostics pane sizing and persisted collapse/height state (53.1). */
export function mountDiagnosticsResizer(
  resizer: HTMLDivElement, diagnosticsPane: HTMLDivElement, worldMain: HTMLElement,
): void {
  let paneCollapsed = false;
  let paneHeight = 0;

  const savedResizer = (() => {
    try { return localStorage.getItem("mapLabDiagnostics"); }
    catch (e) { return null; }
  })();

  if (savedResizer) {
    try {
      const state = JSON.parse(savedResizer);
      if (state.collapsed) paneCollapsed = true;
      if (state.height) paneHeight = state.height;
    } catch (e) {}
  }

  function saveResizerState() {
    try {
      localStorage.setItem("mapLabDiagnostics", JSON.stringify({
        collapsed: paneCollapsed,
        height: paneHeight
      }));
    } catch (e) {}
  }

  function applyPaneHeight() {
    if (paneCollapsed) {
      resizer.classList.add("collapsed");
      diagnosticsPane.classList.add("collapsed");
      diagnosticsPane.style.height = '';
      diagnosticsPane.style.maxHeight = '';
      return;
    }
    resizer.classList.remove("collapsed");
    diagnosticsPane.classList.remove("collapsed");

    if (paneHeight) {
      if (!worldMain.clientHeight) return; // Skip clamp when hidden
      const maxH = worldMain.clientHeight - 240 - resizer.offsetHeight;
      let newH = paneHeight;
      if (newH < 40) newH = 40;
      if (newH > maxH) newH = maxH;

      paneHeight = newH; // store the clamped value
      diagnosticsPane.style.height = `${newH}px`;
      diagnosticsPane.style.maxHeight = 'none';
    } else {
      diagnosticsPane.style.height = '';
      diagnosticsPane.style.maxHeight = '';
    }
  }

  function toggleResizer() {
    paneCollapsed = !paneCollapsed;
    applyPaneHeight();
    saveResizerState();
  }

  resizer.onkeydown = (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleResizer();
    }
  };

  let resizerDrag: { startY: number; startHeight: number; moved: boolean } | null = null;
  resizer.onpointerdown = (event) => {
    resizer.setPointerCapture(event.pointerId);
    resizerDrag = { startY: event.clientY, startHeight: diagnosticsPane.offsetHeight, moved: false };
  };
  resizer.onpointermove = (event) => {
    if (!resizerDrag) return;
    const dy = resizerDrag.startY - event.clientY;
    if (Math.abs(dy) > 3) {
      if (!resizerDrag.moved) {
        paneCollapsed = false;
      }
      resizerDrag.moved = true;
    }
    if (!resizerDrag.moved) return;

    paneHeight = resizerDrag.startHeight + dy;
    applyPaneHeight();
  };
  const stopDrag = () => {
    if (resizerDrag) {
      if (resizerDrag.moved) saveResizerState();
      else toggleResizer();
    }
    resizerDrag = null;
  };
  const cancelDrag = () => {
    resizerDrag = null;
  };
  resizer.onpointerup = stopDrag;
  resizer.onpointercancel = cancelDrag;
  resizer.onlostpointercapture = cancelDrag;

  // Hook into window resize to re-clamp
  new ResizeObserver(() => {
    if (!paneCollapsed && paneHeight) applyPaneHeight();
  }).observe(worldMain);

  // Initial application
  applyPaneHeight();
}
