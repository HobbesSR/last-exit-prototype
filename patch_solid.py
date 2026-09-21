import re

# 1. Update primitives.ts
with open("src/primitives.ts", "r", encoding="utf-8") as f:
    prim = f.read()

prim = re.sub(r'export const SOLID_CLASS = "solid";', '', prim)
prim = re.sub(r'export const isSolidClass = \(name: string\): boolean => name === SOLID_CLASS;', '', prim)
prim = re.sub(r'\s+/\*\*\s+\* The name is reserved so tile validation recognises material without consulting\s+\* the library\. Author-declared material classes are a later generalisation\.\s+\*/\s+', '', prim)

# In transformCells:
# replace `mark === "#" ? SOLID_CLASS : ...` with just handling '.' and legend
old_transform = """
      cells.push({
        class:
          mark === "#"
            ? SOLID_CLASS
            : mark === "."
              ? tile.defaultCellClass
              : (legend[mark] ?? tile.defaultCellClass),
        height: 0,
      });
"""
new_transform = """
      cells.push({
        class: mark === "."
              ? tile.defaultCellClass
              : (legend[mark] ?? tile.defaultCellClass),
        height: 0,
      });
"""
prim = prim.replace(old_transform.strip(), new_transform.strip())

with open("src/primitives.ts", "w", encoding="utf-8") as f:
    f.write(prim)

# 2. Update core.ts
with open("src/core.ts", "r", encoding="utf-8") as f:
    core = f.read()

core = re.sub(r'SOLID_CLASS,\s*', '', core)
core = re.sub(r'isSolidClass,\s*', '', core)
core = re.sub(r'SOLID_CLASS,\s*', '', core)

# Remove `SOLID_CLASS` from classes()
core = re.sub(r'SOLID_CLASS,\s*', '', core)

# Remove SOLID_CLASS check in validateLibrary
core = re.sub(r'if \(name === SOLID_CLASS \|\| name === ANY_CLASS \|\| \!name\.trim\(\)\)', r'if (name === ANY_CLASS || !name.trim())', core)

# Remove isSolidClass in searchRegions
core = re.sub(r'\s*// No builder is registered for material: it is discovered and left alone\.\s*if \(isSolidClass\(region\.cellClass\)\) continue;', '', core)

# Remove isSolidClass in finalizeSpawns
core = re.sub(r'\.filter\(\(s\) => !isSolidClass\(grid\.cellClass\[s\.cell\]!\)\)', '', core)

# Remove isSolidClass in `mapToArtifact`
core = re.sub(r'\|\| isSolidClass\(grid\.cellClass\[cell\]!\)', '', core)

# Remove solidFraction calculation
core = re.sub(r'solidFraction:\s*grid\.cellClass\.filter\(\(c\) => c === SOLID_CLASS\)\.length\s*/\s*Math\.max\(1, n \* p\.tileSize \* p\.tileSize\),', 'solidFraction: 0,', core)

# Remove cellSolid from PrimitiveGridViews and all references in core.ts
core = re.sub(r'/\*\* True where the class is the reserved material class\. \*/\s*cellSolid: \(index: number\) => boolean;', '', core)
core = re.sub(r'cellSolid: \(index\) => isSolidClass\(readClass\(index\)\),', '', core)
core = re.sub(r'blocked: views\.cellSolid\(index\),', 'blocked: false,', core)

# Remove spawn blocked check
core = re.sub(r'else if \(views\.cellSolid\(spawn\.cell\)\)\s*errors\.push\("region placed a spawn in a solid cell"\);', '', core)

with open("src/core.ts", "w", encoding="utf-8") as f:
    f.write(core)
    
print("Patched primitives.ts and core.ts")
