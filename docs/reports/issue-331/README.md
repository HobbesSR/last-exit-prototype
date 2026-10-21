# Issue #331 historical evidence

These files are byte-for-byte copies of local `test-results/` artifacts inspected on 2026-10-20 for #381. They preserve the original run metadata and are not new measurements. Original local files remain in place. SHA-256 hashes below describe the retained raw bytes.

| Original source path | Retained path | SHA-256 |
| --- | --- | --- |
| `test-results/331-audit/report.json` | `331-audit/report.json` | `7b0149145f864317eb4c97819e234159aa0b806fe182206750f06ae78369bc73` |

The candidate report embeds commit `ff9fd1bbba416870c8aa3f9cc8478a0feb550c7c`, content `types-24`, 20 seeds, and its own limits. It is the pinned before-report input for #338 and #344. Reproducing its original contents requires that source checkout and command `node tools/delegation-adoption-audit.mjs --seeds=20 --maps=1 --out=<directory>`. Its diagnostic previews are local ephemeral illustrations and were not promoted. See [42.3](../../42.3-generation-and-delegation-evidence.md#delegation-adoption-candidate-review-331-2026-10-13).
