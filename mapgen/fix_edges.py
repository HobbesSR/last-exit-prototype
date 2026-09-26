import json

with open("content/default-library.json", "r", encoding="utf-8") as f:
    lib = json.load(f)

for tile in lib["tiles"]:
    if tile.get("defaultCellClass") == "any":
        if "edges" in tile:
            del tile["edges"]

with open("content/default-library.json", "w", encoding="utf-8") as f:
    json.dump(lib, f, indent=2)
