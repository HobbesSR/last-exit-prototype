# Connected static-barrier experiment (#694, under #529)

This is separate, opt-in lab geometry, never a registered builder, saved live
content version, library prescription or growth helper. The three original full
maps and original measurement files in [issue-688](../issue-688/README.md) remain
the inputs. `manifest.json` pins their exact uncompressed hashes, dependency and
normalized LF source hashes, Node version and output hashes. The base source
revision is the merged #693 checkpoint; the additional experiment modules are
pinned by their hashes. Results and the decision belong to [42.24](../../42.24-static-barrier.md).
The generated preview is retained with LF endings for its byte digest; blank
SVG interpolation lines are part of that generated artifact.

Run from the repository root:

```powershell
node tools/static-barrier-experiment.mjs --out=test-results/my-static-barrier
node tools/static-barrier-experiment.mjs --out=docs/reports/issue-694 --verify
```

The first command refuses to replace an existing manifest. Verification checks
source/input pins and recomputes all three owner validations, exact matched routes,
structure measures and preview without rewriting retained evidence. It compares
deterministic raw-report and preview hashes; elapsed times are observations and
are not equality assertions. The script takes the shared benchmark lock and runs
each map and phase sequentially. Do not run other tests/benchmarks alongside it.
The retained capture received independent source/input/report/preview digest,
exact patch-reconstruction and endpoint-identity checks (`artifact-verification.json`);
the full second analysis under `--verify` was not rerun. `preview-qa.json` records
the installed Chrome version, viewport, body selection and page-error check;
all six resulting panels were visually inspected.

Open [index.html](index.html) in a browser for before/after previews with a body
selector, routes, original owner mask, promised portals and failed loot sites.
This is a geometry diagram, not game art or simulated exploration. Both bodies'
full route polylines/statuses/endpoints, exact added element, siting refusals,
independent SDK hunter access and thorough portal joins, complete-map reports
and after structure report are in `size-{12,24,36}.json.gz`. `summary.json` retains
the matched distributions and denominators. `timing.json` records construction,
final proof, complete-map reports and analysis separately, with machine/runtime metadata.

## Experiment definition and limits

One five-part connected bottle wall has a 14×14-cell outer box, one-cell walls,
and a single east-facing 2.5-cell mouth. Flush pieces form one continuous front;
there is no clearance ring between them. It is an interior seed, not necessarily
attached to the owner boundary. Siting tries the saved maps' large park owners
first, then plant/hall/ruins owners in saved order; each owner exposes at most the
first 256 row-major fitting rectangles, with at most 2,048 candidates considered
in total. Rectangle enumeration itself uses the existing mask API over these
fixed pinned inputs. This is not a capacity claim for arbitrary masks. An
18×18-cell envelope must fit original ownership and avoid existing colliders;
the actual wall must fit reduced fill and preserve core sites. There is one final
thorough owner proof per selected site, no prospective proof loop or cord growth.
An unsupported placement/refused final proof stops explicitly.

The nine `barrier-target` routes go from west of the wall to three depths and
three offsets inside the pocket. Three `barrier-crossing` routes pass from west
to east outside the pocket. Three `mouth-control` routes approach through its
opening. These are intentionally selected geometric witnesses, not random traffic
or evidence that gameplay sends players into the pocket. Every retained loot
candidate within one cell of its outer box is also queried from the same fixed
east approach (`retained-local-loot`), without filtering blocked endpoints.

All original #688 gameplay and across-map endpoints are retained separately by
body and distance stratum. Fixed pairs are searched on the whole-map mesh in
**both** conditions, even when they share an owner; this permits real outside
bypasses. #688's within-region routes use a different domain and are excluded
from matched comparisons. No endpoint is chosen or replaced from the after map.
The after report's independently sampled routes are descriptive only.

Navigation uses the same live-body clearances/endpoint and swept-lead rules as
51.10. The independent SDK portal and pocket-access witness uses its larger
0.925-cell hunter radius. A successful mesh path is not a shortest-path
certificate, and a miss is not proof of physical impossibility. Dead-end area,
empty-space and physical boundary estimates keep the exact #688 definitions.

Validation is scoped to changed geometry: the affected owner's final fill and
thorough portal proof plus independent full-radius SDK hunter pocket access.
Complete maps also run composition, macro proof/core reports and the fixed
gameplay/map-scale routes. Unchanged owners are not all diagnosed again. An
initial broad `checkMap(...,{diagnose:true})` capture was stopped while processing
the largest map after prolonged work on unchanged geometry; it produced no
failure verdict and is not part of this retained evidence. The narrower scope
does not imply whole-map exhaustive connectivity or pickup access.

All original geometry, briefs, loot and core sites remain exact. Consequently a
post-siting wall overlay can block original loot: those failures are intentional
negative evidence about this experiment's integration suitability. A passed
portal diagnostic does not certify pickup access. Do not publish these overlays
as ordinary `types-55` maps or silently remove/re-roll blocked targets. Any
production composition needs separately scoped authorship, target siting,
content-version and expectation review under 31/53.
