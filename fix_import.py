with open("src/core.ts", "r", encoding="utf-8") as f:
    core = f.read()
core = core.replace('import { composeMacro } from "./macro.ts";', 'import { composeMacro } from "./macro.ts";\nimport { WfcGrid, TileOption, getDifficulty, solveWfc } from "./wfc.ts";')
with open("src/core.ts", "w", encoding="utf-8") as f:
    f.write(core)
