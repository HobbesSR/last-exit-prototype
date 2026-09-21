import json

with open("content/default-library.json", "r", encoding="utf-8") as f:
    lib = json.load(f)

# Save backup
with open("content/default-library.backup.json", "w", encoding="utf-8") as f:
    json.dump(lib, f, indent=2)

def resolve_cell(tile, x, y):
    legend = tile.get("legend", {})
    default = tile.get("defaultCellClass", "open")
    cells = tile.get("cells")
    if cells and y < len(cells) and x < len(cells[y]):
        char = cells[y][x]
        if char == '.': return default
        return legend.get(char, default)
    return default

for tile in lib["tiles"]:
    if tile.get("defaultCellClass") == "any":
        continue
    
    # We will derive edges based on the perimeter cells.
    # N: y=0, x=0..5
    # S: y=5, x=0..5
    # E: x=5, y=0..5
    # W: x=0, y=0..5
    
    edges = {"N": [], "S": [], "E": [], "W": []}
    
    for x in range(6):
        c = resolve_cell(tile, x, 0)
        edges["N"].append(c if c not in ["open", "any", "hut"] else "any")
        
        c = resolve_cell(tile, x, 5)
        edges["S"].append(c if c not in ["open", "any", "hut"] else "any")
        
    for y in range(6):
        c = resolve_cell(tile, 5, y)
        edges["E"].append(c if c not in ["open", "any", "hut"] else "any")
        
        c = resolve_cell(tile, 0, y)
        edges["W"].append(c if c not in ["open", "any", "hut"] else "any")
        
    # Check if we should even add it (if all are 'any', skip)
    has_constraint = False
    for arr in edges.values():
        for val in arr:
            if val != "any":
                has_constraint = True
                break
                
    if has_constraint:
        tile["edges"] = edges
    elif "edges" in tile:
        del tile["edges"]

with open("content/default-library.json", "w", encoding="utf-8") as f:
    json.dump(lib, f, indent=2)
print("edges derived")
