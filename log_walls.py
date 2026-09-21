import json

with open("content/default-library.json", "r", encoding="utf-8") as f:
    library = json.load(f)

# Find depot-gate
dg = next(t for t in library["tiles"] if t["id"] == "depot-gate")
print(dg)
