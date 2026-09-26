import re

with open("src/core.ts", "r", encoding="utf-8") as f:
    core = f.read()

# Add try-catch around the loop body
old_loop = """
  for (let attempt = 0; attempt < 50; attempt++) {
    
    let seedState = 0;
"""

new_loop = """
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      let seedState = 0;
"""
core = core.replace(old_loop, new_loop)

old_end = """
    if (map) break;
  }
  
  if (!map) {
"""

new_end = """
    if (map) break;
    } catch (e) {
      console.warn("Attempt", attempt, "failed:", e);
    }
  }
  
  if (!map) {
"""
core = core.replace(old_end, new_end)

with open("src/core.ts", "w", encoding="utf-8") as f:
    f.write(core)
