import re

with open("src/core.ts", "r", encoding="utf-8") as f:
    core = f.read()

core = core.replace(
    'domain: [{',
    'domain: [{\n            weight: 1,'
)
core = core.replace(
    'domain.push({ templateId: t.id, orientation: o as any, difficulty: diff });',
    'domain.push({ templateId: t.id, orientation: o as any, difficulty: diff, weight: t.weight || 1 });'
)

with open("src/core.ts", "w", encoding="utf-8") as f:
    f.write(core)
