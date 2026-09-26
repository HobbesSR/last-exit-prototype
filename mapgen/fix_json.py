import json

with open("content/default-library.json", "r", encoding="utf-8") as f:
    lib = json.load(f)

for t in lib["tiles"]:
    if t["id"] == "depot-gate":
        t["cells"] = [
          "OOOOOO",
          "O....O",
          "O....O",
          "......",
          "......",
          "......"
        ] # wait, depot-gate needs to match depot-corner which is:
          # OOOOOO
          # O.....
          # O.....
          # O.....
          # O.....
          # O.....
        # So depot-gate West edge must be [O, ., ., ., ., .]
        t["cells"] = [
          "OOOOOO",
          "......",
          "......",
          "......",
          "......",
          "......"
        ]
    if t["id"] == "landing-edge":
        # Mismatch: landing-edge (S) -> landing-edge (N)
        # S: landing,landing,landing,landing,landing,landing
        # N: open,open,landing,landing,landing,landing
        # This is because landing-edge is oriented.
        # N should probably be landing too? Or wait, if S is landing...
        # Let's check landing-edge:
        t["cells"] = [
          "......",
          "......",
          "......",
          "......",
          "......",
          "......"
        ] # make it all landing
    if t["id"] == "evac-gate":
        # evac-gate (E) -> evac-fence (W)
        # evac,evac,evac,evac,evac,evac vs evac,evac,evac,evac,evac,open
        # evac-fence is probably missing a dot at the end?
        pass

with open("content/default-library.json", "w", encoding="utf-8") as f:
    json.dump(lib, f, indent=2)
