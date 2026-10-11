import test from 'node:test';
import assert from 'node:assert/strict';
import { executeDelegation, executionLeaves, flattenDelegationResult } from '../map/micro/delegation-execute.ts';
import { validateBriefPartition } from '../map/micro/delegation.ts';

const cells = (x, y, w, h) => Array.from({ length: w * h }, (_, i) => ({ x: x + i % w, y: y + Math.floor(i / w) }));
const brief = (owned = cells(0, 0, 12, 6), extra = {}) => ({ id: 'root', seed: 91, type: 'parent', cellSize: 40,
  cells: owned, zones: [{ tier: 1, bonus: 0, lootChance: 0, cells: owned }], portals: [], ...extra });
const offer = (key, owned, type = 'child') => ({ key, cells: owned, type, reasonTags: ['spare'] });
const built = (input, label = input.type) => ({ version: 'region-2', brief: input,
  elements: [{ label, x: 0, y: 0, template: { parts: [] } }],
  coreElements: [], loot: [{ x: 0, y: 0, tier: 1 }],
  manifest: { cells: input.cells.length, structures: 1, obstacles: 0, gates: 0, loot: 1, coreElements: 0, attempted: 2 } });
const entry = (build, receiving) => ({ version: 'test-1', build, ...(receiving ? { receiving } : {}) });

test('executes prepared children and flattens original ownership, labels and additive counts', () => {
  const observed = [];
  const registry = {
    parent: entry((input, context, observe) => {
      const dispatched = context.delegate([offer('east', cells(10, 0, 2, 6)), offer('west', cells(0, 0, 2, 6))]);
      assert.deepEqual(dispatched.prepared.children.map(c => c.key), ['east', 'west']);
      assert.deepEqual(context.brief, dispatched.prepared.retained);
      observe?.({ label: 'parent', origin: { x: 0, y: 0 }, cellSize: 40, design: {}, allocation: {}, realization: {} });
      return built(context.brief, 'parent');
    }),
    child: entry((input, _context, observe) => {
      observe?.({ label: 'child', origin: { x: 0, y: 0 }, cellSize: 40, design: {}, allocation: {}, realization: {} });
      return built(input, 'child');
    }),
  };
  const root = executeDelegation(brief(), registry, { observe: e => observed.push(e.label) });
  assert.equal(root.version, 'builder-delegation-1');
  assert.equal(root.maxDepth, 3);
  assert.deepEqual(root.registryVersions, { parent: 'test-1', child: 'test-1' });
  assert.deepEqual(root.children.map(c => c.input.id), root.preparation.children.map(c => c.brief.id));
  assert.deepEqual(validateBriefPartition(root.input, executionLeaves(root).map(r => r.brief)), []);
  const flat = flattenDelegationResult(root);
  assert.deepEqual(flat.brief, root.input);
  assert.equal(flat.manifest.cells, root.input.cells.length);
  assert.equal(flat.manifest.structures, 3);
  assert.equal(flat.manifest.loot, 3);
  assert.equal(flat.manifest.attempted, 6);
  assert.deepEqual(flat.elements.map(e => e.label), ['parent', `${root.children[0].input.id}/child`, `${root.children[1].input.id}/child`]);
  assert.deepEqual(observed, flat.elements.map(e => e.label));
});

test('depth bounds 0, 1 and 3 stop further patch content without resetting on nested dispatch', () => {
  const visits = [];
  const registry = {
    parent: entry((input, context) => { context.delegate([offer('edge', cells(8, 0, 16, 6))]); return built(context.brief); }),
    child: entry((input, context) => {
      visits.push({ id: input.id, depthWidth: new Set(input.cells.map(c => c.x)).size });
      const maxX = Math.max(...input.cells.map(c => c.x));
      const width = new Set(input.cells.map(c => c.x)).size;
      if (width >= 4) context.delegate([offer('next', input.cells.filter(c => c.x >= maxX - width / 2 + 1))]);
      return built(context.brief);
    }),
  };
  for (const [maxDepth, expectedWidths] of [[0, []], [1, [16]], [3, [16, 8, 4]]]) {
    visits.length = 0;
    const result = executeDelegation(brief(cells(0, 0, 24, 6)), registry, { maxDepth });
    assert.deepEqual(visits.map(v => v.depthWidth), expectedWidths);
    assert.deepEqual(validateBriefPartition(result.input, executionLeaves(result).map(r => r.brief)), []);
    if (maxDepth === 0) assert.equal(result.children[0].fallbackReason, 'depth-limit');
    if (maxDepth === 1) assert.equal(result.children[0].children[0].fallbackReason, 'depth-limit');
    if (maxDepth === 3) {
      const depth1 = result.children[0], depth2 = depth1.children[0], depth3 = depth2.children[0], depth4 = depth3.children[0];
      assert.deepEqual([depth1.depth, depth2.depth, depth3.depth, depth4.depth], [1, 2, 3, 4]);
      assert.deepEqual([depth1.input.cells.length, depth2.input.cells.length, depth3.input.cells.length, depth4.input.cells.length], [96, 48, 24, 12]);
      assert.equal(depth4.actualBuilder, 'empty');
      assert.equal(depth4.fallbackReason, 'depth-limit');
      assert.equal(depth3.actualBuilder, 'child');
    }
  }
});

test('receiver refusal retains proper-subset cells; terminal empty bypasses receiver and is built in', () => {
  let receivingCalls = 0;
  const registry = {
    parent: entry((_input, context) => { context.delegate([offer('awkward', cells(10, 0, 2, 6))]); return built(context.brief); }),
    child: entry(input => built(input), () => { receivingCalls++; return 'requires a courtyard'; }),
    empty: entry(() => { throw Error('registry must not override empty'); }),
  };
  const refused = executeDelegation(brief(), registry);
  assert.deepEqual(refused.preparation.rejected, [{ key: 'awkward', reason: 'Receiving builder for awkward: requires a courtyard' }]);
  assert.equal(refused.children.length, 0);
  assert.equal(receivingCalls, 1);
  const terminal = executeDelegation(brief(), registry, { maxDepth: 0 });
  assert.equal(terminal.children[0].actualBuilder, 'empty');
  assert.equal(terminal.children[0].requestedBuilder, 'child');
  assert.equal(terminal.children[0].retained.elements.length, 0);
  assert.equal(receivingCalls, 1);
});

test('whole-region empty handoff discards prior child output and observer events while keeping attempt history', () => {
  const observed = [];
  const registry = {
    parent: entry((input, context, observe) => {
      observe?.({ label: 'abandoned', origin: { x: 0, y: 0 }, cellSize: 40, design: {}, allocation: {}, realization: {} });
      context.delegate([offer('patch', cells(10, 0, 2, 6))]);
      context.empty('incompatible core');
    }),
    child: entry(input => built(input)),
  };
  const result = executeDelegation(brief(undefined, { coreElements: { spawn: 1 } }), registry, { observe: e => observed.push(e) });
  assert.equal(result.fallbackReason, 'incompatible core');
  assert.deepEqual(result.retained.brief.coreElements, { spawn: 1 });
  assert.equal(result.children.length, 1);
  assert.equal(executionLeaves(result).length, 1);
  assert.deepEqual(flattenDelegationResult(result).elements, []);
  assert.deepEqual(observed, []);
});

test('complete offers permit only empty, malformed offers throw and one batch is enforced', () => {
  const content = { parent: entry((input, context) => {
    const dispatch = context.delegate([offer('all', input.cells, 'child')]);
    assert.match(dispatch.prepared.rejected[0].reason, /Complete-region/);
    assert.equal(dispatch.children.length, 0);
    return built(context.brief);
  }), child: entry(input => built(input)) };
  assert.equal(executeDelegation(brief(), content).retained.elements.length, 1);
  const empty = { parent: entry((input, context) => { context.delegate([offer('all', input.cells, 'empty')]); throw Error('unreachable'); }) };
  assert.equal(executeDelegation(brief(), empty).fallbackReason, 'complete-region');
  const malformed = { parent: entry((input, context) => { context.delegate([offer('bad', [...input.cells, input.cells[0]])]); return built(input); }) };
  assert.throws(() => executeDelegation(brief(), malformed), /Duplicate|disjoint/);
  const repeated = { parent: entry((input, context) => { context.delegate([]); context.delegate([]); return built(input); }) };
  assert.throws(() => executeDelegation(brief(), repeated), /one patch batch/);
});

test('equivalent reordered input gives identical execution and child cannot alter parent interface', () => {
  const patches = [offer('west', cells(0, 0, 2, 6)), offer('east', cells(10, 0, 2, 6))];
  const registry = (reverse) => ({
    parent: entry((_input, context) => {
      const dispatch = context.delegate(reverse ? [...patches].reverse().map(p => ({ ...p, cells: [...p.cells].reverse() })) : patches);
      dispatch.prepared.retained.portals.length = 0;
      dispatch.children[0].input.cells.length = 0;
      return built(context.brief);
    }),
    child: entry(input => built(input)),
  });
  const original = brief();
  const reordered = { ...original, cells: [...original.cells].reverse(), zones: [{ ...original.zones[0], cells: [...original.cells].reverse() }] };
  const a = executeDelegation(original, registry(false));
  const b = executeDelegation(reordered, registry(true));
  assert.deepEqual(a, b);
  assert.deepEqual(validateBriefPartition(a.input, executionLeaves(a).map(r => r.brief)), []);
});

test('child generation depends only on its interface across different parent build histories', () => {
  const run = parentLabel => executeDelegation(brief(), {
    parent: entry((input, context, observe) => {
      if (parentLabel === 'early') observe?.({ label: 'early', origin: { x: 0, y: 0 }, cellSize: 40, design: {}, allocation: {}, realization: {} });
      context.delegate([offer('edge', cells(10, 0, 2, 6))]);
      if (parentLabel === 'late') observe?.({ label: 'late', origin: { x: 0, y: 0 }, cellSize: 40, design: {}, allocation: {}, realization: {} });
      return built(context.brief, parentLabel);
    }),
    child: entry(input => built(input, 'stable-child')),
  });
  const early = run('early'), late = run('late');
  assert.notDeepEqual(early.retained.elements, late.retained.elements);
  assert.notDeepEqual(early.observerEvents, late.observerEvents);
  assert.deepEqual(early.children, late.children);
  assert.deepEqual(early.children[0].input, early.preparation.children[0].brief);
});

test('connected irregular whole-cell patch dispatches to built-in empty with its interface intact', () => {
  const irregular = [...cells(10, 0, 2, 6), ...cells(8, 0, 2, 1)];
  const result = executeDelegation(brief(), {
    parent: entry((_input, context) => { context.delegate([offer('awkward', irregular, 'empty')]); return built(context.brief); }),
    empty: entry(() => { throw Error('built-in empty cannot be overridden'); }),
  });
  assert.equal(result.preparation.rejected.length, 0);
  assert.equal(result.children.length, 1);
  assert.equal(result.children[0].actualBuilder, 'empty');
  assert.equal(result.children[0].fallbackReason, 'explicit-empty');
  assert.deepEqual(result.children[0].input.cells, irregular.sort((a, b) => a.y - b.y || a.x - b.x));
  assert.equal(result.children[0].retained.elements.length, 0);
  assert.deepEqual(result.children[0].retained.brief, result.children[0].input);
  assert.deepEqual(validateBriefPartition(result.input, executionLeaves(result).map(r => r.brief)), []);
});
