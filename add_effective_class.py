with open("src/macro.ts", "r", encoding="utf-8") as f:
    code = f.read()

# Let's replace the return map in composeMacro.
start_idx = code.find('const map: MacroComposition = {')
if start_idx != -1:
    end_idx = code.find('};\n', start_idx) + 3
    map_code = code[start_idx:end_idx]
    
    # We will compute effective cell class right before building map
    effective_code = """  const effectiveCellClass = [...cellClass];
  for (let i = 0; i < effectiveCellClass.length; i++) {
    if (effectiveCellClass[i] === "any") {
      effectiveCellClass[i] = "open";
    }
  }

  """
    
    # We should return cellClass as effectiveCellClass, or add effectiveCellClass to the return type?
    # Actually, the easiest way to make the rest of the engine (regions, renderer, micro) use the effective cell class
    # is to just assign it to `cellClass`. But the user said:
    # "keep cells, as placed, and the 'effective' cell type features as an overlay so we make sure we are using properties from the right layer at the right time."
    # If we add it as `effectiveCellClass`, we need to update `MacroComposition` in `macro-types.ts`.
else:
    print("FAILED")
