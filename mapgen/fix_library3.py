import json

with open("content/default-library.json", "r", encoding="utf-8") as f:
    library = json.load(f)

for sp in library["setPieces"]:
    if sp["id"] == "drop-site":
        sp["eligibleTiers"] = [1]

with open("content/default-library.json", "w", encoding="utf-8") as f:
    json.dump(library, f, indent=2)

print("Fixed")
