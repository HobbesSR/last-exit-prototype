import json

with open("content/default-library.json", "r", encoding="utf-8") as f:
    library = json.load(f)

for tile in library["tiles"]:
    if "edges" in tile:
        # let's just make it empty or remove it so it's ANY
        del tile["edges"]

with open("content/default-library.json", "w", encoding="utf-8") as f:
    json.dump(library, f, indent=2)
