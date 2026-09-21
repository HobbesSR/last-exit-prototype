import json

with open("content/default-library.json", "r", encoding="utf-8") as f:
    library = json.load(f)

for tile in library["tiles"]:
    tile["cells"] = [
        "......",
        "......",
        "......",
        "......",
        "......",
        "......"
    ]

with open("content/default-library.json", "w", encoding="utf-8") as f:
    json.dump(library, f, indent=2)

print("Removed all solid geometries from library tiles.")
