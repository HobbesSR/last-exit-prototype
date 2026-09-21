import re

with open("src/core.ts", "r", encoding="utf-8") as f:
    core = f.read()

# Replace assigned[i] inline block
core = re.sub(r'domain: \[\{\s*weight: 1,\s*templateId: assigned\[i\]!\.templateId,\s*orientation: assigned\[i\]!\.orientation as any,\s*difficulty: 0\s*\}\]', """domain: (function(){
              const a = assigned[i]!;
              const match = tiles.find(t => t.templateId === a.templateId && t.orientation === a.orientation);
              return match ? [match] : [{ weight: 1, templateId: a.templateId, orientation: a.orientation as any, difficulty: 0, id: undefined }];
            })()""", core, flags=re.DOTALL)

# Replace unassigned cell inline block
core = re.sub(r'const domain: TileOption\[\] = \[\];.*?return \{ x: c\.x, y: c\.y, domain \};', """const domain: TileOption[] = [];
          for (const t of validTiles) {
            for (const tOpt of tiles) {
              if (tOpt.templateId === t.id) domain.push(tOpt);
            }
          }
          return { x: c.x, y: c.y, domain };""", core, flags=re.DOTALL)

with open("src/core.ts", "w", encoding="utf-8") as f:
    f.write(core)
