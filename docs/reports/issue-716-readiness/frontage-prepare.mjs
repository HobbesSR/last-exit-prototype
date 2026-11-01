// Prepare one isolated candidate from a complete cached source snapshot.
import fs from 'node:fs';
import path from 'node:path';

const [sourceArg, targetArg] = process.argv.slice(2);
if (!sourceArg || !targetArg || process.argv.length !== 4) throw new Error('Usage: node frontage-prepare.mjs SOURCE_SNAPSHOT NEW_CANDIDATE_DIR');
const source = path.resolve(sourceArg), target = path.resolve(targetArg);
if (!fs.statSync(source).isDirectory()) throw new Error('Source must be a directory.');
if (fs.existsSync(target)) throw new Error('Candidate directory must not already exist.');
if (target.startsWith(source + path.sep) || source.startsWith(target + path.sep) || source === target) throw new Error('Source and target must not contain one another.');
fs.cpSync(source, target, { recursive: true, errorOnExist: true });
function replaceOnce(text, before, after) {
  const at = text.indexOf(before);
  if (at < 0 || text.indexOf(before, at + before.length) >= 0) throw new Error(`Expected exactly one anchor: ${before.slice(0, 100)}`);
  return text.slice(0, at) + after + text.slice(at + before.length);
}
function edit(file, transform) {
  const name = path.join(target, file);
  fs.writeFileSync(name, transform(fs.readFileSync(name, 'utf8').replace(/\r\n/g, '\n')));
}

const depotPass = fs.readFileSync(new URL('./depot-boundary.ts.txt', import.meta.url), 'utf8').replace(/\r\n/g, '\n').trimEnd() + '\n\n';
edit('map/micro/strategies/depot.ts', text => {
  text = replaceOnce(text, "import { CELL_SCALE } from '../../kernel/scale.ts';", "import { CELL_SCALE } from '../../kernel/scale.ts';\nimport { compareCells } from '../../kernel/cell.ts';");
  text = replaceOnce(text, 'infill: 8, infillLength: 9, infillOffset: 10', 'infill: 8, infillLength: 9, infillOffset: 10, boundary: 11');
  const anchor = '  // Lanes run along u, one every LANE cells across, at a seeded phase.';
  text = replaceOnce(text, anchor, depotPass + anchor);
  return replaceOnce(text, '{ warehouses, designed, rows, infillCrates }', '{ warehouses, designed, rows, infillCrates, ...!experiment ? { boundaryRows } : {} }');
});
const marketPass = fs.readFileSync(new URL('./market-frontage.ts.txt', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
edit('map/micro/strategies/market.ts', text => {
  const start = '  // Small inward counters occupy exposed boundary cells where full stalls cannot fit.';
  const end = '  if (!stalls) return unfilledRegion(brief, CHANNEL.loot);';
  const a = text.indexOf(start), b = text.indexOf(end);
  if (a < 0 || b <= a || text.indexOf(start, a + 1) >= 0 || text.indexOf(end, b + 1) >= 0) throw new Error('Expected exactly one market frontage block.');
  text = text.slice(0, a) + text.slice(b);
  return replaceOnce(text, '  let stalls = 0;\n', '  let stalls = 0;\n' + marketPass);
});
