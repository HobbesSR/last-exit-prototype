import re
with open("src/macro-types.ts", "r", encoding="utf-8") as f:
    types = f.read()

if "effectiveCellClass" not in types:
    types = types.replace(
        "cellClass: string[];",
        "cellClass: string[];\n  effectiveCellClass: string[];"
    )
    with open("src/macro-types.ts", "w", encoding="utf-8") as f:
        f.write(types)

with open("src/macro.ts", "r", encoding="utf-8") as f:
    macro = f.read()

macro = macro.replace(
    'for (let i = 0; i < cellClass.length; i++)\n    cellSolid[i] = false;',
    '''for (let i = 0; i < cellClass.length; i++)
    cellSolid[i] = false;

  const effectiveCellClass = [...cellClass];
  for (let i = 0; i < effectiveCellClass.length; i++) {
    if (effectiveCellClass[i] === "any") effectiveCellClass[i] = "open";
  }'''
)

macro = macro.replace(
    'cellClass,\n    cellSolid,',
    'cellClass,\n    effectiveCellClass,\n    cellSolid,'
)

macro = macro.replace(
    '{ W: width, H: height, cellClass, segmentOpen, segmentIndex },',
    '{ W: width, H: height, cellClass: effectiveCellClass, segmentOpen, segmentIndex },'
)

with open("src/macro.ts", "w", encoding="utf-8") as f:
    f.write(macro)

with open("src/core.ts", "r", encoding="utf-8") as f:
    core = f.read()

core = core.replace(
    'cellClass: composition.cellClass,',
    'cellClass: composition.effectiveCellClass,'
)

with open("src/core.ts", "w", encoding="utf-8") as f:
    f.write(core)
print("done")
