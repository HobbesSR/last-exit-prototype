#!/usr/bin/env bash
# Sequential measurement set for #637. Outputs land in test-results/637/.
cd "$(dirname "$0")/../.." || exit 1
out=test-results/637; mkdir -p "$out"
run() { local name=$1; shift; echo "=== $name $(date +%T)"; node tests/bench-stages.mjs "$@" --out="$out/$name.json" > "$out/$name.txt" 2>&1; echo "    exit $? $(date +%T)"; }
# A/B: real sizes, whole match, one viewer, recording on.
for size in 12x6 24x12 36x18; do
  run "real-$size-legacy" --size=$size --content=content-5
  for r in 1 2 3; do run "real-$size-physics-r$r" --size=$size --content=content-6; done
done
# C: constant-density ladder from the 12x6 map, first 1200 ticks.
for tile in 1x1 2x1 2x2 3x2 3x3; do
  run "ladder-$tile-legacy" --size=12x6 --tile=$tile --ticks=1200 --content=content-5
  run "ladder-$tile-physics" --size=12x6 --tile=$tile --ticks=1200 --content=content-6
done
for tile in 4x4 6x6; do run "ladder-$tile-legacy" --size=12x6 --tile=$tile --ticks=1200 --content=content-5; done
# Real sizes over the same first 1200 ticks, to set against the ladder.
for size in 24x12 36x18; do
  run "early-$size-legacy" --size=$size --ticks=1200 --content=content-5
  run "early-$size-physics" --size=$size --ticks=1200 --content=content-6
done
# D: viewers and rooms.
for c in 4 8; do run "views-36x18-c$c" --size=36x18 --ticks=1200 --clients=$c --spectators=2 --content=content-6; done
run "views-12x6-c8" --size=12x6 --clients=8 --spectators=2 --content=content-6
run "rooms-12x6-r4" --size=12x6 --rooms=4 --clients=8 --spectators=2 --content=content-6
run "rooms-24x12-r2" --size=24x12 --rooms=2 --clients=8 --spectators=2 --ticks=3000 --content=content-6
echo "=== done $(date +%T)"
