/** Cell-class properties and core-element authoring. */
import { state, field, paragraph, coreFields, status, changed, edited } from "./chain-author-shared.ts";
export function renderClasses(root: HTMLElement): void {
  const entry = state.library.cellClasses[state.selectedId];
  if (!entry) return;
  root.append(
    field("Region type ID", "chainRegionType", entry.regionType, (value) => {
      entry.regionType = value.trim();
    }),
  );
  root.append(
    paragraph(
      "Parameters are key/value pairs. Values are parsed as JSON scalars (number, string, boolean).",
    ),
  );
  const params = document.createElement("div");
  params.id = "chainParams";
  root.append(params);
  for (const [initialKey, value] of Object.entries(entry.params ?? {})) {
    let key = initialKey;
    const row = document.createElement("div");
    row.className = "chain-row";
    const name = document.createElement("input");
    name.value = key;
    name.setAttribute("aria-label", "Parameter name");
    const scalar = document.createElement("input");
    scalar.value = JSON.stringify(value);
    scalar.setAttribute("aria-label", "Parameter value");
    const remove = document.createElement("button");
    remove.textContent = "Remove";
    const update = () => {
      try {
        const parsed: unknown = JSON.parse(scalar.value);
        if (!["string", "number", "boolean"].includes(typeof parsed))
          throw Error("Parameter needs a scalar");
        const next = name.value.trim();
        // Taking another parameter's name replaces it, so its row must go.
        const replaces = next !== key && !!entry.params && next in entry.params;
        delete entry.params?.[key];
        entry.params ??= {};
        entry.params[next] = parsed as string | number | boolean;
        key = next;
        if (replaces) changed();
        else edited();
      } catch (error) {
        status(String(error));
      }
    };
    name.onchange = update;
    scalar.onchange = update;
    remove.onclick = () => {
      delete entry.params?.[key];
      if (!Object.keys(entry.params ?? {}).length) delete entry.params;
      changed();
    };
    row.append(name, scalar, remove);
    params.append(row);
  }
  const add = document.createElement("button");
  add.textContent = "Add parameter";
  add.onclick = () => {
    entry.params ??= {};
    entry.params[`param${Object.keys(entry.params).length + 1}`] = "";
    changed();
  };
  root.append(add, coreFields(entry));
}
