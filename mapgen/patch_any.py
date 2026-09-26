import json

with open("content/default-library.json", "r", encoding="utf-8") as f:
    lib = json.load(f)

for tile in lib["tiles"]:
    if tile.get("defaultCellClass") == "open":
        tile["defaultCellClass"] = "any"
    if "edges" in tile:
        del tile["edges"]
        
    # fix depot-gate
    if tile["id"] == "depot-gate":
        tile["cells"] = [
          "OOOOOO",
          "......",
          "......",
          "......",
          "......",
          "......"
        ]

    # fix evac-gate
    # evac-gate at 270 (so N -> E, E -> S, S -> W, W -> N)
    # evac-fence at 180 (so N -> S, E -> W, S -> N, W -> E)
    # the evac-fortress setpiece has 2x2.
    # (0,0): evac-corner (0)
    # (1,0): evac-fence (0)
    # (0,1): evac-gate (270)
    # (1,1): evac-fence (180)
    # evac-corner cells:
    # OOOOOO
    # O.....
    # O.....
    # O.....
    # O.....
    # O.....
    
    if tile["id"] == "evac-gate":
        # Needs to match evac-fence (180) on East edge!
        # evac-fence cells:
        # OOOOOO
        # ......
        # ......
        # ......
        # ......
        # ......
        # evac-fence (180) West edge is the source East edge (all .).
        # evac-gate (270) East edge is source North edge.
        # So its North edge must be all . !
        # But it also needs to match evac-corner (0) on North edge!
        # evac-corner South edge is all .
        # So evac-gate (270) North edge is source West edge. Must be all .
        # It needs O on its West edge (source South edge).
        tile["cells"] = [
          "......",
          "......",
          "......",
          "......",
          "......",
          "OOOOOO"
        ]

with open("content/default-library.json", "w", encoding="utf-8") as f:
    json.dump(lib, f, indent=2)
