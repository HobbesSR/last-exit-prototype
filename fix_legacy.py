with open("src/core.ts", "r", encoding="utf-8") as f:
    code = f.read()

# Replace the first occurrence of cellConstraints (which is in legacy)
first = code.find('constraints: encodeGrid(cellConstraints),')
if first != -1:
    code = code[:first] + 'constraints: encodeGrid(new Array(composition.width * composition.height).fill("any")),' + code[first+41:]

with open("src/core.ts", "w", encoding="utf-8") as f:
    f.write(code)
print("done")
