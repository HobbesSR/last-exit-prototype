import json

with open("content/default-library.json", "r", encoding="utf-8") as f:
    lib = json.load(f)

for tile in lib["tiles"]:
    if tile["defaultCellClass"] == "open":
        if "edges" not in tile:
            tile["edges"] = {
                "N": ["open", "open", "open", "open", "open", "open"],
                "E": ["open", "open", "open", "open", "open", "open"],
                "S": ["open", "open", "open", "open", "open", "open"],
                "W": ["open", "open", "open", "open", "open", "open"]
            }

with open("content/default-library.json", "w", encoding="utf-8") as f:
    json.dump(lib, f, indent=2)
