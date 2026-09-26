import re

with open("src/primitives.ts", "r", encoding="utf-8") as f:
    content = f.read()

content = re.sub(
    r'function parseSide\(\n  value: string \| SegmentDeclaration\[\] \| undefined,\n\): SegmentDeclaration\[\] {',
    'function parseSide(\n  value: string[] | undefined,\n): SegmentDeclaration[] {',
    content
)

content = re.sub(
    r'if \(typeof value === "string"\).*?else\n',
    'if (false) {} else\n',
    content,
    flags=re.DOTALL
)

with open("src/primitives.ts", "w", encoding="utf-8") as f:
    f.write(content)

print("patched")
