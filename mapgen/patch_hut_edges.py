import json

with open("content/default-library.json", "r", encoding="utf-8") as f:
    lib = json.load(f)

for tile in lib["tiles"]:
    if tile["id"] == "open-hut-edge":
        tile["edges"] = {
            "N": ["any", "any", "any", "any", "any", "any"],
            "E": ["any", "any", "any", "any", "any", "any"],
            "W": ["any", "any", "any", "any", "any", "any"],
            "S": ["any", "hut", "hut", "hut", "hut", "any"]
        }
    elif tile["id"] == "open-hut-corner":
        tile["edges"] = {
            "N": ["any", "any", "any", "any", "any", "any"],
            "W": ["any", "any", "any", "any", "any", "any"],
            "E": ["any", "any", "hut", "hut", "hut", "hut"],
            "S": ["any", "any", "hut", "hut", "hut", "hut"]
        }
        # wait! For E, from top to bottom (N to S): it is "open", "open", "hut", "hut", "hut", "hut". (any = open)
        # For S, from left to right (W to E): it is "open", "open", "hut", "hut", "hut", "hut".
        # Let's verify the cells for open-hut-corner.
        # cells:
        # 0: "......"
        # 1: "......"
        # 2: "..HHHH"
        # 3: "..HHHH"
        # 4: "..HHHH"
        # 5: "..HHHH"
        # E edge (x=5) is '.' for y=0,1, and 'H' for y=2,3,4,5. So ['any', 'any', 'hut', 'hut', 'hut', 'hut'].
        # S edge (y=5) is '.' for x=0,1, and 'H' for x=2,3,4,5. So ['any', 'any', 'hut', 'hut', 'hut', 'hut'].
        # Correct!

with open("content/default-library.json", "w", encoding="utf-8") as f:
    json.dump(lib, f, indent=2)
