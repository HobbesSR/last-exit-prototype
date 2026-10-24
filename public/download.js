/** Saves `data` as a JSON file named `name`, through a short-lived object URL. `space` indents as JSON.stringify does. */
export function downloadJson(name, data, space) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, space)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
