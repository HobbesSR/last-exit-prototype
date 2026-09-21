with open("src/core.ts", "r", encoding="utf-8") as f:
    core = f.read()
core = core.replace('import { WfcGrid, TileOption, getDifficulty, solveWfc } from "./wfc.ts";', 'import { getDifficulty, solveWfc } from "./wfc.ts";\nimport type { WfcGrid, TileOption } from "./wfc.ts";')
with open("src/core.ts", "w", encoding="utf-8") as f:
    f.write(core)
