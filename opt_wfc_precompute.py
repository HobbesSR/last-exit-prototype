import re

with open("src/wfc.ts", "r", encoding="utf-8") as f:
    wfc = f.read()

# I will replace the filter with a precomputed bitmask or Set!
# Actually, if I pre-generate a list of valid neighbors for each option,
# I can just do: `nCell.domain.some(nOpt => validNeighbors[mySide][opt.id].has(nOpt.id))`
# Where `id` is a unique index for TileOption!
# But since TileOption is an object, I can just use a unique integer ID!
