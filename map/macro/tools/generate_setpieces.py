"""Regenerates the setPieces section of content/default-library.json.

Replaces setPieces wholesale and leaves every other key untouched; the output
is deterministic. Run from map/macro/: python tools/generate_setpieces.py
"""
import json
import random

# Perimeters whose edge tiles are an unbroken fence, and the gate tile that
# opens each one.
GATES = {"depot-fences": "depot-gates", "evac-fences": "evac-gates"}

def generate():
    with open("content/default-library.json", "r") as f:
        lib = json.load(f)
    
    setPieces = []

    def make_perimeter_piece(id_name, category, w, h, eligible, corner_set, edge_set, interior_set=None, c_class="open"):
        # A fenced perimeter needs a way in: the middle of each side takes the
        # style's gate, so the compound can be crossed whichever way the map
        # runs past it. secure-depot had gates before 30e4df7 dropped them.
        gate_set = GATES.get(edge_set)
        tiles = []
        for dy in range(h):
            for dx in range(w):
                is_tl = (dx == 0 and dy == 0)
                is_tr = (dx == w-1 and dy == 0)
                is_bl = (dx == 0 and dy == h-1)
                is_br = (dx == w-1 and dy == h-1)
                
                is_t = (dy == 0)
                is_b = (dy == h-1)
                is_l = (dx == 0)
                is_r = (dx == w-1)
                
                if corner_set is None and edge_set is None:
                    tiles.append({"dx": dx, "dy": dy, "tileSetId": interior_set})
                elif is_tl:
                    tiles.append({"dx": dx, "dy": dy, "tileSetId": corner_set, "orientation": 0})
                elif is_tr:
                    tiles.append({"dx": dx, "dy": dy, "tileSetId": corner_set, "orientation": 90})
                elif is_br:
                    tiles.append({"dx": dx, "dy": dy, "tileSetId": corner_set, "orientation": 180})
                elif is_bl:
                    tiles.append({"dx": dx, "dy": dy, "tileSetId": corner_set, "orientation": 270})
                elif is_t:
                    tiles.append({"dx": dx, "dy": dy, "tileSetId": gate_set if gate_set and dx == w // 2 else edge_set, "orientation": 0})
                elif is_r:
                    tiles.append({"dx": dx, "dy": dy, "tileSetId": gate_set if gate_set and dy == h // 2 else edge_set, "orientation": 90})
                elif is_b:
                    tiles.append({"dx": dx, "dy": dy, "tileSetId": gate_set if gate_set and dx == w // 2 else edge_set, "orientation": 180})
                elif is_l:
                    tiles.append({"dx": dx, "dy": dy, "tileSetId": gate_set if gate_set and dy == h // 2 else edge_set, "orientation": 270})
                else:
                    if interior_set:
                        tiles.append({"dx": dx, "dy": dy, "tileSetId": interior_set})
        return {
            "id": id_name,
            "category": category,
            "class": c_class,
            "eligibleTiers": eligible,
            "tiles": tiles
        }

    # Start and End
    # Start: market
    setPieces.append(make_perimeter_piece("start-base", "start", 2, 6, [1, 2, 3, 4, 5], None, None, "market-interiors", "market"))
    # End: evac
    setPieces.append(make_perimeter_piece("end-base", "end", 2, 6, [1, 2, 3, 4, 5], None, None, "landing-centers", "landing"))

    # Enormous: 5 unique (~50 tiles)
    enormous_dims = [(10, 5), (8, 6), (12, 4), (7, 7), (9, 6)]
    for i, dim in enumerate(enormous_dims):
        styles = [
            ("market-corners", "market-fronts", "market-interiors", "market"),
            ("depot-corners", "depot-fences", None, "industrial"),
            ("landing-corners", "landing-edges", "landing-centers", "landing")
        ]
        style = styles[i % len(styles)]
        setPieces.append(make_perimeter_piece(f"enormous-{i}", "enormous", dim[0], dim[1], [1,2,3,4,5], style[0], style[1], style[2], style[3]))
    
    # Medium: 6 unique (~36 tiles)
    medium_dims = [(6, 6), (9, 4), (12, 3), (7, 5), (8, 4), (6, 5)]
    for i, dim in enumerate(medium_dims):
        styles = [
            ("evac-corners", "evac-fences", None, "military"),
            ("market-corners", "market-fronts", "market-interiors", "market")
        ]
        style = styles[i % len(styles)]
        setPieces.append(make_perimeter_piece(f"medium-{i}", "medium", dim[0], dim[1], [1,2,3,4,5], style[0], style[1], style[2], style[3]))

    # Small: 10 unique (~18 tiles)
    small_dims = [(6, 3), (4, 4), (9, 2), (5, 4), (3, 6), (6, 4), (7, 3), (4, 5), (5, 3), (8, 2)]
    for i, dim in enumerate(small_dims):
        styles = [
            ("depot-corners", "depot-fences", None, "industrial"),
            ("landing-corners", "landing-edges", "landing-centers", "landing")
        ]
        style = styles[i % len(styles)]
        setPieces.append(make_perimeter_piece(f"small-{i}", "small", dim[0], dim[1], [1,2,3,4,5], style[0], style[1], style[2], style[3]))

    lib["setPieces"] = setPieces

    with open("content/default-library.json", "w") as f:
        json.dump(lib, f, indent=2)

if __name__ == "__main__":
    generate()
