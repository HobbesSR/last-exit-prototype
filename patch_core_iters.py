import re

with open("src/core.ts", "r", encoding="utf-8") as f:
    core = f.read()

core = core.replace(
    'const solved = solveWfc(grid, params.columns, params.rows, library.tiles, prng, state);',
    'const solved = solveWfc(grid, params.columns, params.rows, library.tiles, prng, state);\n      console.log("Iterations:", state.iterations, "Solved:", !!solved);'
)

with open("src/core.ts", "w", encoding="utf-8") as f:
    f.write(core)
