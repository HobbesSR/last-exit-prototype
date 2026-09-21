with open("src/core.ts", "r", encoding="utf-8") as f:
    code = f.read()

code = code.replace(
    'const opt = { templateId: t.templateId, orientation: t.orientation as Orientation, difficulty: 0, weight: 1 };',
    'const opt = { templateId: t.templateId, orientation: t.orientation as any, difficulty: 0, weight: 1 };'
)

with open("src/core.ts", "w", encoding="utf-8") as f:
    f.write(code)
print("done")
