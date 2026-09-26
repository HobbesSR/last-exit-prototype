import re

with open("src/core.ts", "r", encoding="utf-8") as f:
    core = f.read()

core = core.replace('// console.warn("Attempt", attempt, "failed:", e);', 'console.warn("Attempt", attempt, "failed:", (e as Error).message);')

with open("src/core.ts", "w", encoding="utf-8") as f:
    f.write(core)
