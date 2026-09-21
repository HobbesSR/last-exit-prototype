import re

with open("src/core.ts", "r", encoding="utf-8") as f:
    content = f.read()

replacement = """
      if (!allPlaced) {
        console.log("Not all placed!");
        continue;
      }
"""

content = re.sub(r'      if \(\!allPlaced\) continue;', replacement.strip(), content, flags=re.DOTALL)

with open("src/core.ts", "w", encoding="utf-8") as f:
    f.write(content)
