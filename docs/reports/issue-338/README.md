# Issue #338 historical evidence

These files are byte-for-byte copies of local `test-results/` artifacts inspected on 2026-10-20 for #381. They preserve the original run metadata and are not new measurements. Original local files remain in place. SHA-256 hashes below describe the retained raw bytes.

| Original source path | Retained path | SHA-256 |
| --- | --- | --- |
| `test-results/338-after/report.json` | `338-after/report.json` | `8f33b45218483f3fd00c67d123fb745a3a227b1a3ea95e983456611ac77fd69f` |
| `test-results/338-baseline-diff.json` | `338-baseline-diff.json` | `170fca2d6d32e87250a8b516d7b92bd8254bd36e5ef864dd47a7e4aee65bf59e` |
| `test-results/338-zero-drift.json` | `338-zero-drift.json` | `8217486c633bf6aeb6881e5919d5aa05aeb0097fb8cc1cf354e115c3577d9111` |

The after report embeds commit `2e89706e3d6a38b353375c8c8dc992acfd792ba4`, `types-25`, 20 seeds, dirty documentation and chain-baseline paths, and the original absolute before-report path. For a non-destructive rerun at that historical source checkout, copy the retained [#331 before report](../issue-331/331-audit/report.json) to a temporary `test-results/331-audit/report.json`, preserving the retained copy and the original local source. Invoke `node tools/compound-delegation-audit.mjs --seeds=20 --maps=1 --out=<new directory>` with a new output directory. The diff records before `93aa5d4` and after `2e89706`; zero-drift JSON records the sweep result. See [42.3](../../42.3-generation-and-delegation-evidence.md#compound-exterior-yard-adoption-338-2026-10-13).

Use a separate checkout at the recorded historical revision for that recipe.
If the destination report already exists, compare it with the retained bytes;
do not overwrite it. Use a new output directory for any new observation.
