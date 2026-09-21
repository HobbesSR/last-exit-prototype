import re

with open("src/wfc.ts", "r", encoding="utf-8") as f:
    wfc = f.read()

old_checks = """
      checkSide(cell.x, cell.y - 1, "N", "S");
      checkSide(cell.x, cell.y + 1, "S", "N");
      checkSide(cell.x - 1, cell.y, "W", "E");
      checkSide(cell.x + 1, cell.y, "E", "W");
"""

new_checks = """
      checkSide(cell.n, "N", "S");
      checkSide(cell.s, "S", "N");
      checkSide(cell.w, "W", "E");
      checkSide(cell.e, "E", "W");
"""
wfc = wfc.replace(old_checks.strip(), new_checks.strip())

with open("src/wfc.ts", "w", encoding="utf-8") as f:
    f.write(wfc)
