# #849 adoption comparison (42.37)

Retained data behind [42.37](../../42.37-matched-adoption.md). Definitions are
[51.10](../../51.10-measurement.md)'s and [42.34](../../42.34-edge-clearance.md)'s.

| File | What |
| --- | --- |
| `before-{12,24,36}.json` | `map/tools/library-comparison.mts` (`library-comparison-1`) on `size-W-{1,2,3}` with `main`'s libraries at `0a917ba` (`common-primitives@5`, default passability rules) |
| `after-{12,24,36}.json` | The same with the bundled matched libraries (`common-primitives@6`, `types-64`) |
| `edge-before.json.gz`, `edge-after.json.gz` | `map/tools/edge-clearance.mts --seeds 1,2,3 --maps DIR` (`edge-clearance-1`) over the same eighteen maps |

Each map row carries its seed, a sha256 of its wire JSON (`digest`), the library fingerprint,
macro counts, fill slots by design and both bodies' long across-map detour and dead-end area.
`--macro` stops at the briefs, for the structural columns alone (`stages: "macro"`, no
`bodies`); these files are full builds (`stages` absent: they predate the option). Generation
`seconds` in these files ran beside other work; 42.37's cost table is the quiet
bench-locked run.

## Provenance

- **before:** `library` names a scratch copy of `main`'s top-level files at `0a917ba` beside the
  `@5`/`@4` modules, which are unchanged in the repository. To reproduce, copy
  `git show 0a917ba:map/macro/content/diamond-WxH.json` beside `common-primitives@5.json`,
  `common-set-pieces@5.json` and `district-set-pieces@4.json`, and pass it as `--library`.
- **after:** generated from a tree whose chain inputs equal commit `2fb96f9` (the adoption, with
  the open-face cut fix `4e2ff66`). `revision` records `HEAD` when each file was written.

```sh
node map/tools/library-comparison.mts --widths 36 --seeds 1,2,3 --save DIR --out after-36.json
node map/tools/library-comparison.mts --widths 36 --seeds 1,2,3 --library BEFORE/diamond-36x18.json --out before-36.json
node map/tools/edge-clearance.mts --seeds 1,2,3 --maps DIR --out edge-after.json
```
