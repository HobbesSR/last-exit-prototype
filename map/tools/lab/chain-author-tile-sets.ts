/** Tile-set membership authoring. */
import type { ChainLibrary } from "../../macro/src/chain/library.ts";
import { state, current, paragraph, status, changed } from "./chain-author-shared.ts";
import { tileMatches } from "./chain-author-shared.ts";
import { tileThumbnail } from "./chain-author-tiles.ts";

export function renderTileSets(root: HTMLElement): void {
  const entry = current() as ChainLibrary["tileSets"][number];
  if (!entry) return;

  const container = document.createElement("div");
  container.className = "chain-sets-container";

  container.append(
    paragraph(
      "Click tiles in the Available list to add them, or click tiles in the Members list to remove them.",
    ),
  );

  // Members section
  const membersSection = document.createElement("div");
  membersSection.className = "chain-sets-section";

  const membersHead = document.createElement("div");
  membersHead.className = "chain-sets-section-head";
  const membersTitle = document.createElement("h4");
  membersTitle.id = "setMembersTitle";
  membersTitle.textContent = `Members (${entry.members.length})`;
  membersHead.append(membersTitle);

  const membersGallery = document.createElement("div");
  membersGallery.id = "setMembersGallery";
  membersGallery.className = "chain-gallery-grid";
  membersGallery.setAttribute("aria-label", "Tiles in this set");

  membersSection.append(membersHead, membersGallery);

  // Available section
  const availableSection = document.createElement("div");
  availableSection.className = "chain-sets-section";

  const availableHead = document.createElement("div");
  availableHead.className = "chain-sets-section-head";
  const availableTitle = document.createElement("h4");
  availableTitle.textContent = "Available Tiles";

  const filterWrap = document.createElement("label");
  filterWrap.className = "grow";
  const filterInput = document.createElement("input");
  filterInput.id = "setAvailableFilter";
  filterInput.placeholder = "filter by ID, class, or label...";
  filterInput.spellcheck = false;
  filterInput.value = state.tileSetFilter;
  filterWrap.append(filterInput);

  availableHead.append(availableTitle, filterWrap);

  const availableGallery = document.createElement("div");
  availableGallery.id = "setAvailableGallery";
  availableGallery.className = "chain-gallery-grid";
  availableGallery.setAttribute("aria-label", "Available tiles");

  availableSection.append(availableHead, availableGallery);

  container.append(membersSection, availableSection);
  root.append(container);

  function populateMembers(): void {
    membersTitle.textContent = `Members (${entry.members.length})`;
    if (!entry.members.length) {
      const empty = document.createElement("p");
      empty.className = "gallery-empty";
      empty.textContent =
        "No tiles in this set. Chain validation requires at least one member.";
      membersGallery.replaceChildren(empty);
      return;
    }

    const cards = entry.members.map((memberId) => {
      const tile = state.library.tiles.find((t) => t.id === memberId);
      const card = document.createElement("button");
      card.type = "button";
      card.className = "tile-card member-card";
      card.dataset.tile = memberId;
      card.title = `Click to remove "${memberId}" from set`;

      const name = document.createElement("span");
      name.className = "tile-card-name";
      name.textContent = memberId;

      if (tile) {
        card.append(tileThumbnail(tile), name);
      } else {
        const placeholder = document.createElement("figure");
        placeholder.className = "orphan-thumbnail";
        card.append(placeholder, name);
      }

      card.onclick = () => {
        if (entry.members.length <= 1) {
          status(`Tile set "${entry.id}" must have at least one member to remain valid.`);
          return;
        }
        entry.members = entry.members.filter((id) => id !== memberId);
        changed();
      };
      return card;
    });

    membersGallery.replaceChildren(...cards);
  }

  function populateAvailable(): void {
    const inSet = new Set(entry.members);
    const available = state.library.tiles.filter((t) => !inSet.has(t.id));
    const filter = state.tileSetFilter.trim().toLowerCase();

    if (!available.length) {
      const empty = document.createElement("p");
      empty.className = "gallery-empty";
      empty.textContent = "All library tiles are members of this set.";
      availableGallery.replaceChildren(empty);
      return;
    }

    const matching = available.filter((t) => tileMatches(t, filter));

    if (!matching.length) {
      const empty = document.createElement("p");
      empty.className = "gallery-empty";
      empty.textContent = `No available tiles match "${state.tileSetFilter}".`;
      availableGallery.replaceChildren(empty);
      return;
    }

    const cards = matching.map((t) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "tile-card available-card";
      card.dataset.tile = t.id;
      card.title = `Click to add "${t.id}" to set`;

      const name = document.createElement("span");
      name.className = "tile-card-name";
      name.textContent = t.id;

      card.append(tileThumbnail(t), name);

      card.onclick = () => {
        if (!entry.members.includes(t.id)) {
          entry.members.push(t.id);
          changed();
        }
      };
      return card;
    });

    availableGallery.replaceChildren(...cards);
  }

  filterInput.oninput = () => {
    state.tileSetFilter = filterInput.value;
    populateAvailable();
  };

  populateMembers();
  populateAvailable();
}
