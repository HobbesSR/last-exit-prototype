import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegionContext, DecompositionState, allocateCandidates, generatorFitness, buildInterfaces, validateDecompositionPlan, connectedComponents } from '../shared/map/micro/sdk.ts';
import { decompositionExample, planExample, EXAMPLE_GENERATORS } from '../shared/map/micro/decomposition/example.ts';

const grid = (w, h, x = 0, y = 0) => Array.from({ length: w * h }, (_, i) => ({ x: x + i % w, y: y + Math.floor(i / w) }));
const generic = { id: 'generic', roles: ['utility'], tags: ['flexible'], minArea: 1, maxArea: 4096, holes: 'any', utility: a => ({ area: a.area }) };
const policy = { beamWidth: 8, maxPieces: 1, maxCandidates: 32, unusedCellPenalty: 0, residualComponentPenalty: 0, smallResidualPenalty: 0, smallResidualArea: 4, piecePenalty: 0, seamRunPenalty: 0, portalWidth: 2 };
const piece = (id, cells) => ({ id, cells, role: 'utility', rationale: 'test proposal' });

test('contexts cache immutable analysis and child views retain only intersecting constraints', () => {
  const input = { id: 'parent', cells: grid(8, 6), cellSize: 40, reserved: [{ x: 0, y: 0 }], forbidden: [{ x: 7, y: 5 }], required: [{ x: 2, y: 1 }], entrances: [{ id: 'west', cells: [{ x: 0, y: 2 }], requiredWidth: 2 }] };
  const ctx = createRegionContext(input); input.cells[0].x = 99;
  assert.equal(ctx.input.cells[0].x, 0);
  assert.throws(() => { ctx.input.cells[0].x = 99; });
  assert.equal(ctx.analyze(), ctx.analyze([...ctx.input.cells].reverse()));
  assert.throws(() => { ctx.analyze().holes.push([]); });
  const child = ctx.child('child', grid(4, 6));
  assert.deepEqual(child.input.reserved, [{ x: 0, y: 0 }]);
  assert.deepEqual(child.input.forbidden, []);
  assert.equal(child.input.entrances.length, 1);
  assert.throws(() => ctx.child('outside', grid(2, 2, 50)), /leaves/);
});

test('forked claims preserve source state and enforce reserved, forbidden and overlap ownership', () => {
  const ctx = createRegionContext({ id: 'claims', cells: grid(8, 6), cellSize: 40, reserved: grid(1, 6), forbidden: grid(1, 6, 7) });
  const initial = new DecompositionState(ctx), p = { ...piece('left', grid(3, 6, 1)), generator: 'generic', scores: { area: 18 } };
  const left = initial.withClaim(p), right = initial.withClaim({ ...p, id: 'right', cells: grid(3, 6, 4) });
  assert.equal(initial.pieces.length, 0); assert.equal(left.pieces.length, 1); assert.equal(right.pieces.length, 1);
  p.cells[0].x = 200; assert.equal(left.pieces[0].cells[0].x, 1);
  assert.throws(() => left.withClaim({ ...left.pieces[0], id: 'overlap' }));
  assert.throws(() => initial.withClaim({ ...left.pieces[0], cells: grid(2, 2) }));
  assert.deepEqual(left.residuals().map(r => r.role).sort(), ['forbidden', 'reserved', 'residual']);
});

test('generator contracts distinguish hard hole/shape rejection from soft utility and tags', () => {
  const ctx = createRegionContext(decompositionExample('ring')), candidate = piece('ring', ctx.input.cells);
  const room = { ...generic, holes: 'none', rectangular: true };
  assert.equal(generatorFitness(ctx, candidate, generic).feasible, true);
  assert.equal(generatorFitness(ctx, candidate, room).feasible, false);
  assert.equal(generatorFitness(ctx, { ...candidate, requiredTags: ['stairs'] }, generic).feasible, false);
  assert.throws(() => generatorFitness(ctx, candidate, { ...generic, utility: () => ({ broken: NaN }) }), /Nonfinite/);
});

test('residual policy can prefer less coverage with one useful component over spatial confetti', () => {
  const cells = grid(6, 4), ctx = createRegionContext({ id: 'residuals', cells, cellSize: 40 });
  const scattered = cells.filter(c => !(c.y === 3 && c.x % 2 === 1));
  const coherent = cells.filter(c => c.y !== 3);
  assert.equal(connectedComponents(cells.filter(c => !scattered.includes(c))).length, 3);
  const candidates = [piece('A-coverage', scattered), piece('B-residual', coherent)];
  const coverage = allocateCandidates(ctx, candidates, [generic], policy);
  const quality = allocateCandidates(ctx, candidates, [generic], { ...policy, residualComponentPenalty: 3 });
  assert.equal(coverage.pieces[0].id, 'A-coverage'); assert.equal(quality.pieces[0].id, 'B-residual');
  assert.deepEqual(quality, allocateCandidates(ctx, [...candidates].reverse(), [generic], { ...policy, residualComponentPenalty: 3 }));
  assert.deepEqual(validateDecompositionPlan(quality, [generic]), []);
});

test('interfaces coalesce straight contact, preserve fragmented contact and describe portal opportunities', () => {
  const joined = buildInterfaces([{ id: 'a', cells: grid(3, 6) }, { id: 'b', cells: grid(3, 6, 3) }]);
  assert.equal(joined[0].length, 6); assert.equal(joined[0].longestRun, 6); assert.equal(joined[0].runs.length, 1);
  assert.equal(joined[0].portalCandidates.length, 1);
  const fragmented = buildInterfaces([{ id: 'a', cells: grid(3, 6) }, { id: 'b', cells: [{ x: 3, y: 0 }, { x: 3, y: 2 }, { x: 3, y: 4 }] }]);
  assert.equal(fragmented[0].fragmentedRuns, 3); assert.equal(fragmented[0].portalCandidates.length, 0);
});

test('required cells fail explicitly when the bounded candidate set cannot cover them', () => {
  const ctx = createRegionContext({ id: 'required', cells: grid(4, 4), cellSize: 40, required: [{ x: 3, y: 3 }] });
  assert.throws(() => allocateCandidates(ctx, [piece('wrong', grid(2, 2))], [generic], policy), /no plan covering/);
  const result = allocateCandidates(ctx, [piece('right', grid(2, 2, 2, 2))], [generic], policy);
  assert.deepEqual(validateDecompositionPlan(result, [generic]), []);
});

test('example strategy preserves a ring, allocates neck lobes and validates artifact ownership', () => {
  for (const shape of ['neck', 'ring', 'l', 'rectangle']) {
    const plan = planExample(decompositionExample(shape));
    assert.deepEqual(validateDecompositionPlan(plan, EXAMPLE_GENERATORS), [], shape);
    assert.equal(plan.search.optimal, false);
    assert.equal(plan.pieces.reduce((n, p) => n + p.cells.length, 0) + plan.residuals.reduce((n, r) => n + r.cells.length, 0), plan.context.cells.length);
    if (shape === 'ring') assert.equal(plan.pieces[0].generator, 'courtyard-ring');
    if (shape === 'neck') {
      assert.ok(plan.cuts.length > 0); assert.equal(plan.pieces.filter(p => p.role === 'room').length, 2);
      assert.equal(plan.pieces.find(p => p.role === 'corridor')?.cells.length, 12);
      assert.equal(plan.residuals.length, 0, 'compatible connector can be added after higher-scoring rooms regardless of candidate enumeration order');
    }
    const bad = structuredClone(plan); bad.residuals.push({ id: 'fake', cells: [plan.context.cells[0]], role: 'residual' });
    assert.ok(validateDecompositionPlan(bad).length > 0);
    const overlap = structuredClone(plan); overlap.pieces.push({ ...overlap.pieces[0], id: 'duplicate' });
    assert.ok(validateDecompositionPlan(overlap).length > 0);
    const score = structuredClone(plan); score.score += 5; score.scoreComponents.fitness += 5;
    assert.ok(validateDecompositionPlan(score).some(e => /measurements/.test(e)), 'self-consistent forged totals still fail actual accounting');
    const seam = structuredClone(plan);
    if (seam.interfaces.length) { seam.interfaces[0].runs[0].length++; assert.ok(validateDecompositionPlan(seam).some(e => /Interfaces/.test(e))); }
  }
});
