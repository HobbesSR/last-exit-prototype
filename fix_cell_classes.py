import json
for file in ["content/default-library.json", "content/default-library.backup.json"]:
    with open(file, "r", encoding="utf-8") as f:
        data = json.load(f)
    
    classes = data.get("cellClasses", {})
    for c in ["tree", "rock", "rubble", "hut"]:
        if c not in classes:
            classes[c] = { "generator": "open-field", "clutterChance": 0.0, "clutterSize": 0.0 }
    data["cellClasses"] = classes

    for t in data["tiles"]:
        if t["id"] in ["open-hut-edge", "open-hut-corner"]:
            if "eligibleTiers" not in t:
                t["eligibleTiers"] = [1,2,3,4,5]

    with open(file, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)

print("fixed cell classes")
