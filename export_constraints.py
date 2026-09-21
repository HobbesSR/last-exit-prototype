with open("src/core.ts", "r", encoding="utf-8") as f:
    code = f.read()

# Add constraints to GridViews in core.ts
code = code.replace(
    'originalClass: (index: number) => string;',
    'originalClass: (index: number) => string;\n    constraints: (index: number) => string;'
)

code = code.replace(
    'originalClass: grid.cells.originalClass ? gridReader(grid.cells.originalClass) : readClass,',
    'originalClass: grid.cells.originalClass ? gridReader(grid.cells.originalClass) : readClass,\n      constraints: grid.cells.constraints ? gridReader(grid.cells.constraints) : () => "any",'
)

code = code.replace(
    'originalClass: encodeGrid(composition.cellClass),',
    'originalClass: encodeGrid(composition.cellClass),\n          constraints: encodeGrid(cellConstraints),'
)

with open("src/core.ts", "w", encoding="utf-8") as f:
    f.write(code)

with open("src/types.ts", "r", encoding="utf-8") as f:
    types = f.read()

types = types.replace(
    'originalClass?: CodedGrid<string>;',
    'originalClass?: CodedGrid<string>;\n    constraints?: CodedGrid<string>;'
)

with open("src/types.ts", "w", encoding="utf-8") as f:
    f.write(types)
print("done")
