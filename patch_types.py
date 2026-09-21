import re

with open("src/types.ts", "r", encoding="utf-8") as f:
    content = f.read()

# Replace edges and corners in TileDesign
content = re.sub(
    r'edges\?: Partial<Record<Side, string \| SegmentDeclaration\[\]>>;',
    'edges?: Partial<Record<Side, string[]>>;',
    content
)

content = re.sub(
    r'corners\?: Partial<Record<Side, Array<string \| VertexDeclaration>>>;',
    'corners?: Partial<Record<Side, string[]>>;',
    content
)

with open("src/types.ts", "w", encoding="utf-8") as f:
    f.write(content)

print("Patched types.ts")
