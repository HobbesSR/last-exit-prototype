#!/usr/bin/env node
/** Read-only #347 diagnosis: do the 36x18 library's local `city-centre` block grounds and
 * `industrial-quarter` depot grounds lose their fills to #340-style internal seams?
 * Evidence for the #347 record in docs 42, not maintained tooling.
 *
 * node tools/local-quarter-fill-audit.mjs [--seeds=N] [--want=K] [--out=test-results/347-audit]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { bundledLibrary, chainParams } from '../map/chain.ts';
import { libraryFingerprint } from '../map/macro/src/coding.ts';
import { placement } from '../map/macro/src/chain/placement.ts';
import { mapViews } from '../map/macro/src/chain/map.ts';
import { buildRegion, REGION_TYPES_VERSION } from '../map/micro/region-types.ts';
import { createFillMask, elementShapes } from '../map/micro/geometry.ts';
import { validatePortalReach } from '../map/micro/portals.ts';
import { validateFillConstraints } from '../map/micro/margins.ts';
import { largestRectangle } from '../map/micro/strategies/hall.ts';
import { planBlock } from '../map/micro/strategies/block.ts';

const args = new Map(process.argv.slice(2).map(arg => {
  const match = /^--(out|seeds|want)=(.+)$/.exec(arg);
  if (!match) throw new Error('Use [--seeds=40] [--want=5] [--out=test-results/347-audit]');
  return [match[1], match[2]];
}));
const out = resolve(args.get('out') ?? 'test-results/347-audit');
const maxSeeds = Number(args.get('seeds') ?? 40), want = Number(args.get('want') ?? 5);
const params = chainParams({ mode: 'game', zoneWidth: 36, zoneHeight: 18 }), library = bundledLibrary(params);
const PIECES = { 'city-centre': 'block', 'industrial-quarter': 'depot' };
/** Contained fill minimums from 54's shape needs; cover and ruins have none on the fill. */
const FILL_MIN = { depot: 10, compound: 10, hut: 4 };
const SLOT = 6, key = c => `${c.x},${c.y}`;

function maximumSquare(cells) {
  const dp = new Map();
  let best = 0;
  for (const c of [...cells].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const side = 1 + Math.min(dp.get(`${c.x - 1},${c.y}`) ?? 0, dp.get(`${c.x},${c.y - 1}`) ?? 0, dp.get(`${c.x - 1},${c.y - 1}`) ?? 0);
    dp.set(key(c), side);
    best = Math.max(best, side);
  }
  return best;
}

function fillFacts(brief) {
  const fill = createFillMask(brief), need = FILL_MIN[brief.type] ?? 1;
  return { cells: brief.cells.length, fill: fill.cells.length, internalRuns: (brief.internalGuaranteed ?? []).length,
    maxFillSquare: maximumSquare(fill.cells), need, meetsMinimum: !!largestRectangle(fill, need) };
}

const counts = Object.fromEntries(Object.keys(PIECES).map(p => [p, 0])), samples = [];
for (let n = 0; n < maxSeeds && Object.values(counts).some(c => c < want); n++) {
  const seed = `issue347-${n}`, layout = placement(seed, params, library);
  const pieces = layout.setPieces.filter(p => PIECES[p.setPiece] && counts[p.setPiece] < want);
  if (!pieces.length) continue;
  const briefs = mapViews({ layout, library, cellSize: 48, results: [] }).briefs;
  for (const piece of pieces) {
    counts[piece.setPiece]++;
    const slots = new Set(piece.slots.map(s => `${s.col},${s.row}`)), type = PIECES[piece.setPiece];
    const inPiece = b => b.cells.some(c => slots.has(`${Math.floor(c.x / SLOT)},${Math.floor(c.y / SLOT)}`));
    for (const brief of briefs.filter(b => b.type === type && inPiece(b))) {
      const result = buildRegion(brief), blockers = result.elements.flatMap(e => elementShapes(e));
      const reach = validatePortalReach({ ...brief, blockers });
      const sample = { seed, piece: piece.id, id: brief.id, ...fillFacts(brief), manifest: result.manifest,
        access: { portals: brief.portals.length, routes: reach.routes.length, errors: reach.errors },
        fillErrors: validateFillConstraints(brief, blockers) };
      if (type === 'block') {
        sample.lots = planBlock(brief).lots.map(lot => {
          const facts = fillFacts(lot), built = buildRegion(lot);
          return { id: lot.id.slice(brief.id.length + 1), type: lot.type, ...facts,
            structures: built.manifest.structures ?? 0, obstacles: built.manifest.obstacles ?? 0 };
        });
      }
      samples.push(sample);
      console.error(`${seed} ${piece.id} ${brief.id}: fill ${sample.fill}/${sample.cells}, runs ${sample.internalRuns}, square ${sample.maxFillSquare}`);
    }
  }
}

const summarize = type => {
  const rows = samples.filter(s => s.id.startsWith(`${type}@`));
  const lots = rows.flatMap(s => s.lots ?? []);
  return { regions: rows.length, cells: rows.reduce((n, s) => n + s.cells, 0), fill: rows.reduce((n, s) => n + s.fill, 0),
    internalRuns: rows.reduce((n, s) => n + s.internalRuns, 0), belowMinimum: rows.filter(s => !s.meetsMinimum).map(s => s.id),
    ...(type === 'block' ? { lots: lots.length, lotsBelowMinimum: lots.filter(l => !l.meetsMinimum).length,
      lotsByType: Object.fromEntries([...new Set(lots.map(l => l.type))].map(t => [t,
        { lots: lots.filter(l => l.type === t).length, belowMinimum: lots.filter(l => l.type === t && !l.meetsMinimum).length,
          noStructures: lots.filter(l => l.type === t && !l.structures).length,
          noObstacles: lots.filter(l => l.type === t && !l.obstacles).length }])) } : {}) };
};
const report = {
  audit: 'local-quarter-fill-347-1', sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  contentVersion: REGION_TYPES_VERSION, library: libraryFingerprint(library), params, pieces: counts,
  summary: { block: summarize('block'), depot: summarize('depot') }, samples,
};
await mkdir(out, { recursive: true });
await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ out, ...report, samples: undefined }, null, 2));
