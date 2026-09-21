import json

library = {
    "version": 2,
    "cellClasses": {
        "landing": { "generator": "rubble", "clutterChance": 0.05, "clutterSize": 0.5 },
        "evac": { "generator": "compound", "clutterChance": 0.2, "clutterSize": 0.8 },
        "evac-perimeter": { "generator": "pillar-hall", "clutterChance": 0.0, "clutterSize": 0.8 },
        "market": { "generator": "compound", "clutterChance": 0.15, "clutterSize": 0.4 },
        "overgrowth": { "generator": "open-field", "clutterChance": 0.25, "clutterSize": 0.6, "generatorParams": { "coverDensity": 0.8 } },
        "office": { "generator": "pillar-hall", "clutterChance": 0.05, "clutterSize": 0.6 },
        "street": { "generator": "open-field", "clutterChance": 0.02, "clutterSize": 0.5 },
        "ruin": { "generator": "rubble", "clutterChance": 0.1, "clutterSize": 0.5 }
    },
    "tiles": [
        {
            "id": "drop-pad",
            "defaultCellClass": "landing",
            "orientations": [0, 90, 180, 270],
            "cells": ["......", "......", "......", "......", "......", "......"],
            "anchor": {"x": 3, "y": 3}
        },
        {
            "id": "drop-border",
            "defaultCellClass": "landing",
            "orientations": [0, 90, 180, 270],
            "cells": ["......", "......", "......", "......", "......", "......"],
            "anchor": {"x": 3, "y": 3}
        },
        {
            "id": "evac-core",
            "defaultCellClass": "evac",
            "orientations": [0, 90, 180, 270],
            "cells": [
                "......",
                ".####.",
                ".####.",
                ".####.",
                ".####.",
                "......"
            ],
            "anchor": {"x": 0.5, "y": 0.5}
        },
        {
            "id": "evac-wall",
            "defaultCellClass": "evac-perimeter",
            "orientations": [0, 90, 180, 270],
            "cells": [
                "......",
                "######",
                "......",
                "......",
                "......",
                "......"
            ],
            "anchor": {"x": 3, "y": 4}
        },
        {
            "id": "evac-corner",
            "defaultCellClass": "evac-perimeter",
            "orientations": [0, 90, 180, 270],
            "cells": [
                "......",
                ".#####",
                ".#....",
                ".#....",
                ".#....",
                ".#...."
            ],
            "anchor": {"x": 4, "y": 4}
        },
        {
            "id": "evac-gate",
            "defaultCellClass": "evac-perimeter",
            "orientations": [0, 90, 180, 270],
            "cells": [
                "......",
                "##..##",
                "......",
                "......",
                "......",
                "......"
            ],
            "anchor": {"x": 3, "y": 4}
        },
        {
            "id": "store-mid",
            "defaultCellClass": "market",
            "orientations": [0, 90, 180, 270],
            "cells": [
                "#....#",
                "#....#",
                "#....#",
                "#....#",
                "#....#",
                "#....#"
            ],
            "anchor": {"x": 3, "y": 3}
        },
        {
            "id": "store-end",
            "defaultCellClass": "market",
            "orientations": [0, 90, 180, 270],
            "cells": [
                "######",
                "#....#",
                "#....#",
                "#....#",
                "#....#",
                "#....#"
            ],
            "anchor": {"x": 3, "y": 3}
        },
        {
            "id": "park-ground",
            "defaultCellClass": "overgrowth",
            "orientations": [0, 90, 180, 270],
            "cells": ["......", "......", "......", "......", "......", "......"],
            "anchor": {"x": 3, "y": 3}
        },
        {
            "id": "office-corner",
            "defaultCellClass": "office",
            "orientations": [0, 90, 180, 270],
            "cells": [
                "......",
                ".#####",
                ".#....",
                ".#....",
                ".#....",
                ".#...."
            ],
            "anchor": {"x": 4, "y": 4}
        },
        {
            "id": "office-gate",
            "defaultCellClass": "office",
            "orientations": [0, 90, 180, 270],
            "cells": [
                "......",
                ".##.##",
                ".#....",
                ".#....",
                ".#....",
                ".#...."
            ],
            "anchor": {"x": 4, "y": 4}
        },
        {
            "id": "street",
            "defaultCellClass": "street",
            "orientations": [0, 90, 180, 270],
            "cells": ["......", "......", "......", "......", "......", "......"],
            "anchor": {"x": 3, "y": 3},
            "adapter": True,
            "weight": 10
        },
        {
            "id": "ruin",
            "defaultCellClass": "ruin",
            "orientations": [0, 90, 180, 270],
            "cells": ["......", "......", "......", "......", "......", "......"],
            "anchor": {"x": 3, "y": 3},
            "adapter": True,
            "weight": 5
        }
    ],
    "tileSets": [
        { "id": "drop-site-tiles", "members": ["drop-pad", "drop-border"] },
        { "id": "evac-tiles", "members": ["evac-core", "evac-wall", "evac-gate", "evac-corner"] },
        { "id": "commercial-tiles", "members": ["store-mid", "store-end"] },
        { "id": "park-tiles", "members": ["park-ground"] },
        { "id": "office-tiles", "members": ["office-corner", "office-gate"] },
        { "id": "filler-tiles", "members": ["street", "ruin"] }
    ],
    "setPieces": [
        {
            "id": "drop-site",
            "class": "landing",
            "eligibleTiers": [0],
            "tiles": [
                { "dx": 0, "dy": 0, "tileSetId": "drop-site-tiles", "tileId": "drop-border" },
                { "dx": 1, "dy": 0, "tileSetId": "drop-site-tiles", "tileId": "drop-border" },
                { "dx": 2, "dy": 0, "tileSetId": "drop-site-tiles", "tileId": "drop-border" },
                { "dx": 0, "dy": 1, "tileSetId": "drop-site-tiles", "tileId": "drop-border" },
                { "dx": 1, "dy": 1, "tileSetId": "drop-site-tiles", "tileId": "drop-pad" },
                { "dx": 2, "dy": 1, "tileSetId": "drop-site-tiles", "tileId": "drop-border" }
            ]
        },
        {
            "id": "evac-fortress",
            "class": "evac",
            "eligibleTiers": [5],
            "tiles": [
                { "dx": 0, "dy": 0, "tileSetId": "evac-tiles", "tileId": "evac-corner", "orientation": 0 },
                { "dx": 1, "dy": 0, "tileSetId": "evac-tiles", "tileId": "evac-gate", "orientation": 0 },
                { "dx": 2, "dy": 0, "tileSetId": "evac-tiles", "tileId": "evac-corner", "orientation": 90 },
                { "dx": 0, "dy": 1, "tileSetId": "evac-tiles", "tileId": "evac-wall", "orientation": 270 },
                { "dx": 1, "dy": 1, "tileSetId": "evac-tiles", "tileId": "evac-core", "orientation": 0 },
                { "dx": 2, "dy": 1, "tileSetId": "evac-tiles", "tileId": "evac-wall", "orientation": 90 },
                { "dx": 0, "dy": 2, "tileSetId": "evac-tiles", "tileId": "evac-corner", "orientation": 270 },
                { "dx": 1, "dy": 2, "tileSetId": "evac-tiles", "tileId": "evac-wall", "orientation": 180 },
                { "dx": 2, "dy": 2, "tileSetId": "evac-tiles", "tileId": "evac-corner", "orientation": 180 }
            ]
        },
        {
            "id": "strip-mall",
            "class": "market",
            "eligibleTiers": [1, 2, 3, 4],
            "tiles": [
                { "dx": 0, "dy": 0, "tileSetId": "commercial-tiles", "tileId": "store-end", "orientation": 0 },
                { "dx": 0, "dy": 1, "tileSetId": "commercial-tiles", "tileId": "store-mid", "orientation": 0 },
                { "dx": 0, "dy": 2, "tileSetId": "commercial-tiles", "tileId": "store-mid", "orientation": 0 },
                { "dx": 0, "dy": 3, "tileSetId": "commercial-tiles", "tileId": "store-end", "orientation": 180 }
            ]
        },
        {
            "id": "corporate-campus",
            "class": "office",
            "eligibleTiers": [2, 3, 4],
            "tiles": [
                { "dx": 0, "dy": 0, "tileSetId": "office-tiles", "tileId": "office-corner", "orientation": 0 },
                { "dx": 1, "dy": 0, "tileSetId": "office-tiles", "tileId": "office-corner", "orientation": 90 },
                { "dx": 0, "dy": 1, "tileSetId": "office-tiles", "tileId": "office-corner", "orientation": 270 },
                { "dx": 1, "dy": 1, "tileSetId": "office-tiles", "tileId": "office-gate", "orientation": 180 }
            ]
        },
        {
            "id": "overgrown-park",
            "class": "overgrowth",
            "eligibleTiers": [1, 2, 3, 4],
            "tiles": [
                { "dx": 0, "dy": 0, "tileSetId": "park-tiles", "tileId": "park-ground" },
                { "dx": 1, "dy": 0, "tileSetId": "park-tiles", "tileId": "park-ground" }
            ]
        }
    ]
}

with open("content/default-library.json", "w", encoding="utf-8") as f:
    json.dump(library, f, indent=2)

print("Done")
