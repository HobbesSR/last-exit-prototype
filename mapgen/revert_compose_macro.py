with open("src/macro.ts", "r", encoding="utf-8") as f:
    code = f.read()

start_idx = code.find('// Post-process: Adapt "any" cells on tile boundaries.')
end_idx = code.find('for (let i = 0; i < cellClass.length; i++)\n    cellSolid[i] = false;')

if start_idx != -1 and end_idx != -1:
    code = code[:start_idx] + code[end_idx:]
    with open("src/macro.ts", "w", encoding="utf-8") as f:
        f.write(code)
    print("REVERTED")
else:
    print("FAILED TO FIND")
