/** Set-piece class placement rules, quotas and core elements. */
import { PLACEMENT_RULES } from "../../macro/src/chain/library.ts";
import type { ChainLibrary } from "../../macro/src/chain/library.ts";
import { state, current, field, choice, heading, coreFields, edited } from "./chain-author-shared.ts";
export function renderSetPieceClasses(root: HTMLElement): void {
  const group = current() as ChainLibrary["setPieceClasses"][number];
  if (!group) return;
  root.append(
    choice(
      "Placement rule",
      "chainPlacementRule",
      Array.from(PLACEMENT_RULES),
      group.placementRule,
      (v) => {
        group.placementRule = v as typeof group.placementRule;
      },
    ),
    field(
      "Quota",
      "chainQuota",
      group.quota,
      (v) => {
        group.quota = Number(v);
      },
      "number",
    ),
    heading("Set pieces"),
  );
  for (const piece of state.library.setPieces) {
    const label = document.createElement("label");
    label.className = "chain-check";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = group.setPieces.includes(piece.id);
    input.onchange = () => {
      group.setPieces = input.checked
        ? [...group.setPieces, piece.id]
        : group.setPieces.filter((id) => id !== piece.id);
      edited();
    };
    label.append(input, piece.id);
    root.append(label);
  }
  root.append(coreFields(group));
}
