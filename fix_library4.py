import json

with open("content/default-library.json", "r", encoding="utf-8") as f:
    library = json.load(f)

# Split tile sets
library["tileSets"] = [
    { "id": "drop-site-tiles", "members": ["drop-pad"] },
    { "id": "drop-border-tiles", "members": ["drop-border"] },
    
    { "id": "evac-core-tiles", "members": ["evac-core"] },
    { "id": "evac-wall-tiles", "members": ["evac-wall"] },
    { "id": "evac-gate-tiles", "members": ["evac-gate"] },
    { "id": "evac-corner-tiles", "members": ["evac-corner"] },
    
    { "id": "store-mid-tiles", "members": ["store-mid"] },
    { "id": "store-end-tiles", "members": ["store-end"] },
    
    { "id": "park-tiles", "members": ["park-ground"] },
    
    { "id": "office-corner-tiles", "members": ["office-corner"] },
    { "id": "office-gate-tiles", "members": ["office-gate"] },
    
    { "id": "filler-tiles", "members": ["street", "ruin"] }
]

for sp in library["setPieces"]:
    if sp["id"] == "drop-site":
        sp["tiles"] = [
            { "dx": 0, "dy": 0, "tileSetId": "drop-border-tiles" },
            { "dx": 1, "dy": 0, "tileSetId": "drop-border-tiles" },
            { "dx": 2, "dy": 0, "tileSetId": "drop-border-tiles" },
            { "dx": 0, "dy": 1, "tileSetId": "drop-border-tiles" },
            { "dx": 1, "dy": 1, "tileSetId": "drop-site-tiles" }, # drop pad
            { "dx": 2, "dy": 1, "tileSetId": "drop-border-tiles" }
        ]
    if sp["id"] == "evac-fortress":
        sp["tiles"] = [
            { "dx": 0, "dy": 0, "tileSetId": "evac-corner-tiles", "orientation": 0 },
            { "dx": 0, "dy": 1, "tileSetId": "evac-gate-tiles", "orientation": 270 },
            { "dx": 1, "dy": 0, "tileSetId": "evac-wall-tiles", "orientation": 0 },
            { "dx": 1, "dy": 1, "tileSetId": "evac-wall-tiles", "orientation": 180 }
        ]
    if sp["id"] == "strip-mall":
        sp["tiles"] = [
            { "dx": 0, "dy": 0, "tileSetId": "store-end-tiles", "orientation": 0 },
            { "dx": 0, "dy": 1, "tileSetId": "store-end-tiles", "orientation": 180 }
        ]
    if sp["id"] == "corporate-campus":
        sp["tiles"] = [
            { "dx": 0, "dy": 0, "tileSetId": "office-corner-tiles", "orientation": 0 },
            { "dx": 1, "dy": 0, "tileSetId": "office-corner-tiles", "orientation": 90 },
            { "dx": 0, "dy": 1, "tileSetId": "office-corner-tiles", "orientation": 270 },
            { "dx": 1, "dy": 1, "tileSetId": "office-gate-tiles", "orientation": 180 }
        ]

with open("content/default-library.json", "w", encoding="utf-8") as f:
    json.dump(library, f, indent=2)

print("Fixed")
