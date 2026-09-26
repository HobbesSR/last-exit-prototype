import json

with open("content/default-library.json", "r", encoding="utf-8") as f:
    library = json.load(f)

for tile in library["tiles"]:
    if tile["id"] == "street":
        tile["weight"] = 1
    elif tile.get("walls"):
        # has walls, won't be in filler pool anyway
        pass
    else:
        # safe tile
        tile["weight"] = 5

with open("content/default-library.json", "w", encoding="utf-8") as f:
    json.dump(library, f, indent=2)
