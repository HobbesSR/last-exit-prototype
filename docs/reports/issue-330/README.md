# Issue #330 historical evidence

These files are byte-for-byte copies of local `test-results/` artifacts inspected on 2026-10-20 for #381. They preserve the original run metadata and are not new measurements. Original local files remain in place. SHA-256 hashes below describe the retained raw bytes.

| Original source path | Retained path | SHA-256 |
| --- | --- | --- |
| `test-results/330-before.md` | `330-before.md` | `46b1c4c1c96d20f036f56ca3bc12690c0acdb5d3b1f3c4bcb77da9e374c40478` |
| `test-results/330-audit.json` | `330-audit.json` | `02c523b6e4d19116dd1bc2b1f1a239d37cf073ad4b5769eb4dfeb1689eea2971` |
| `test-results/330-direct-final.json` | `330-direct-final.json` | `7298fd8d5765e4b42656ef4c9721394d551f2c2cc73f22a6a6e27436802653cd` |
| `test-results/336-hut-timing.json` | `336-hut-timing.json` | `f8268fd045999c70777ed0f650fa8ff92b17042260ea735f4e2c81c719aab573` |
| `test-results/330-measure.mjs` | `330-measure.mjs` | `8e4daced009d38496d943ad9f93b9e091ef6045aa0ac06b182e618399a3d4ed2` |

The hut audit pins the before strategy to `3b54da0` via `git show`; its embedded metadata records working tree hut changes on the current side and current supporting modules. The historical report is evidence of that run, not a clean HEAD comparison. The baseline Markdown and paired fill JSON are retained as its cited inputs. The audit uses `--seeds=20 --maps --diagnose`; see [42.3](../../42.3-generation-and-delegation-evidence.md#hut-yard-to-cover-pilot-330-2026-10-10).

The PR #336 response timing file is a separate historical comparison. Its source and run-order context is described in [42.3](../../42.3-generation-and-delegation-evidence.md#pr-336-review-response-macro-hut-cost-2026-10-11).

The retained `330-measure.mjs` is a historical input dependency, unchanged. Its
relative imports require its original `test-results/` location in a separate
checkout of `3b54da0`; copy it there only if that destination does not exist.
Do not run it from this evidence directory or interpret its hardcoded commit
label as detection of the checked-out revision. No historical harness was run
during retention. The audit after-side working-tree patch is not retained as an
exact source pin, so these artifacts do not promise exact regeneration of that
after output from today's HEAD.
