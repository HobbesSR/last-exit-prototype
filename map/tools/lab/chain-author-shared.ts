import { CHAIN_LIBRARY_VERSION, COUNT_PARAMS, validateLibrary } from "../../macro/src/chain/library.ts";
import type { ChainLibrary, ChainTileDesign, CoreElementCount, PassabilityPrescription } from "../../macro/src/chain/library.ts";
import { CORE_ELEMENT_KINDS } from "../../kernel/contract.ts";
import type { CoreElementKind } from "../../kernel/contract.ts";
import { renderableDraft } from "./draft-safety.ts";
export const $ = (id: string): HTMLElement => document.getElementById(id)!;
export const select = (id: string): HTMLSelectElement => $(id) as HTMLSelectElement;
export const area = (id: string): HTMLTextAreaElement => $(id) as HTMLTextAreaElement;
const starter: ChainLibrary = {
  name: "lab-draft",
  version: CHAIN_LIBRARY_VERSION,
  zonePlan: "diamond",
  zoneWidth: 12,
  zoneHeight: 6,
  passabilityRules: "matched",
  fitPlacedSetPieces: true,
  cellClasses: {
    open: { regionType: "open-field" },
    hut: { regionType: "hut" },
    arrival: { regionType: "arrival", coreElements: { spawn: 1 } },
  },
  tiles: [
    {
      id: "half-hut",
      defaultCellClass: "open",
      cells: ["...hhh", "...hhh", "...hhh", "...hhh", "...hhh", "...hhh"],
      legend: { h: "hut" },
      segments: {
        "v:3,2": { passability: "passable" },
        "v:3,3": { passability: "passable" },
        "v:6,2": { adjacency: "open" },
      },
      orientations: [0, 90, 180, 270],
    },
  ],
  tileSets: [{ id: "one", members: ["half-hut"] }],
  setPieces: [
    {
      id: "entry",
      tiles: [{ dx: 0, dy: 0, tileSetId: "one" }],
      primaryRegionClass: "open",
    },
  ],
  setPieceClasses: [
    {
      id: "start",
      placementRule: "start",
      quota: 1,
      setPieces: ["entry"],
      coreElements: { spawn: 1 },
    },
  ],
};
export type Section =
  "classes" | "tiles" | "tileSets" | "setPieces" | "setPieceClasses";
/** Draft and selection shared by the section renderers. The shell owns selection changes. */
export const state = {
  library: structuredClone(starter) as ChainLibrary,
  savedDraftWarning: "",
  selectedSegment: "v:3,2",
  selectedCellClass: "hut",
  selectedId: "",
  selectedPaintTool: "paint" as PaintTool,
  selectedSegmentBrush: "passable" as SegmentBrush,
  refreshEditor: null as (() => void) | null,
  activeLayoutBrush: "",
  tileSetFilter: "",
  setPiecePaletteFilter: "",
};
const KEY = "last-exit-chain-library-v3";

export function declaredRegionTypeIds(raw: unknown): Set<string> {
  if (
    !raw ||
    typeof raw !== "object" ||
    !("cellClasses" in raw) ||
    !raw.cellClasses ||
    typeof raw.cellClasses !== "object" ||
    Array.isArray(raw.cellClasses)
  )
    return new Set();
  return new Set(
    Object.values(raw.cellClasses)
      .filter(
        (entry): entry is { regionType: string } =>
          !!entry &&
          typeof entry === "object" &&
          "regionType" in entry &&
          typeof entry.regionType === "string",
      )
      .map((entry) => entry.regionType),
  );
}
let rejectedDraft: string | null = null;
let recoveryKey: string | null = null;
let unreadSavedDraft = true;
try {
  const saved = localStorage.getItem(KEY);
  unreadSavedDraft = false;
  if (saved !== null) {
    rejectedDraft = saved;
    const draft: unknown = JSON.parse(saved);
    if (renderableDraft(draft)) {
      state.library = draft;
      rejectedDraft = null;
    } else {
      state.savedDraftWarning = "Saved chain draft was unsafe to edit; loaded the starter library. Original data remains in browser storage until it can be backed up before saving.";
    }
  }
} catch {
  state.savedDraftWarning = "Saved chain draft could not be read; loaded the starter library. Original data remains in browser storage until it can be backed up before saving.";
}
export type PaintTool = "paint" | "fill" | "rect" | "segment";
export type SegmentBrush = PassabilityPrescription | "unstated";
let activePopup: HTMLElement | null = null;
let popupDismissListener: ((evt: MouseEvent) => void) | null = null;

export function closePopup(): void {
  if (popupDismissListener) {
    document.removeEventListener("pointerdown", popupDismissListener);
    popupDismissListener = null;
  }
  if (activePopup) {
    activePopup.remove();
    activePopup = null;
  }
}
/** Fixed menus stay within the viewport even when opened near a pane's edge. */
export function showPopup(popup: HTMLElement, x: number, y: number): void {
  const margin = 8;
  popup.style.maxWidth = `${window.innerWidth - margin * 2}px`;
  popup.style.maxHeight = `${window.innerHeight - margin * 2}px`;
  popup.style.overflow = "auto";
  document.body.append(popup);
  const bounds = popup.getBoundingClientRect();
  popup.style.left = `${Math.max(margin, Math.min(x + 4, window.innerWidth - bounds.width - margin))}px`;
  popup.style.top = `${Math.max(margin, Math.min(y + 4, window.innerHeight - bounds.height - margin))}px`;
  activePopup = popup;
}
// A menu belongs to its current stage coordinates. Scrolling the menu itself is allowed.
document.addEventListener("scroll", (event) => {
  if (activePopup && !activePopup.contains(event.target as Node)) closePopup();
}, true);
window.addEventListener("resize", closePopup);
export function section(): Section {
  return select("chainSection").value as Section;
}
export function list(): Array<{ id: string }> {
  switch (section()) {
    case "tiles":
      return state.library.tiles;
    case "tileSets":
      return state.library.tileSets;
    case "setPieces":
      return state.library.setPieces;
    case "setPieceClasses":
      return state.library.setPieceClasses;
    case "classes":
      return [];
  }
}

export function current(): any {
  return section() === "classes"
    ? state.library.cellClasses[state.selectedId]
    : list().find((entry) => entry.id === state.selectedId);
}
export function option(value: string, label = value): HTMLOptionElement {
  return new Option(label, value);
}
/** An input that edits the selected entry in place; `change` returns false to refuse the value. */
export function field(
  label: string,
  id: string,
  value: string | number,
  change: (value: string) => void | false,
  kind: "text" | "number" = "text",
): HTMLElement {
  const wrap = document.createElement("label");
  wrap.textContent = label;
  const input = document.createElement("input");
  input.id = id;
  input.type = kind;
  input.value = String(value);
  input.onchange = () => {
    if (change(input.value) !== false) edited();
  };
  wrap.append(input);
  return wrap;
}
export function choice(
  label: string,
  id: string,
  values: string[],
  value: string,
  change: (value: string) => void,
  labels: Record<string, string> = {},
): HTMLElement {
  const wrap = document.createElement("label");
  wrap.textContent = label;
  const input = document.createElement("select");
  input.id = id;
  input.replaceChildren(
    ...values.map((v) => option(v, labels[v] ?? (v || "Unspecified"))),
  );
  input.value = value;
  input.onchange = () => {
    change(input.value);
    edited();
  };
  wrap.append(input);
  return wrap;
}
export function heading(text: string): HTMLElement {
  const h = document.createElement("h3");
  h.textContent = text;
  return h;
}
export function paragraph(text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "hint";
  p.textContent = text;
  return p;
}
export function csv(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}
export function numberList(value: string): number[] {
  return csv(value).map(Number);
}
export function coreFields(value: {
  coreElements?: Partial<Record<CoreElementKind, CoreElementCount>>;
}): HTMLElement {
  const box = document.createElement("div");
  box.id = "chainCoreElements";
  box.className = "chain-core";
  box.append(heading("Core elements"));
  for (const kind of CORE_ELEMENT_KINDS) {
    const wrap = document.createElement("label");
    wrap.textContent = kind;
    const input = document.createElement("input");
    input.className = "chainCoreElements";
    input.dataset.kind = kind;
    input.value = String(value.coreElements?.[kind] ?? "");
    input.placeholder = `Count or ${COUNT_PARAMS.join(" / ")}`;
    input.onchange = () => {
      const raw = input.value.trim();
      const next = { ...value.coreElements };
      if (!raw) delete next[kind];
      else {
        const countParam = COUNT_PARAMS.find((name) => name === raw);
        if (countParam) next[kind] = countParam;
        else {
          const count = Number(raw);
          if (!Number.isSafeInteger(count) || count <= 0) {
            status(
              `Core element ${kind} needs a positive whole number or ${COUNT_PARAMS.join(", ")}.`,
            );
            return;
          }
          next[kind] = count;
        }
      }
      if (Object.keys(next).length) value.coreElements = next;
      else delete value.coreElements;
      edited();
    };
    wrap.append(input);
    box.append(wrap);
  }
  return box;
}
export function status(prefix = ""): void {
  const result = validateLibrary(state.library, declaredRegionTypeIds(state.library));
  $("chainStatus").textContent =
    `${prefix ? `${prefix}\n` : ""}${result.valid ? "Library valid for declared region type IDs. Strategy availability is not checked." : `${result.errors.length} validation issue(s):\n${result.errors.join("\n")}`}`;
  $("chainStatus").classList.toggle("invalid", !result.valid);
}
/** Save the draft, recovering any rejected one first. */
export function save(): void {
  try {
    // If startup could not read storage, recover it before attempting any write.
    if (unreadSavedDraft) {
      rejectedDraft = localStorage.getItem(KEY);
      unreadSavedDraft = false;
    }
    if (rejectedDraft !== null) {
      // Never replace either the rejected input or an earlier recovery copy.
      const base = `${KEY}:rejected:${Date.now()}`;
      let backup = base, suffix = 0;
      while (localStorage.getItem(backup) !== null) backup = `${base}:${++suffix}`;
      localStorage.setItem(backup, rejectedDraft);
      rejectedDraft = null;
      recoveryKey = backup;
    }
    localStorage.setItem(KEY, JSON.stringify(state.library));
    // Name the backup on the save that follows it; later saves clear the notice.
    state.savedDraftWarning = recoveryKey
      ? `Rejected chain draft backed up in browser storage at ${recoveryKey}.`
      : "";
    recoveryKey = null;
  } catch {
    // A failed backup must prevent the subsequent write to KEY.
    state.savedDraftWarning = rejectedDraft !== null
      ? "Draft not saved: the rejected original could not be backed up. Original data remains in browser storage."
      : "Draft not saved: browser storage is unavailable. Copy the source JSON to preserve these edits.";
  }
}
/** A change to the library's structure or the selection: save and redraw the editor. */
export function changed(): void {
  save();
  hooks.render();
}
/**
 * An edit to the selected entry's properties: save and update what reads them, leaving the
 * editor's controls, and so their focus and caret, in place (#538).
 */
export function edited(): void {
  save();
  const names = hooks.entries();
  if (!names.includes(state.selectedId)) return hooks.render();
  hooks.showEntries(names);
  $("chainSelected").textContent = state.selectedId;
  // A refused rename left its text in the ID field; once another edit commits, show the real ID.
  const id = document.getElementById("chainId") as HTMLInputElement | null;
  if (id && id !== document.activeElement) id.value = state.selectedId;
  $("chainSurface").dataset.selection = JSON.stringify([section(), state.selectedId]);
  hooks.renderGallery();
  state.refreshEditor?.();
  area("chainSource").value = JSON.stringify(state.library, null, 2);
  status(state.savedDraftWarning);
}

interface AuthorHooks {
  render(): void;
  entries(): string[];
  showEntries(names: string[]): void;
  renderGallery(): void;
}
let hooks: AuthorHooks;
/** Connect the shell before its first render or any authoring interaction. */
export function configureAuthor(callbacks: AuthorHooks): void { hooks = callbacks; }

export function dismissPopupOutside(popup: HTMLElement): void {
  popupDismissListener = (evt: MouseEvent) => {
    if (!popup.contains(evt.target as Node)) closePopup();
  };
  setTimeout(() => {
    if (popupDismissListener) document.addEventListener("pointerdown", popupDismissListener);
  }, 0);
}

export function tileMatches(t: ChainTileDesign, filter: string): boolean {
  if (!filter) return true;
  if (t.id.toLowerCase().includes(filter)) return true;
  if (t.defaultCellClass.toLowerCase().includes(filter)) return true;
  if (t.labels?.some((l) => l.toLowerCase().includes(filter))) return true;
  return Object.values(t.legend ?? {}).some((c) => c.toLowerCase().includes(filter));
}

export function render(): void { hooks.render(); }
