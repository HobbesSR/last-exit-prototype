import re

with open("src/core.ts", "r", encoding="utf-8") as f:
    core = f.read()

# Update generateMap signature
old_sig = """
export function generateMap(
  seed: string | number = "last-exit",
  params: Partial<MapParams> = {},
  library: Library = DEFAULT_LIBRARY,
): GeneratedMap {
"""

new_sig = """
export function generateMap(
  seed: string | number = "last-exit",
  params: Partial<MapParams> = {},
  library: Library = DEFAULT_LIBRARY,
  onProgress?: (status: string, progress: number) => void
): GeneratedMap {
"""
core = core.replace(old_sig.strip(), new_sig.strip())

# Add progress reporting to attempt loop
old_loop = """
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      let seedState = 0;
"""

new_loop = """
  for (let attempt = 0; attempt < 50; attempt++) {
    if (onProgress) onProgress(`Attempt ${attempt + 1}/50`, attempt / 50);
    try {
      let seedState = 0;
"""
core = core.replace(old_loop.strip(), new_loop.strip())

with open("src/core.ts", "w", encoding="utf-8") as f:
    f.write(core)
