"""Optional visual QA of recorded #451 native springs (requires matplotlib)."""
import gzip
import json
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Circle

source, destination = map(Path, sys.argv[1:3])
data = source.read_bytes()
report = json.loads(gzip.decompress(data) if source.suffix == ".gz" else data)
rows = report["node"]["rapier"]["correctness"]
names = ["spring-decay", "native-spring-stiff-2000", "native-spring-stiff-20000"]
fig, axes = plt.subplots(2, 3, figsize=(12, 6.5), layout="constrained")
for column, (name, stiffness) in enumerate(zip(names, [20, 2000, 20000])):
    axis = axes[0, column]
    for steps in [2, 4, 8]:
        row = next(r for r in rows if r["scenario"] == name and r["substeps"] == steps)
        trace = row["springTrace"]
        times = [0] + [frame["tick"] * 0.05 for frame in trace]
        stretch = [15] + [abs(frame["bodies"][1]["x"] - frame["bodies"][0]["x"]) - 60 for frame in trace]
        axis.plot(times, stretch, label=f"{steps} substeps", linewidth=1.6)
    axis.axvline(3, color="#777777", linestyle=":")
    axis.axhspan(-0.5, 0.5, color="#30a070", alpha=0.15)
    axis.set(title=f"Stiffness {stiffness:,}", xlabel="Seconds", ylabel="Signed extension (world units)", ylim=(-3, 16))
    axis.legend(fontsize=8)
    axis.grid(alpha=0.15)
    axis = axes[1, column]
    trace = next(r for r in rows if r["scenario"] == name and r["substeps"] == 4)["springTrace"]
    for line, tick in enumerate([1, 3, 10, 60]):
        frame = next(f for f in trace if f["tick"] == tick)
        a, b = frame["bodies"]
        y = 3 - line
        axis.plot([a["x"], b["x"]], [y, y], color="#9aa6b2", linewidth=2)
        for body in [a, b]:
            axis.add_patch(Circle((body["x"], y), 0.15, color="#276bc2", transform=axis.transData))
            axis.plot(body["x"], y, "o", color="#276bc2", markersize=10)
        axis.text(84, y, f"{tick * 0.05:.2f} s", va="center", fontsize=9)
    axis.set(xlim=(-5, 100), ylim=(-0.6, 3.6), title="Recorded poses, 4 substeps", xlabel="World x")
    axis.set_yticks([])
    axis.spines[["left", "right", "top"]].set_visible(False)
fig.suptitle("Native centre springs: recorded settling, not a jelly/squish feel test", fontsize=14)
destination.parent.mkdir(parents=True, exist_ok=True)
fig.savefig(destination, dpi=140)
