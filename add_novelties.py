import json

with open("content/default-library.json", "r", encoding="utf-8") as f:
    lib = json.load(f)

def make_tile(name, cls, char, shape, weight=1.0):
    if shape == "2x2":
        cells = [
          "......",
          "......",
          f"..{char*2}..",
          f"..{char*2}..",
          "......",
          "......"
        ]
    elif shape == "3x3":
        cells = [
          "......",
          f".{char*3}..",
          f".{char*3}..",
          f".{char*3}..",
          "......",
          "......"
        ]
    elif shape == "2x4":
        cells = [
          "......",
          f"..{char*2}..",
          f"..{char*2}..",
          f"..{char*2}..",
          f"..{char*2}..",
          "......"
        ]
    elif shape == "caticorner":
        cells = [
          "......",
          f".{char*2}...",
          f".{char*2}...",
          f"...{char*2}.",
          f"...{char*2}.",
          "......"
        ]
    elif shape == "hut-center":
        cells = [
          "......",
          f".{char*4}.",
          f".{char*4}.",
          f".{char*4}.",
          f".{char*4}.",
          "......"
        ]
    elif shape == "hut-edge":
        cells = [
          "......",
          "......",
          f".{char*4}.",
          f".{char*4}.",
          f".{char*4}.",
          f".{char*4}."
        ]
    elif shape == "hut-corner":
        cells = [
          "......",
          "......",
          f"..{char*4}",
          f"..{char*4}",
          f"..{char*4}",
          f"..{char*4}"
        ]

    return {
        "id": name,
        "defaultCellClass": "open",
        "legend": { char: cls },
        "cells": cells,
        "orientations": [0, 90, 180, 270],
        "anchor": { "x": 3, "y": 3 },
        "weight": weight
    }

new_tiles = []
for cls, char in [("tree", "T"), ("rock", "R"), ("rubble", "B")]:
    for shape in ["2x2", "3x3", "2x4", "caticorner"]:
        new_tiles.append(make_tile(f"open-{cls}-{shape}", cls, char, shape, 0.5))

new_tiles.append(make_tile("open-hut-center", "hut", "H", "hut-center", 0.5))
new_tiles.append(make_tile("open-hut-edge", "hut", "H", "hut-edge", 0.5))
new_tiles.append(make_tile("open-hut-corner", "hut", "H", "hut-corner", 0.5))

# Filter out if they already exist
existing_ids = {t["id"] for t in lib["tiles"]}
for t in new_tiles:
    if t["id"] not in existing_ids:
        lib["tiles"].append(t)

# Also update street weight to be much higher, so it's a true common filler
for t in lib["tiles"]:
    if t["id"] == "street":
        t["weight"] = 15.0

with open("content/default-library.json", "w", encoding="utf-8") as f:
    json.dump(lib, f, indent=2)

print("Added novelties to library.")
