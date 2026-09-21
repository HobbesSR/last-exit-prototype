import re

with open("src/types.ts", "r", encoding="utf-8") as f:
    types = f.read()

types = types.replace(
    'adapter?: boolean;',
    'adapter?: boolean;\n  weight?: number;'
)

with open("src/types.ts", "w", encoding="utf-8") as f:
    f.write(types)
