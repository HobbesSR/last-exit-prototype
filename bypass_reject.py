import re

with open("src/core.ts", "r", encoding="utf-8") as f:
    content = f.read()

# I will log why it was rejected
replacement = """
      if (metrics.hunterDistance === Infinity || metrics.contestantDistance === Infinity) {
        console.log("Rejected! Hunter:", metrics.hunterDistance, "Contestant:", metrics.contestantDistance);
        map = { ...map, grid, features: [...spawns, ...exits], metrics, regions, micro };
        break; // break loop to return the invalid map for debugging!
      }
"""

content = re.sub(r'      if \(metrics\.hunterDistance === Infinity \|\| metrics\.contestantDistance === Infinity\) \{[^\}]+\}', replacement.strip(), content, flags=re.DOTALL)

with open("src/core.ts", "w", encoding="utf-8") as f:
    f.write(content)
