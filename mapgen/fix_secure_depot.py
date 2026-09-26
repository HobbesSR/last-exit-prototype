import json

with open("content/default-library.json", "r", encoding="utf-8") as f:
    library = json.load(f)

for sp in library["setPieces"]:
    if sp["id"] == "secure-depot":
        sp["tiles"] = [
            { "dx": 0, "dy": 0, "tileSetId": "depot-corners", "orientation": 0 },
            { "dx": 1, "dy": 0, "tileSetId": "depot-gates", "orientation": 0 },
            { "dx": 2, "dy": 0, "tileSetId": "depot-corners", "orientation": 90 },
            { "dx": 0, "dy": 1, "tileSetId": "depot-corners", "orientation": 270 },
            { "dx": 1, "dy": 1, "tileSetId": "depot-gates", "orientation": 180 }, # added bottom gate!
            { "dx": 2, "dy": 1, "tileSetId": "depot-corners", "orientation": 180 }
        ]

with open("content/default-library.json", "w", encoding="utf-8") as f:
    json.dump(library, f, indent=2)

print("Fixed secure-depot to have gates on top and bottom")
