import json

with open("content/default-library.json", "r", encoding="utf-8") as f:
    library = json.load(f)

for sp in library["setPieces"]:
    if sp["id"] == "evac-fortress":
        sp["tiles"] = [
            { "dx": 0, "dy": 0, "tileSetId": "evac-tiles", "tileId": "evac-corner", "orientation": 0 },
            { "dx": 0, "dy": 1, "tileSetId": "evac-tiles", "tileId": "evac-gate", "orientation": 270 },
            { "dx": 1, "dy": 0, "tileSetId": "evac-tiles", "tileId": "evac-wall", "orientation": 0 },
            { "dx": 1, "dy": 1, "tileSetId": "evac-tiles", "tileId": "evac-wall", "orientation": 180 }
        ]
    if sp["id"] == "strip-mall":
        # 1x2 to fit in 2-height zones easily
        sp["tiles"] = [
            { "dx": 0, "dy": 0, "tileSetId": "commercial-tiles", "tileId": "store-end", "orientation": 0 },
            { "dx": 0, "dy": 1, "tileSetId": "commercial-tiles", "tileId": "store-end", "orientation": 180 }
        ]

with open("content/default-library.json", "w", encoding="utf-8") as f:
    json.dump(library, f, indent=2)

print("Fixed")
