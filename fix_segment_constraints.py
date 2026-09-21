with open("src/core.ts", "r", encoding="utf-8") as f:
    code = f.read()

# Replace the wrong formulas with correct ones.
old_loop = """      for (let i = 0; i < p.tileSize; i++) {
        if (N[i] !== "any") {
          const cx = t.x + i; const cy = t.y - 1;
          if (cy >= 0) cellConstraints[cy * W + cx] = N[i];
          const segIdx = t.y * (W + 1) + cx; // horizontal segment above the tile cell i
          segmentConstraints[segIdx] = N[i];
        }
        if (S[i] !== "any") {
          const cx = t.x + i; const cy = t.y + p.tileSize;
          if (cy < H) cellConstraints[cy * W + cx] = S[i];
          const segIdx = (t.y + p.tileSize) * (W + 1) + cx; // horizontal segment below the tile cell i
          segmentConstraints[segIdx] = S[i];
        }
        if (E[i] !== "any") {
          const cx = t.x + p.tileSize; const cy = t.y + i;
          if (cx < W) cellConstraints[cy * W + cx] = E[i];
          const vOffset = (W + 1) * H;
          const segIdx = vOffset + (t.y + i) * W + (t.x + p.tileSize); // vertical segment right of the tile cell i
          segmentConstraints[segIdx] = E[i];
        }
        if (W_edge[i] !== "any") {
          const cx = t.x - 1; const cy = t.y + i;
          if (cx >= 0) cellConstraints[cy * W + cx] = W_edge[i];
          const vOffset = (W + 1) * H;
          const segIdx = vOffset + (t.y + i) * W + t.x; // vertical segment left of the tile cell i
          segmentConstraints[segIdx] = W_edge[i];
        }
      }"""

new_loop = """      for (let i = 0; i < p.tileSize; i++) {
        const vOffset = (W + 1) * H;
        if (N[i] !== "any") {
          const cx = t.x + i; const cy = t.y - 1;
          if (cy >= 0) cellConstraints[cy * W + cx] = N[i];
          const segIdx = vOffset + t.y * W + cx; // horizontal: verticalCount + line(y) * width + offset(x)
          segmentConstraints[segIdx] = N[i];
        }
        if (S[i] !== "any") {
          const cx = t.x + i; const cy = t.y + p.tileSize;
          if (cy < H) cellConstraints[cy * W + cx] = S[i];
          const segIdx = vOffset + (t.y + p.tileSize) * W + cx;
          segmentConstraints[segIdx] = S[i];
        }
        if (E[i] !== "any") {
          const cx = t.x + p.tileSize; const cy = t.y + i;
          if (cx < W) cellConstraints[cy * W + cx] = E[i];
          const segIdx = (t.y + i) * (W + 1) + (t.x + p.tileSize); // vertical: offset(y) * (width + 1) + line(x)
          segmentConstraints[segIdx] = E[i];
        }
        if (W_edge[i] !== "any") {
          const cx = t.x - 1; const cy = t.y + i;
          if (cx >= 0) cellConstraints[cy * W + cx] = W_edge[i];
          const segIdx = (t.y + i) * (W + 1) + t.x;
          segmentConstraints[segIdx] = W_edge[i];
        }
      }"""

code = code.replace(old_loop, new_loop)

with open("src/core.ts", "w", encoding="utf-8") as f:
    f.write(code)

print("done")
