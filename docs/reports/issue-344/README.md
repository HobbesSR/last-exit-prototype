# Issue #344 historical evidence

These files are byte-for-byte copies of local `test-results/` artifacts inspected on 2026-10-20 for #381. They preserve the original run metadata and are not new measurements. Original local files remain in place. SHA-256 hashes below describe the retained raw bytes.

| Original source path | Retained path | SHA-256 |
| --- | --- | --- |
| `test-results/344-audit/report.json` | `344-audit/report.json` | `4ab7f1251a664611a73a37f864940034687efc386c71583b44e565d27192b89a` |
| `test-results/344-audit-summary.json` | `344-audit-summary.json` | `61fd44fe760e2570bb9f9fa6bbcc84f33aab28e935edb0046c49a583d03f8dfb` |
| `test-results/344-timing.json` | `344-timing.json` | `f1d3dc6fc47c4d701a97f4119cb1f453c43e1a7f77428d7d36ad8ee963dd81a8` |

The audit report embeds commit `bd951675723bc5991e0f7a44ed6d4ce2ecd3a798`, `types-25`, 20 seeds, a dirty documentation path, and the original absolute #331 before-report path. Its timing JSON separately records before `4a7a5ba`, after `0a8e3aa8276125a6a810335c253ae4b769839255`, a clean tracked tree, and Node v24.15.0. The summary file is retained in its original UTF-16 encoding. For a non-destructive audit rerun at the recorded source checkout, copy the retained [#331 before report](../issue-331/331-audit/report.json) to a temporary `test-results/331-audit/report.json`, preserving the retained copy and original local source; use a new audit output directory. See [42.3](../../42.3-generation-and-delegation-evidence.md#cheaper-incompatible-crossing-preparation-344-2026-10-13).

Use a separate checkout at the recorded historical revision for that recipe.
If the destination report already exists, compare it with the retained bytes;
do not overwrite it. Use a new output directory for any new observation.
