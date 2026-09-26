with open("src/core.ts", "r", encoding="utf-8") as f:
    core = f.read()

core = core.replace("""
  map!.edges = deriveEdges(map!);
  map!.walls = deriveWalls(map!);
  break; 

  }
  
  if (!map) throw new Error("V2 Rejection sampling failed to find a walkable placement.");
""", """
    map!.edges = deriveEdges(map!);
    map!.walls = deriveWalls(map!);
    break; 
    } catch (e) {
      // console.warn("Attempt", attempt, "failed:", e);
    }
  }
  
  if (!map) throw new Error("V2 Rejection sampling failed to find a walkable placement.");
""")

with open("src/core.ts", "w", encoding="utf-8") as f:
    f.write(core)
