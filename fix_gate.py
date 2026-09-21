import json

with open("content/default-library.json", "r", encoding="utf-8") as f:
    library = json.load(f)

for tile in library["tiles"]:
    if tile["id"] == "depot-gate":
        # Make the interior 'open' as well so there's a path through
        tile["legend"]["O"] = "open"
        tile["cells"] = [
            "OOOOOO",
            "OOOOOO",
            "OOOOOO",
            "OOOOOO",
            "OOOOOO",
            "OOOOOO"
        ]

with open("content/default-library.json", "w", encoding="utf-8") as f:
    json.dump(library, f, indent=2)
