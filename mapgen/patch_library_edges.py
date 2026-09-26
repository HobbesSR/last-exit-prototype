import json

with open("content/default-library.json", "r", encoding="utf-8") as f:
    library = json.load(f)

for tile in library["tiles"]:
    if tile["id"] == "market-interior":
        m = ["market", "market", "market", "market", "market", "market"]
        tile["edges"] = {"N": m, "E": m, "S": m, "W": m}
    elif tile["id"] == "park-interior":
        p = ["park", "park", "park", "park", "park", "park"]
        tile["edges"] = {"N": p, "E": p, "S": p, "W": p}
    elif tile["id"] == "landing-interior":
        l = ["landing", "landing", "landing", "landing", "landing", "landing"]
        tile["edges"] = {"N": l, "E": l, "S": l, "W": l}

with open("content/default-library.json", "w", encoding="utf-8") as f:
    json.dump(library, f, indent=2)

print("patched library edges")
