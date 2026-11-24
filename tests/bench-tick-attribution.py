# Build a scratch copy with timing hooks; never use its WASM for production.
# Run from the repository root, then build the scratch core with tools/build-core.mjs there.
from pathlib import Path
from shutil import copy2
import subprocess


root = Path('test-results/1283-bench-instrumented').resolve()
files = subprocess.check_output(['git', 'ls-files', '-z'], text=True, encoding='utf-8')
for name in files.split('\0'):
    source = Path(name)
    if not source.is_file():
        continue
    target = root / source
    target.parent.mkdir(parents=True, exist_ok=True)
    copy2(source, target)


def edit(relative, anchor, replacement):
    source = root / relative
    text = source.read_text(encoding='utf-8')
    if text.count(anchor) != 1:
        raise RuntimeError(f'{relative}: expected a single occurrence of {anchor!r}')
    source.write_text(text.replace(anchor, replacement), encoding='utf-8')


mod = 'rust/core/src/tick/mod.rs'
edit(mod,'mod apply;', '''mod apply;

#[link(wasm_import_module = "bench")]
unsafe extern "C" {
    fn tick_measure(id: u32);
}

fn bench_mark(id: u32) {
    unsafe { tick_measure(id) }
}
''')
edit(mod,'''                state
                    .items
                    .iter()
                    .filter_map(|(&id, item)| {
                        let at = item.position(bodies.position(BodyId::Item(id)))?;
                        Some((id, at, *item))
                    })
                    .collect()''','''                bench_mark(0);
                let ground = state
                    .items
                    .iter()
                    .filter_map(|(&id, item)| {
                        let at = item.position(bodies.position(BodyId::Item(id)))?;
                        Some((id, at, *item))
                    })
                    .collect();
                bench_mark(0);
                ground''')
discovery = 'rust/core/src/tick/discovery.rs'
edit(discovery,'            near.extend(ground.iter().filter(|(_, at, _)| within(*at)).copied());','''            super::bench_mark(1);
            near.extend(ground.iter().filter(|(_, at, _)| within(*at)).copied());
            super::bench_mark(1);''')
items = 'rust/core/src/tick/items.rs'
edit(items,'        let items: Vec<_> = view','        super::bench_mark(2);\n        let items: Vec<_> = view')
edit(items,'        for (&actor, record) in &view.start.state.actors {','        super::bench_mark(2);\n        super::bench_mark(3);\n        for (&actor, record) in &view.start.state.actors {')
edit(items,'    }\n\n    pub(super) fn explicit_candidates','        super::bench_mark(3);\n    }\n\n    pub(super) fn explicit_candidates')
edit('shared/core.ts','  const { instance } = await WebAssembly.instantiate(bytes, {});','''  const groups = ['sim.tick.discovery.gather', 'sim.tick.discovery.nearby', 'sim.tick.pickups.build', 'sim.tick.pickups.query'] as const;
  const open = new Set<number>();
  const { instance } = await WebAssembly.instantiate(bytes, { bench: { tick_measure(id: number) {
    if (open.delete(id)) stop(groups[id]!); else { open.add(id); start(groups[id]!); }
  } } });''')
loader = root / 'shared/core.ts'
loader.write_text("import { start, stop } from './profiler.ts';\n" + loader.read_text(encoding='utf-8'), encoding='utf-8')
print(root)
