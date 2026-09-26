import re
with open("public/app.ts", "r", encoding="utf-8") as f:
    code = f.read()

code = re.sub(
    r'ctx\.fillStyle = false\s*\?\s*"#0a1419"\s*:\s*overlay === "region"\s*\?\s*regionColor\(regionIndexOf\(i\)\)\s*:\s*`hsl\(\$\{hash\(cellClass\) % 360\} 32% 30%\)`;',
    'ctx.fillStyle = false ? "#0a1419" : overlay === "region" ? (cellClass === "open" ? "#5a6268" : regionColor(regionIndexOf(i))) : (cellClass === "open" ? "#5a6268" : `hsl(${hash(cellClass) % 360} 32% 30%)`);',
    code
)

with open("public/app.ts", "w", encoding="utf-8") as f:
    f.write(code)
print("done")
