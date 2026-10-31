// Create an isolated snapshot with local witness repair; never edits the source.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [sourceArg, targetArg] = process.argv.slice(2);
if (!sourceArg || !targetArg || process.argv.length !== 4)
  throw new Error('Usage: node local-repair-prepare.mjs SOURCE NEW_TARGET');
const source = path.resolve(sourceArg), target = path.resolve(targetArg);
if (!fs.statSync(source).isDirectory()) throw new Error('SOURCE must be a directory.');
if (fs.existsSync(target)) throw new Error('NEW_TARGET must not already exist.');
if (source === target || source.startsWith(target + path.sep) || target.startsWith(source + path.sep))
  throw new Error('SOURCE and NEW_TARGET must be separate, non-nested paths.');
const file = 'map/micro/strategies/content-access.ts';
let text = fs.readFileSync(path.join(source, file), 'utf8').replace(/\r\n/g, '\n');
function replaceOnce(before, after) {
  const at = text.indexOf(before);
  if (at < 0 || text.indexOf(before, at + before.length) >= 0)
    throw new Error(`Expected exactly one anchor: ${before.slice(0, 100)}`);
  text = text.slice(0, at) + after + text.slice(at + before.length);
}
replaceOnce('type Evidence = { a: Vec2; b: Vec2; swept: Shape[] };',
  'type Evidence = { a: Vec2; b: Vec2; points: Vec2[]; swept: Shape[] };');
replaceOnce('    swept: points.slice(1).flatMap((p, i) => capsule(points[i]!, p, radius)) });',
  '    points: points.map(copyPoint), swept: points.slice(1).flatMap((p, i) => capsule(points[i]!, p, radius)) });');
const helper = fs.readFileSync(fileURLToPath(new URL('./local-repair.ts.txt', import.meta.url)), 'utf8').replace(/\r\n/g, '\n').trimEnd() + '\n\n';
const anchor = '/**\n * Strategy-local, monotone collision proof.';
replaceOnce(anchor, helper + anchor);
replaceOnce('        const route = routeTo(path.a, path.b);',
  '        const route = repairLocal(path, added, radius, region.cellSize, routeTo) ?? routeTo(path.a, path.b);');
fs.cpSync(source, target, { recursive: true, errorOnExist: true });
fs.writeFileSync(path.join(target, file), text);
