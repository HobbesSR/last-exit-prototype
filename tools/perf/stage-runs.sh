#!/usr/bin/env bash
# Sequential measurement set for #637 (42.22). Outputs land in a fresh directory, test-results/637/ by default,
# and the set stops at the first failed run, so a report never mixes results from different attempts.
cd "$(dirname "$0")/../.." || exit 1
out=${1:-test-results/637}
rm -rf "$out" && mkdir -p "$out" || exit 1
run() {
  local name=$1; shift; echo "=== $name $(date +%T)"
  if ! node tests/bench-stages.mjs "$@" --out="$out/$name.json" > "$out/$name.txt" 2>&1; then
    echo "    FAILED $(date +%T); see $out/$name.txt"; rm -f "$out/$name.json"; exit 1
  fi
  echo "    ok $(date +%T)"
}
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
# 48x24 is the largest point: at 72x36 a recorded frame nearly fills the writer's 8 MiB queue and the process
# heap reaches about 2.5 GiB, which this machine could not hold beside the rest of the set (42.22).
run "ladder-4x4-legacy" --size=12x6 --tile=4x4 --ticks=1200 --content=content-5
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
