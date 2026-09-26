with open("src/macro.ts", "r", encoding="utf-8") as f:
    code = f.read()

# I want to insert the post-processing pass after the `for (const structure ...)` block.
# Let's find: `for (let i = 0; i < cellClass.length; i++)\n    cellSolid[i] = false;`
start_idx = code.find('for (let i = 0; i < cellClass.length; i++)')

post_process = """// Post-process: Adapt "any" cells on tile boundaries.
  // Because WFC matchVertex ensures no conflicting strict segments, an "any" cell
  // will receive at most one strict region type from its neighbors.
  let adapted = true;
  while (adapted) {
    adapted = false;
    const newClass = [...cellClass];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (cellClass[i] === "any") {
          const owner = cellOwner[i];
          const neighbors = [
            { nx: x, ny: y - 1 },
            { nx: x, ny: y + 1 },
            { nx: x - 1, ny: y },
            { nx: x + 1, ny: y }
          ];
          for (const n of neighbors) {
            if (n.nx >= 0 && n.nx < width && n.ny >= 0 && n.ny < height) {
              const ni = n.ny * width + n.nx;
              if (cellOwner[ni] !== owner && cellClass[ni] !== "any") {
                newClass[i] = cellClass[ni];
                adapted = true;
                break;
              }
            }
          }
        }
      }
    }
    for (let i = 0; i < cellClass.length; i++) {
      cellClass[i] = newClass[i];
    }
  }
  
  // Resolve remaining "any" to "open"
  for (let i = 0; i < cellClass.length; i++) {
    if (cellClass[i] === "any") {
      cellClass[i] = "open";
    }
  }

  """

code = code[:start_idx] + post_process + code[start_idx:]

with open("src/macro.ts", "w", encoding="utf-8") as f:
    f.write(code)
