import re

with open("src/wfc.ts", "r", encoding="utf-8") as f:
    content = f.read()

content = content.replace("CellDomain", "WfcCell")
content = content.replace("ConstraintGrid", "WfcGrid")

with open("src/wfc.ts", "w", encoding="utf-8") as f:
    f.write(content)
