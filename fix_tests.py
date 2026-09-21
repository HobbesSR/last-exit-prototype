import re

with open("tests/core.test.ts", "r", encoding="utf-8") as f:
    core_test = f.read()

core_test = core_test.replace('N: "any",', 'N: ["any","any","any","any","any","any"],')
core_test = core_test.replace('S: "any",', 'S: ["any","any","any","any","any","any"],')
core_test = core_test.replace('E: "any",', 'E: ["any","any","any","any","any","any"],')
core_test = core_test.replace('W: "any",', 'W: ["any","any","any","any","any","any"],')
core_test = core_test.replace('N: "grass",', 'N: ["grass","grass","grass","grass","grass","grass"],')
core_test = core_test.replace('S: "grass",', 'S: ["grass","grass","grass","grass","grass","grass"],')
core_test = core_test.replace('E: "grass",', 'E: ["grass","grass","grass","grass","grass","grass"],')
core_test = core_test.replace('W: "grass",', 'W: ["grass","grass","grass","grass","grass","grass"],')

with open("tests/core.test.ts", "w", encoding="utf-8") as f:
    f.write(core_test)

with open("tests/primitives.test.ts", "r", encoding="utf-8") as f:
    prim_test = f.read()

prim_test = prim_test.replace('N: "wood"', 'N: ["wood","wood","wood","wood","wood","wood"]')
prim_test = prim_test.replace('S: "wood"', 'S: ["wood","wood","wood","wood","wood","wood"]')
prim_test = prim_test.replace('E: "brick"', 'E: ["brick","brick","brick","brick","brick","brick"]')
prim_test = prim_test.replace('W: "brick"', 'W: ["brick","brick","brick","brick","brick","brick"]')
prim_test = prim_test.replace('tilePrimitives(tile)', 'tilePrimitives(tile, 0)')

with open("tests/primitives.test.ts", "w", encoding="utf-8") as f:
    f.write(prim_test)
print("done")
