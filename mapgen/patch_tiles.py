import re

with open("src/tiles.ts", "r", encoding="utf-8") as f:
    content = f.read()

# Replace edges validation
old_edges = """
  for (const [side, value] of Object.entries(tile.edges ?? {})) {
    if (typeof value === "string") {
      if (value.length !== TILE_SIZE)
        errors.push(`edges.${side} must be ${TILE_SIZE} marks`);
      else if (/[^.o#]/.test(value))
        errors.push(`edges.${side} marks must be ".", "o" or "#"`);
      continue;
    }
    if (!Array.isArray(value) || value.length !== TILE_SIZE) {
      errors.push(`edges.${side} must be ${TILE_SIZE} declarations`);
      continue;
    }
    value.forEach((entry, i) =>
      errors.push(...validateDeclaration(entry, `edges.${side}[${i}]`)),
    );
  }
"""

new_edges = """
  for (const [side, value] of Object.entries(tile.edges ?? {})) {
    if (!Array.isArray(value) || value.length !== TILE_SIZE) {
      errors.push(`edges.${side} must be ${TILE_SIZE} strings`);
      continue;
    }
  }
"""
content = content.replace(old_edges.strip(), new_edges.strip())

# Replace corners validation
old_corners = """
  for (const [side, value] of Object.entries(tile.corners ?? {})) {
    if (!Array.isArray(value) || value.length !== TILE_SIZE + 1) {
      errors.push(`corners.${side} must be ${TILE_SIZE + 1} declarations`);
      continue;
    }
    value.forEach(
      (entry, i) =>
        typeof entry !== "string" &&
        errors.push(...validateVertex(entry, `corners.${side}[${i}]`)),
    );
  }
"""

new_corners = """
  for (const [side, value] of Object.entries(tile.corners ?? {})) {
    if (!Array.isArray(value) || value.length !== TILE_SIZE + 1) {
      errors.push(`corners.${side} must be ${TILE_SIZE + 1} strings`);
      continue;
    }
  }
"""
content = content.replace(old_corners.strip(), new_corners.strip())

with open("src/tiles.ts", "w", encoding="utf-8") as f:
    f.write(content)

print("Patched tiles.ts")
