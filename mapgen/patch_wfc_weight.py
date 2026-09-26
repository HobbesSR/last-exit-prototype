import re

with open("src/wfc.ts", "r", encoding="utf-8") as f:
    wfc = f.read()

# Add weight to TileOption
wfc = wfc.replace(
    'export interface TileOption {\n  templateId: string;\n  orientation: Orientation;\n  difficulty: number;\n}',
    'export interface TileOption {\n  templateId: string;\n  orientation: Orientation;\n  difficulty: number;\n  weight: number;\n}'
)

# Replace sort logic
old_sort = """
  // Sort options by difficulty (descending) with random jitter
  const options = [...cell.domain].sort((a, b) => {
    return (b.difficulty + random()) - (a.difficulty + random());
  });
"""
new_sort = """
  const options = [...cell.domain].map(opt => ({
    opt,
    score: opt.difficulty + Math.pow(random(), 1 / (opt.weight || 1))
  })).sort((a, b) => b.score - a.score).map(x => x.opt);
"""
wfc = wfc.replace(old_sort.strip(), new_sort.strip())

with open("src/wfc.ts", "w", encoding="utf-8") as f:
    f.write(wfc)
