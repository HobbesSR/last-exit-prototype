import json

with open("content/default-library.json", "r", encoding="utf-8") as f:
    library = json.load(f)

# Fix store-mid to have gaps so players can cross the strip mall
for tile in library["tiles"]:
    if tile["id"] == "store-mid":
        tile["cells"] = [
            "#....#",
            "#....#",
            "......",
            "......",
            "#....#",
            "#....#"
        ]
    if tile["id"] == "store-end":
        tile["cells"] = [
            "######",
            "#....#",
            "......",
            "......",
            "#....#",
            "#....#"
        ]
    if tile["id"] == "office-gate":
        tile["cells"] = [
            "......",
            ".##.##",
            ".#....",
            "......",
            "......",
            ".#...."
        ]
    if tile["id"] == "office-corner":
        tile["cells"] = [
            "......",
            ".#####",
            ".#....",
            "......",
            "......",
            ".#...."
        ]
        
# Fix evac-fortress to have gate facing left and open right side
for sp in library["setPieces"]:
    if sp["id"] == "evac-fortress":
        sp["tiles"] = [
            # Left side (dx=0): facing the map. Needs a gate.
            { "dx": 0, "dy": 0, "tileSetId": "evac-tiles", "tileId": "evac-corner", "orientation": 0 },
            { "dx": 0, "dy": 1, "tileSetId": "evac-tiles", "tileId": "evac-gate", "orientation": 270 }, # Gate on the left
            { "dx": 0, "dy": 2, "tileSetId": "evac-tiles", "tileId": "evac-corner", "orientation": 270 },
            
            # Mid (dx=1)
            { "dx": 1, "dy": 0, "tileSetId": "evac-tiles", "tileId": "evac-wall", "orientation": 0 },
            { "dx": 1, "dy": 1, "tileSetId": "evac-tiles", "tileId": "evac-core", "orientation": 0 },
            { "dx": 1, "dy": 2, "tileSetId": "evac-tiles", "tileId": "evac-wall", "orientation": 180 },

            # Right side (dx=2): facing the exits. Needs to be open or gates.
            { "dx": 2, "dy": 0, "tileSetId": "evac-tiles", "tileId": "evac-wall", "orientation": 0 },
            { "dx": 2, "dy": 1, "tileSetId": "evac-tiles", "tileId": "evac-core", "orientation": 0 }, # no wall
            { "dx": 2, "dy": 2, "tileSetId": "evac-tiles", "tileId": "evac-wall", "orientation": 180 }
        ]

with open("content/default-library.json", "w", encoding="utf-8") as f:
    json.dump(library, f, indent=2)

print("Fixed")
