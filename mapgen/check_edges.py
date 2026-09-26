import json

with open("content/default-library.json", "r", encoding="utf-8") as f:
    lib = json.load(f)

for tile in lib["tiles"]:
    if "cells" in tile:
        cells = tile["cells"]
        if len(cells) == 6 and len(cells[0]) == 6:
            touches_edge = False
            for y in range(6):
                for x in range(6):
                    if cells[y][x] != '.':
                        if x == 0 or x == 5 or y == 0 or y == 5:
                            touches_edge = True
            
            if touches_edge:
                print(f"{tile['id']} touches edge!")
                print("\n".join(cells))
