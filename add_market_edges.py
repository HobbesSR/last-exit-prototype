import json

with open("content/default-library.backup.json", "r", encoding="utf-8") as f:
    lib = json.load(f)

for t in lib["tiles"]:
    if t["id"] == "market-front":
        # Add edges!
        t["edges"] = {
            "S": ["market", "market", "market", "market", "market", "market"]
        }

with open("content/default-library.json", "w", encoding="utf-8") as f:
    json.dump(lib, f, indent=2)
print("added edges to market-front")
