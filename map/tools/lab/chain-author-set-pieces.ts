/** Set-piece slots, layout painting and class bindings. */
import { render } from "./chain-author-shared.ts";
import type { ChainLibrary, ChainSetPieceSlot } from "../../macro/src/chain/library.ts";
import { state, select, current, field, choice, paragraph, changed, edited } from "./chain-author-shared.ts";
import { tileThumbnail, classColor } from "./chain-author-tiles.ts";
function slotEditor(
  slot: ChainSetPieceSlot,
  index: number,
  slots: ChainSetPieceSlot[],
): HTMLElement {
  const row = document.createElement("div");
  row.className = "chain-slot";
  row.append(
    field(
      "dx",
      `chainSlotX${index}`,
      slot.dx,
      (v) => {
        slot.dx = Number(v);
      },
      "number",
    ),
    field(
      "dy",
      `chainSlotY${index}`,
      slot.dy,
      (v) => {
        slot.dy = Number(v);
      },
      "number",
    ),
    choice(
      "Tile set",
      `chainSlotSet${index}`,
      state.library.tileSets.map((s) => s.id),
      slot.tileSetId,
      (v) => {
        slot.tileSetId = v;
      },
    ),
    choice(
      "Orientation",
      `chainSlotOrientation${index}`,
      ["", "0", "90", "180", "270"],
      slot.orientation === undefined ? "" : String(slot.orientation),
      (v) => {
        if (v) slot.orientation = Number(v);
        else delete slot.orientation;
      },
    ),
  );
  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "Remove slot";
  remove.onclick = () => {
    slots.splice(index, 1);
    changed();
  };
  row.append(remove);
  return row;
}

export function renderSetPieces(root: HTMLElement, surface: HTMLElement): void {
  const piece = current() as ChainLibrary["setPieces"][number];
  if (!piece) return;

  if (!state.library.tileSets.some((s) => s.id === state.activeLayoutBrush)) {
    state.activeLayoutBrush = state.library.tileSets[0]?.id ?? "";
  }

  // 1. Primary region class
  root.append(
    choice(
      "Primary region class (editor hint)",
      "chainPrimaryClass",
      ["", ...Object.keys(state.library.cellClasses)],
      piece.primaryRegionClass ?? "",
      (v) => {
        if (v) piece.primaryRegionClass = v;
        else delete piece.primaryRegionClass;
      },
    ),
  );

  // 2. Eligible tiers checkboxes (tiers 1-5)
  const tiersBox = document.createElement("div");
  tiersBox.className = "chain-tiers-container";
  const tiersLabel = document.createElement("span");
  tiersLabel.className = "chain-tiers-label";
  tiersLabel.textContent =
    "Eligible tiers (blank / all unchecked = all tiers eligible)";
  tiersBox.append(tiersLabel);

  const tiersGroup = document.createElement("div");
  tiersGroup.id = "chainEligibleTiers";
  tiersGroup.className = "chain-tiers-boxes";

  const currentTiers = new Set(piece.eligibleTiers ?? []);
  for (let tier = 1; tier <= 5; tier++) {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.dataset.tier = String(tier);
    cb.checked = currentTiers.has(tier);
    cb.onchange = () => {
      const nextTiers = new Set(piece.eligibleTiers ?? []);
      if (cb.checked) nextTiers.add(tier);
      else nextTiers.delete(tier);
      if (nextTiers.size === 0) delete piece.eligibleTiers;
      else piece.eligibleTiers = Array.from(nextTiers).sort((a, b) => a - b);
      edited();
    };
    label.append(cb, ` Tier ${tier}`);
    tiersGroup.append(label);
  }
  tiersBox.append(tiersGroup);
  root.append(tiersBox);

  // 3. 2D Layout Blueprint Workspace
  const workspace = document.createElement("div");
  workspace.className = "chain-layout-workspace";

  // Palette on the left
  const palette = document.createElement("div");
  palette.className = "chain-layout-palette";

  const paletteHead = document.createElement("h4");
  paletteHead.textContent = "Tile Sets Palette";

  const filterInput = document.createElement("input");
  filterInput.id = "setPiecePaletteFilter";
  filterInput.placeholder = "Filter tile sets...";
  filterInput.spellcheck = false;
  filterInput.value = state.setPiecePaletteFilter;

  const paletteList = document.createElement("div");
  paletteList.id = "setPiecePaletteList";
  paletteList.className = "chain-layout-palette-list";

  palette.append(paletteHead, filterInput, paletteList);

  function populatePalette(): void {
    if (!state.library.tileSets.some((s) => s.id === state.activeLayoutBrush)) {
      state.activeLayoutBrush = state.library.tileSets[0]?.id ?? "";
    }
    const filter = state.setPiecePaletteFilter.trim().toLowerCase();
    const tileSetIds = state.library.tileSets.map((s) => s.id);
    const matching = tileSetIds.filter(
      (id) => !filter || id.toLowerCase().includes(filter),
    );

    if (!matching.length) {
      const empty = document.createElement("p");
      empty.className = "gallery-empty";
      empty.textContent = `No tile sets match "${state.setPiecePaletteFilter}".`;
      paletteList.replaceChildren(empty);
      return;
    }

    const items = matching.map((id, index) => {
      const item = document.createElement("div");
      item.className = "chain-layout-palette-item";
      item.dataset.tileset = id;
      if (id === state.activeLayoutBrush) item.classList.add("active");
      if (index < 9) {
        item.title = `Select tile set "${id}" (Hotkey: ${index + 1})`;
      }

      const swatch = document.createElement("span");
      swatch.className = "palette-swatch";
      swatch.style.background = classColor(id);

      const name = document.createElement("span");
      name.textContent = id;

      item.append(swatch, name);
      item.onclick = () => {
        state.activeLayoutBrush = id;
        populatePalette();
      };
      return item;
    });

    paletteList.replaceChildren(...items);
  }

  filterInput.oninput = () => {
    state.setPiecePaletteFilter = filterInput.value;
    populatePalette();
  };
  populatePalette();

  // Grid container on the right
  const gridContainer = document.createElement("div");
  gridContainer.className = "chain-layout-grid-container";

  const gridHint = paragraph(
    "Blueprint grid: click an empty cell to place selected tile set. Click a filled slot to cycle rotation (0° → 90° → 180° → 270°). Right-click to remove slot.",
  );

  const grid = document.createElement("div");
  grid.id = "setPieceGrid";
  grid.className = "chain-layout-grid";

  gridContainer.append(gridHint, grid);
  workspace.append(palette, gridContainer);
  surface.append(workspace);

  function populateGrid(): void {
    grid.replaceChildren();

    let minDx = -5,
      maxDx = 5,
      minDy = -5,
      maxDy = 5;
    for (const s of piece.tiles) {
      minDx = Math.min(minDx, s.dx - 1);
      maxDx = Math.max(maxDx, s.dx + 1);
      minDy = Math.min(minDy, s.dy - 1);
      maxDy = Math.max(maxDy, s.dy + 1);
    }

    const cols = maxDx - minDx + 1;
    const rows = maxDy - minDy + 1;
    if (!Number.isSafeInteger(cols * rows) || cols * rows > 10_000) {
      grid.append(paragraph("Blueprint preview is too large. Use the exact coordinate editor below."));
      return;
    }
    grid.style.gridTemplateColumns = `repeat(${cols}, 46px)`;
    grid.style.gridTemplateRows = `repeat(${rows}, 46px)`;

    for (let dy = minDy; dy <= maxDy; dy++) {
      for (let dx = minDx; dx <= maxDx; dx++) {
        const cell = document.createElement("div");
        cell.className = "chain-layout-cell";
        cell.dataset.dx = String(dx);
        cell.dataset.dy = String(dy);

        if (dx === 0 && dy === 0) cell.classList.add("origin");

        const matchingSlots = piece.tiles.filter((t) => t.dx === dx && t.dy === dy);
        const slot = matchingSlots[0];
        if (slot) {
          cell.classList.add("filled");
          if (matchingSlots.length > 1) {
            cell.classList.add("duplicate");
          }
          cell.dataset.tileset = slot.tileSetId;
          const tileSet = state.library.tileSets.find((s) => s.id === slot.tileSetId);
          const memberId = tileSet?.members[0];
          const memberTile = memberId ? state.library.tiles.find((t) => t.id === memberId) : undefined;
          if (memberTile) {
            const thumb = tileThumbnail(memberTile);
            thumb.classList.add("slot-thumbnail");
            if (slot.orientation) {
              thumb.style.transform = `rotate(${slot.orientation}deg)`;
            }
            cell.append(thumb);
          }

          const nameSpan = document.createElement("span");
          nameSpan.className = "slot-set-id";
          nameSpan.textContent = slot.tileSetId;

          const rotSpan = document.createElement("span");
          rotSpan.className = "slot-rot";
          rotSpan.textContent = `${slot.orientation ?? 0}°${matchingSlots.length > 1 ? " (!)" : ""}`;

          cell.append(nameSpan, rotSpan);
          if (tileSet && tileSet.members.length > 1) {
            const countSpan = document.createElement("span");
            countSpan.className = "slot-member-count";
            countSpan.textContent = `[${tileSet.members.length}]`;
            countSpan.title = `Tile set "${slot.tileSetId}" has ${tileSet.members.length} members: ${tileSet.members.join(", ")}`;
            cell.append(countSpan);
          }
          cell.title = matchingSlots.length > 1
            ? `Warning: ${matchingSlots.length} duplicate slots at (${dx}, ${dy})!\nLeft-click to rotate · Right-click to remove`
            : `Slot (${dx}, ${dy}) · Set: ${slot.tileSetId}${tileSet && tileSet.members.length > 1 ? ` (${tileSet.members.length} members)` : ""} · Rot: ${slot.orientation ?? 0}°\nLeft-click to rotate · Right-click to remove`;
        } else {
          cell.title = `(${dx}, ${dy})\nLeft-click to place "${state.activeLayoutBrush}"`;
        }

        cell.tabIndex = 0;
        cell.setAttribute("role", "button");
        cell.setAttribute(
          "aria-label",
          slot
            ? `Slot at (${dx}, ${dy}), tile set ${slot.tileSetId}, orientation ${slot.orientation ?? 0} degrees`
            : `Empty cell at (${dx}, ${dy})`,
        );

        const activateSlot = () => {
          if (slot) {
            const currentRot = slot.orientation ?? 0;
            const nextRot = (currentRot + 90) % 360;
            if (nextRot === 0) delete slot.orientation;
            else slot.orientation = nextRot;
            changed();
          } else if (state.activeLayoutBrush) {
            piece.tiles.push({ dx, dy, tileSetId: state.activeLayoutBrush });
            changed();
          }
        };

        const eraseSlot = () => {
          if (slot) {
            piece.tiles = piece.tiles.filter(
              (t) => !(t.dx === dx && t.dy === dy),
            );
            changed();
          }
        };

        cell.onmousedown = (e) => {
          if (e.button === 0) {
            activateSlot();
          } else if (e.button === 2) {
            eraseSlot();
          }
        };

        cell.onkeydown = (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            activateSlot();
          } else if (e.key === "Delete" || e.key === "Backspace") {
            if (slot) {
              e.preventDefault();
              eraseSlot();
            }
          }
        };

        cell.oncontextmenu = (e) => e.preventDefault();
        grid.append(cell);
      }
    }
  }

  populateGrid();

  // 4. Slots details forms list (preserves slotEditor and #chainSlotSet0 / #chainSlotOrientation0)
  const slotDetails = document.createElement("details");
  slotDetails.open = true;
  const summary = document.createElement("summary");
  summary.textContent = `Slot List & Exact Coordinate Editor (${piece.tiles.length})`;
  slotDetails.append(summary);

  piece.tiles.forEach((slot, index) =>
    slotDetails.append(slotEditor(slot, index, piece.tiles)),
  );

  const add = document.createElement("button");
  add.type = "button";
  add.id = "chainAddSlot";
  add.textContent = "Add slot";
  add.onclick = () => {
    piece.tiles.push({
      dx: piece.tiles.length,
      dy: 0,
      tileSetId: state.library.tileSets[0]?.id ?? "",
    });
    changed();
  };
  slotDetails.append(add);
  root.append(slotDetails);

  // 5. Referencing Set Piece Classes & Binding
  const classesSection = document.createElement("details");
  classesSection.id = "chainPieceClassesSection";
  classesSection.open = true;
  const classesSummary = document.createElement("summary");
  const countReferences = () => {
    const referencingCount = state.library.setPieceClasses.filter((c) =>
      c.setPieces.includes(piece.id),
    ).length;
    classesSummary.textContent = `Referencing Set Piece Classes (${referencingCount} / ${state.library.setPieceClasses.length})`;
  };
  countReferences();
  classesSection.append(classesSummary);

  const classesContainer = document.createElement("div");
  classesContainer.className = "chain-piece-classes-list";
  classesContainer.id = "chainPieceClassesList";

  if (!state.library.setPieceClasses.length) {
    const empty = document.createElement("p");
    empty.className = "gallery-empty";
    empty.textContent = "No set piece classes authored in library.";
    classesContainer.append(empty);
  } else {
    for (const spClass of state.library.setPieceClasses) {
      const row = document.createElement("div");
      row.className = "chain-piece-class-row";
      row.dataset.classId = spClass.id;

      const checkLabel = document.createElement("label");
      checkLabel.className = "chain-check";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.dataset.classId = spClass.id;
      cb.checked = spClass.setPieces.includes(piece.id);
      cb.onchange = () => {
        if (cb.checked) {
          if (!spClass.setPieces.includes(piece.id)) {
            spClass.setPieces.push(piece.id);
          }
        } else {
          spClass.setPieces = spClass.setPieces.filter((id) => id !== piece.id);
        }
        edited();
      };
      checkLabel.append(cb, spClass.id);

      const badges = document.createElement("div");
      badges.className = "chain-piece-class-badges";

      const ruleBadge = document.createElement("span");
      ruleBadge.className = "piece-class-badge rule-badge";
      ruleBadge.textContent = `rule: ${spClass.placementRule}`;

      const quotaBadge = document.createElement("span");
      quotaBadge.className = "piece-class-badge quota-badge";
      quotaBadge.textContent = `quota: ${spClass.quota ?? "none"}`;

      const linkBtn = document.createElement("button");
      linkBtn.type = "button";
      linkBtn.className = "piece-class-link-btn";
      linkBtn.textContent = "Edit class →";
      linkBtn.title = `Switch to editing set piece class "${spClass.id}"`;
      linkBtn.onclick = () => {
        select("chainSection").value = "setPieceClasses";
        state.selectedId = spClass.id;
        render();
      };

      badges.append(ruleBadge, quotaBadge, linkBtn);
      row.append(checkLabel, badges);
      classesContainer.append(row);
    }
  }
  classesSection.append(classesContainer);
  root.append(classesSection);
  // Slot fields and class bindings are edited in place; the blueprint and counts follow them.
  state.refreshEditor = () => {
    populateGrid();
    countReferences();
  };
}
