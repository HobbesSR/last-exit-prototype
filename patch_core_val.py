import re

with open("src/core.ts", "r", encoding="utf-8") as f:
    core = f.read()

core = core.replace(
    'if (map.validation.valid) break;',
    'if (map.validation.valid) break;\n      console.log(map.validation.errors);'
)

with open("src/core.ts", "w", encoding="utf-8") as f:
    f.write(core)
