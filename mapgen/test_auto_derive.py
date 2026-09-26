import json

with open("content/default-library.json", "r", encoding="utf-8") as f:
    lib = json.load(f)

# Clear ALL edges
for tile in lib["tiles"]:
    if "edges" in tile:
        del tile["edges"]

with open("content/default-library.json", "w", encoding="utf-8") as f:
    json.dump(lib, f, indent=2)
