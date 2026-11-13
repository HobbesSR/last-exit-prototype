import { validateLibrary } from "../../macro/src/chain/library.ts";
import type { ChainLibrary, ChainTileDesign } from "../../macro/src/chain/library.ts";
import { CHAIN_LIBRARIES, CHAIN_LIBRARY } from "../core.ts";
import { renderableDraft } from "./draft-safety.ts";
import { download } from "./download.ts";
import { state, $, select, area, declaredRegionTypeIds, section, list, current, option, field, heading, paragraph, status, changed, closePopup, configureAuthor } from "./chain-author-shared.ts";
import { renderClasses } from "./chain-author-classes.ts";
import { renderTiles, renderGallery } from "./chain-author-tiles.ts";
import { renderTileSets } from "./chain-author-tile-sets.ts";
import { renderSetPieces } from "./chain-author-set-pieces.ts";
import { renderSetPieceClasses } from "./chain-author-set-piece-classes.ts";
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closePopup();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (document.getElementById("chainViewContainer")?.hidden) return;

  const target = e.target as HTMLElement | null;
  if (target && ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;
  if (target && target.isContentEditable) return;

  const k = e.key.toLowerCase();

  // Search filter focus shortcut (/)
  if (k === "/") {
    let searchInput: HTMLElement | null = null;
    if (section() === "tiles") {
      searchInput = document.getElementById("tileFilter");
    } else if (section() === "tileSets") {
      searchInput = document.getElementById("setAvailableFilter");
    } else if (section() === "setPieces") {
      searchInput = document.getElementById("setPiecePaletteFilter");
    }
    if (searchInput) {
      searchInput.focus();
      if (document.activeElement === searchInput) {
        e.preventDefault();
      }
      return;
    }
  }

  // Hotkeys in tiles section
  if (section() === "tiles") {
    if (k === "d" || k === "b") {
      state.selectedPaintTool = "paint";
      render();
    } else if (k === "f") {
      state.selectedPaintTool = "fill";
      render();
    } else if (k === "r") {
      state.selectedPaintTool = "rect";
      render();
    } else if (k === "s") {
      state.selectedPaintTool = "segment";
      render();
    } else if (k === "e") {
      const tile = current() as ChainTileDesign | undefined;
      if (tile) {
        state.selectedCellClass = tile.defaultCellClass;
        render();
      }
    } else if (k >= "1" && k <= "9") {
      const idx = parseInt(k, 10) - 1;
      const classes = ["any", ...Object.keys(state.library.cellClasses)];
      if (idx < classes.length) {
        state.selectedCellClass = classes[idx]!;
        render();
      }
    }
  } else if (section() === "setPieces") {
    if (k >= "1" && k <= "9") {
      const idx = parseInt(k, 10) - 1;
      const filter = state.setPiecePaletteFilter.trim().toLowerCase();
      const matching = state.library.tileSets
        .map((s) => s.id)
        .filter((id) => !filter || id.toLowerCase().includes(filter));
      if (idx < matching.length) {
        state.activeLayoutBrush = matching[idx]!;
        render();
      }
    }
  }
});

function entries(): string[] {
  return section() === "classes"
    ? Object.keys(state.library.cellClasses)
    : list().map((entry) => entry.id);
}
/** Confirm an identity change using the references that will be updated or removed. */
function confirmReferences(action: "Rename" | "Delete", id: string, next?: string): boolean {
  const kind = section();
  if (kind !== "tiles" && kind !== "tileSets" && kind !== "setPieces") return true;
  const noun = kind === "tiles" ? "tile design" : kind === "tileSets" ? "tile set" : "set piece";
  const referenceNoun = kind === "tiles" ? "tile set(s)" : kind === "tileSets" ? "set piece(s)" : "set piece class(es)";
  const references = kind === "tiles"
    ? state.library.tileSets.filter((s) => s.members.includes(id)).map((s) => s.id)
    : kind === "tileSets"
      ? state.library.setPieces.filter((p) => p.tiles.some((slot) => slot.tileSetId === id)).map((p) => p.id)
      : state.library.setPieceClasses.filter((c) => c.setPieces.includes(id)).map((c) => c.id);
  if (action === "Rename" && !references.length) return true;
  let message = action + ' ' + noun + ' "' + id + '"' + (action === "Rename" ? ' to "' + next + '"?' : '?');
  if (references.length) {
    message += ' It is referenced in ' + referenceNoun + ': ' + references.join(", ") + '.';
    if (action === "Rename") message += ' References will be updated automatically.';
    else if (kind === "tileSets") message += ' Referencing slot(s) will be removed automatically.';
    else if (kind === "setPieces") message += ' References will be removed automatically.';
  }
  return confirm(message);
}
function rename(next: string): void | false {
  const old = state.selectedId;
  next = next.trim();
  if (!next || (next !== old && entries().includes(next))) {
    status(`Name must be unique and nonempty: ${next}`);
    return false;
  }
  if (!confirmReferences("Rename", old, next)) {
    render();
    return false;
  }
  if (section() === "classes") {
    state.library.cellClasses[next] = state.library.cellClasses[old]!;
    delete state.library.cellClasses[old];
    for (const tile of state.library.tiles) {
      if (tile.defaultCellClass === old) tile.defaultCellClass = next;
      for (const [mark, id] of Object.entries(tile.legend ?? {}))
        if (id === old) tile.legend![mark] = next;
      for (const segment of Object.values(tile.segments ?? {}))
        if (segment.adjacency === old) segment.adjacency = next;
    }
    for (const piece of state.library.setPieces)
      if (piece.primaryRegionClass === old) piece.primaryRegionClass = next;
  } else {
    current().id = next;
    if (section() === "tiles")
      for (const set of state.library.tileSets)
        set.members = set.members.map((id) => (id === old ? next : id));
    if (section() === "tileSets") {
      if (state.activeLayoutBrush === old) state.activeLayoutBrush = next;
      for (const piece of state.library.setPieces)
        for (const slot of piece.tiles)
          if (slot.tileSetId === old) slot.tileSetId = next;
    }
    if (section() === "setPieces")
      for (const group of state.library.setPieceClasses)
        group.setPieces = group.setPieces.map((id) => (id === old ? next : id));
  }
  state.selectedId = next;
}
function showEntries(names: string[]): void {
  const item = select("chainItem");
  if (JSON.stringify([...item.options].map((o) => o.value)) !== JSON.stringify(names))
    item.replaceChildren(...names.map((id) => option(id)));
  item.value = state.selectedId;
  // Tiles are browsed by thumbnail; every other section by its entry list (#539).
  const tiles = section() === "tiles";
  item.closest("label")!.style.display = tiles ? "" : "none";
  showEntryList(tiles ? [] : names);
}
/** A short description of an entry beside its ID in the entry list. */
function entrySummary(id: string): string {
  // A class whose region type repeats its ID needs no summary.
  if (section() === "classes") {
    const type = state.library.cellClasses[id]?.regionType ?? "";
    return type === id ? "" : type;
  }
  const entry = list().find((e) => e.id === id) as any;
  if (section() === "tileSets") return count(entry?.members?.length ?? 0, "tile");
  if (section() === "setPieces") return count(entry?.tiles?.length ?? 0, "slot");
  if (section() === "setPieceClasses")
    return [entry?.placementRule, typeof entry?.quota === "number" ? `×${entry.quota}` : ""].filter(Boolean).join(" ");
  return "";
}
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
/** The entry whose list row was last brought into view, so edits don't scroll the list. */
let shownEntry = "";
function showEntryList(names: string[]): void {
  const listed = $("chainEntryList");
  listed.style.display = section() === "tiles" ? "none" : "";
  if (!names.length) {
    if (!listed.querySelector(".gallery-empty")) {
      const empty = paragraph("No entries in this section.");
      empty.className = "gallery-empty";
      listed.replaceChildren(empty);
    }
    return;
  }
  const rows = [...listed.querySelectorAll<HTMLButtonElement>("button")];
  if (JSON.stringify(rows.map((row) => row.dataset.entry)) !== JSON.stringify(names))
    listed.replaceChildren(
      ...names.map((id) => {
        const row = document.createElement("button");
        row.type = "button";
        row.setAttribute("role", "option");
        row.dataset.entry = id;
        row.append(document.createElement("strong"), document.createElement("span"));
        row.firstElementChild!.textContent = id;
        row.onclick = () => {
          state.selectedId = id;
          render();
        };
        return row;
      }),
    );
  for (const row of listed.querySelectorAll<HTMLButtonElement>("button")) {
    const active = row.dataset.entry === state.selectedId;
    row.classList.toggle("active", active);
    row.setAttribute("aria-selected", String(active));
    // Only the active row is in the tab order; arrow keys move between rows.
    row.tabIndex = active ? 0 : -1;
    row.lastElementChild!.textContent = entrySummary(row.dataset.entry!);
  }
  const key = JSON.stringify([section(), state.selectedId]);
  if (key !== shownEntry) {
    shownEntry = key;
    listed.querySelector<HTMLElement>("button.active")?.scrollIntoView({ block: "nearest" });
  }
}
function render(): void {
  closePopup();
  state.refreshEditor = null;
  const names = entries();
  if (!names.includes(state.selectedId)) state.selectedId = names[0] ?? "";
  showEntries(names);
  renderGallery();
  const editor = $("chainSurface");
  const properties = $("chainProperties");
  const selection = JSON.stringify([section(), state.selectedId]);
  // Redrawing the same entry returns focus and caret to the control that had them.
  const focused = document.activeElement;
  const restore = editor.dataset.selection === selection && focused?.id &&
    (editor.contains(focused) || properties.contains(focused))
    ? { id: focused.id, start: (focused as HTMLInputElement).selectionStart, end: (focused as HTMLInputElement).selectionEnd }
    : null;
  if (editor.dataset.selection !== selection) {
    editor.scrollTop = 0;
    properties.parentElement!.scrollTop = 0;
    editor.dataset.selection = selection;
  }
  editor.replaceChildren();
  properties.replaceChildren();
  $("chainPreview").replaceChildren();
  $("chainSelectedKind").textContent = select("chainSection").selectedOptions[0]?.textContent ?? "";
  $("chainSelected").textContent = state.selectedId || "No entry selected";
  const formSection = section() === "classes" || section() === "setPieceClasses";
  properties.parentElement!.querySelector("h3")!.textContent = formSection ? "Library tools" : "Properties";
  if (!state.selectedId) editor.append(paragraph("Add an entry to this section."));
  else {
    // Non-visual entries are authored as one central form, including their identity.
    if (formSection) editor.append(heading("Properties"));
    (formSection ? editor : properties).append(
      field("ID", "chainId", state.selectedId, rename),
    );
    if (section() === "classes") renderClasses(editor);
    if (section() === "tiles") renderTiles(properties, editor);
    if (section() === "tileSets") renderTileSets(editor);
    if (section() === "setPieces") renderSetPieces(properties, editor);
    if (section() === "setPieceClasses") renderSetPieceClasses(editor);
  }
  const again = restore ? document.getElementById(restore.id) : null;
  if (restore && again) {
    again.focus({ preventScroll: true });
    try {
      if (again instanceof HTMLInputElement && typeof restore.start === "number")
        again.setSelectionRange(restore.start, restore.end);
    } catch {
      /* number inputs have no selection */
    }
  }
  area("chainSource").value = JSON.stringify(state.library, null, 2);
  status(state.savedDraftWarning);
}
function add(): void {
  const base =
    section() === "classes"
      ? "new-class"
      : section() === "tiles"
        ? "new-tile"
        : section() === "tileSets"
          ? "new-set"
          : section() === "setPieces"
            ? "new-piece"
            : "new-piece-class";
  let id = base,
    n = 2;
  while (entries().includes(id)) id = `${base}-${n++}`;
  if (section() === "classes") state.library.cellClasses[id] = { regionType: id };
  if (section() === "tiles")
    state.library.tiles.push({
      id,
      defaultCellClass: Object.keys(state.library.cellClasses)[0] ?? "any",
      orientations: [0],
    });
  if (section() === "tileSets")
    state.library.tileSets.push({
      id,
      members: state.library.tiles[0] ? [state.library.tiles[0].id] : [],
    });
  if (section() === "setPieces")
    state.library.setPieces.push({
      id,
      tiles: state.library.tileSets[0]
        ? [{ dx: 0, dy: 0, tileSetId: state.library.tileSets[0].id }]
        : [],
    });
  if (section() === "setPieceClasses")
    state.library.setPieceClasses.push({
      id,
      placementRule: "small",
      quota: 1,
      setPieces: state.library.setPieces[0] ? [state.library.setPieces[0].id] : [],
    });
  state.selectedId = id;
  changed();
}
function uniqueId(base: string, exists: (id: string) => boolean): string {
  let n = 1;
  while (exists(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

function clone(): void {
  if (!state.selectedId) return;
  if (section() === "classes") {
    const found = state.library.cellClasses[state.selectedId];
    if (!found) return;
    const copy = structuredClone(found);
    const newId = uniqueId(state.selectedId, (id) => id in state.library.cellClasses);
    copy.regionType = newId;
    state.library.cellClasses[newId] = copy;
    state.selectedId = newId;
    changed();
    return;
  }
  const items = list();
  const found = items.find((t) => t.id === state.selectedId);
  if (!found) return;
  const copy = structuredClone(found);
  copy.id = uniqueId(copy.id, (id) => items.some((t) => t.id === id));
  items.push(copy);
  state.selectedId = copy.id;
  changed();
}
function remove(): void {
  if (!state.selectedId) return;
  if (!confirmReferences("Delete", state.selectedId)) return;
  if (section() === "tileSets") {
    for (const piece of state.library.setPieces)
      piece.tiles = piece.tiles.filter((t) => t.tileSetId !== state.selectedId);
    if (state.activeLayoutBrush === state.selectedId) {
      state.activeLayoutBrush = state.library.tileSets.find((s) => s.id !== state.selectedId)?.id ?? "";
    }
  }
  if (section() === "setPieces") {
    for (const group of state.library.setPieceClasses)
      group.setPieces = group.setPieces.filter((id) => id !== state.selectedId);
  }
  if (section() === "classes") delete state.library.cellClasses[state.selectedId];
  else {
    const items = list();
    items.splice(
      items.findIndex((entry) => entry.id === state.selectedId),
      1,
    );
  }
  state.selectedId = "";
  changed();
}
function accept(raw: unknown): void {
  const result = validateLibrary(raw, declaredRegionTypeIds(raw));
  if (!result.valid) throw Error(result.errors.join("\n"));
  if (!renderableDraft(raw)) throw Error("Library is not safe to edit.");
  state.library = raw;
  state.selectedId = "";
  // A new draft brings its first entry into view even when the old one had the same ID.
  shownEntry = "";
  changed();
}
function exportLibrary(): void {
  const result = validateLibrary(state.library, declaredRegionTypeIds(state.library));
  if (!result.valid) {
    status("Export refused: fix validation issues first.");
    return;
  }
  download("last-exit-chain-library-v3.json", JSON.stringify(state.library, null, 2), "application/json");
}
configureAuthor({ render, entries, showEntries, renderGallery });
select("chainSection").onchange = () => {
  state.selectedId = "";
  render();
};
select("chainItem").onchange = () => {
  state.selectedId = select("chainItem").value;
  render();
};
$("chainEntryList").addEventListener("keydown", (event) => {
  const names = entries();
  const at = names.indexOf(state.selectedId);
  const next =
    event.key === "ArrowDown" ? at + 1
      : event.key === "ArrowUp" ? at - 1
        : event.key === "Home" ? 0
          : event.key === "End" ? names.length - 1
            : null;
  if (next === null || !names.length) return;
  event.preventDefault();
  const target = names[Math.max(0, Math.min(names.length - 1, next))]!;
  // At either end the selection stays put; don't rebuild the workspace for it.
  if (target === state.selectedId) return;
  state.selectedId = target;
  render();
  $("chainEntryList").querySelector<HTMLElement>("button.active")?.focus();
});
$("chainAdd").onclick = add;
$("chainClone").onclick = clone;
$("cloneTemplate").onclick = clone;
$("chainDelete").onclick = remove;
$("tileFilter").addEventListener("input", () => renderGallery());
$("chainExport").onclick = exportLibrary;
$("chainApply").onclick = () => {
  try {
    accept(JSON.parse(area("chainSource").value));
  } catch (error) {
    status(`Import refused: ${String(error)}`);
  }
};
$("chainImport").addEventListener("change", async (event) => {
  try {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) accept(JSON.parse(await file.text()));
  } catch (error) {
    status(`Import refused: ${String(error)}`);
  }
});
declare global {
  interface Window {
    chainLab: { snapshot: () => unknown };
  }
}
/** The draft being authored, for the World tab to generate from. */
export function chainDraft(): ChainLibrary {
  return structuredClone(state.library);
}
/** Draw the tab; the lab calls it when the tab is shown. */
export { render as renderChainLibrary };
/**
 * Select a tile design or set piece of `source`, the library a World tab map was made from,
 * for editing. Where the draft's entry differs or is missing, the draft is replaced with
 * `source` only if the author agrees, since the draft may hold unexported work.
 */
export function openChainEntry(source: ChainLibrary, kind: "tiles" | "setPieces", id: string): void {
  const wanted = (source[kind] as Array<{ id: string }>).find((entry) => entry.id === id);
  const held = (state.library[kind] as Array<{ id: string }>).find((entry) => entry.id === id);
  select("chainSection").value = kind;
  if (wanted && JSON.stringify(held) !== JSON.stringify(wanted)) {
    const noun = kind === "tiles" ? "tile design" : "set piece";
    const question = held
      ? `The Chain Library draft's ${noun} ${id} differs from the map's. Replace the draft with the map's library?`
      : `The Chain Library draft has no ${noun} ${id}. Replace the draft with the map's library?`;
    if (!confirm(question)) {
      state.selectedId = held ? id : "";
      render();
      status(held ? `Showing the draft's ${noun} ${id}, not the map's.` : `The draft has no ${noun} ${id}.`);
      return;
    }
    state.library = structuredClone(source);
  }
  state.selectedId = id;
  changed();
}
/** The bundled library for the World tab's zone size, or the default one where none is authored. */
$("chainLoadBundled").onclick = () => {
  const width = Number(($("zoneWidth") as HTMLInputElement).value), height = Number(($("zoneHeight") as HTMLInputElement).value);
  accept(structuredClone(CHAIN_LIBRARIES.find((l) => l.zoneWidth === width && l.zoneHeight === height) ?? CHAIN_LIBRARY));
};
window.chainLab = Object.freeze({
  snapshot: () => ({
    library: structuredClone(state.library),
    valid: validateLibrary(state.library, declaredRegionTypeIds(state.library)).valid,
    section: section(),
    selectedId: state.selectedId,
    portalText: $("chainPreview").textContent,
  }),
});
render();
