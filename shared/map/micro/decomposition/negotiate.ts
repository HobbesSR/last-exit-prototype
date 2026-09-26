import { resolveAccessRequirements } from '../access.ts';
import { inheritBoundaryPorts, pairedBoundaryPort } from '../boundary.ts';
import { cellKey } from './analysis.ts';
import type { RegionBoundary } from '../boundary.ts';
import type { Cell, Passage, RegionPort } from '../types.ts';
import type { InterfaceRun, PieceInterface } from './types.ts';

const RANK: Record<Passage, number> = { none: 0, contestant: 1, hunter: 2 };
const CLASSES = ['contestant', 'hunter'] as const;

/**
 * What one shared interface promises. `others` is what happens to the runs the
 * crossing does not use: `sealed` states a closed contract on each, `unstated`
 * emits nothing there, which is open ground rather than a promise of passage.
 */
export interface CrossingTerms { required: Passage; allowed: Passage; others: 'sealed' | 'unstated' }
export interface PortalPolicy {
  /** Terms for one interface between two children; null leaves the whole seam unstated. */
  crossing(edge: PieceInterface): CrossingTerms | null;
  /** Children must be joined by required crossings of at least this class. Defaults to `none`. */
  connect?: Passage;
}
export interface NegotiatedCrossing {
  interface: string;
  a: string;
  b: string;
  required: Passage;
  allowed: Passage;
  /** The run carrying the crossing, or null when the seam is sealed or unstated. */
  run: InterfaceRun | null;
  portA: string | null;
  portB: string | null;
}
export interface NegotiatedPortals {
  /** Complete port lists per child: inherited obligations first, then interface contracts. */
  ports: Record<string, RegionPort[]>;
  crossings: NegotiatedCrossing[];
  /** Interfaces naming ground outside these children, such as reserved cells. They get no contract. */
  skipped: string[];
  /** Children grouped by required-crossing reachability for each body class. */
  components: Record<'contestant' | 'hunter', string[][]>;
}

function contract(run: InterfaceRun, id: string, required: Passage, allowed: Passage, negativeOwner: string, owners: Map<string, string>) {
  const horizontal = run.axis === 'h', negative = { x: run.x - (horizontal ? 0 : 1), y: run.y - (horizontal ? 1 : 0) };
  if (owners.get(cellKey(negative)) !== negativeOwner) return null;
  const port: RegionPort = { id, side: horizontal ? 'S' : 'E', start: negative, length: run.length, required, allowed };
  return { negative: port, positive: pairedBoundaryPort(port) };
}

/**
 * Turn structural interfaces into paired floor/ceiling contracts under a caller
 * policy, and pass the parent's external obligations to their owners. This is a
 * contract step: it generates and repairs nothing, and a crossing it chooses is
 * proven only by validating the generated geometry afterwards.
 */
export function negotiatePortals(parent: RegionBoundary, children: Array<{ id: string; cells: Cell[] }>, interfaces: readonly PieceInterface[], policy: PortalPolicy): NegotiatedPortals {
  const connect = policy.connect ?? 'none';
  if (!Object.hasOwn(RANK, connect) || typeof policy.crossing !== 'function') throw new Error('Invalid portal policy.');
  const inherited = inheritBoundaryPorts(parent, children), ports: Record<string, RegionPort[]> = Object.create(null);
  const owners = new Map(children.flatMap(child => child.cells.map(cell => [cellKey(cell), child.id] as const)));
  const byId = new Map(children.map(child => [child.id, child]));
  for (const child of children) ports[child.id] = structuredClone(inherited[child.id]!);
  const fits = (child: { cells: Cell[] }, port: RegionPort) => {
    try { resolveAccessRequirements({ ...parent, cells: child.cells, ports: [port] }); return true; } catch { return false; }
  };
  const crossings: NegotiatedCrossing[] = [], skipped: string[] = [], links: Array<{ a: string; b: string; required: Passage }> = [];
  for (const [i, edge] of interfaces.entries()) {
    const a = byId.get(edge.a), b = byId.get(edge.b);
    if (!a || !b) { skipped.push(edge.id); continue; }
    const terms = policy.crossing(edge);
    if (terms === null) { crossings.push({ interface: edge.id, a: a.id, b: b.id, required: 'none', allowed: 'none', run: null, portA: null, portB: null }); continue; }
    if (!terms || !Object.hasOwn(RANK, terms.required) || !Object.hasOwn(RANK, terms.allowed) || RANK[terms.required] > RANK[terms.allowed] || !['sealed', 'unstated'].includes(terms.others)) throw new Error(`Invalid crossing terms for ${edge.id}.`);
    const pair = (run: InterfaceRun, j: number, required: Passage, allowed: Passage) => {
      const id = `join-${i}-${j}`, forward = contract(run, id, required, allowed, a.id, owners);
      const sides = forward ? { a: forward.negative, b: forward.positive } : (() => {
        const reverse = contract(run, id, required, allowed, b.id, owners);
        if (!reverse) throw new Error(`Interface run in ${edge.id} is not owned by its two children.`);
        return { a: reverse.positive, b: reverse.negative };
      })();
      return sides;
    };
    // The body a crossing must physically carry: its floor, or its ceiling when only permitted.
    const carries = RANK[terms.required] ? terms.required : terms.allowed;
    const order = [...edge.runs.entries()].sort(([, p], [, q]) => q.length - p.length || p.y - q.y || p.x - q.x);
    const chosen = carries === 'none' ? undefined : order.find(([j, run]) => {
      const probe = pair(run, j, carries, carries);
      return fits(a, probe.a) && fits(b, probe.b);
    });
    if (carries !== 'none' && !chosen) throw new Error(`Interface ${edge.a} / ${edge.b} has no run that can carry a ${carries} crossing.`);
    let portA: string | null = null, portB: string | null = null;
    for (const [j, run] of edge.runs.entries()) {
      const open = chosen?.[0] === j;
      if (!open && terms.others === 'unstated') continue;
      const sides = pair(run, j, open ? terms.required : 'none', open ? terms.allowed : 'none');
      ports[a.id]!.push(sides.a); ports[b.id]!.push(sides.b);
      if (open) { portA = sides.a.id; portB = sides.b.id; }
    }
    crossings.push({ interface: edge.id, a: a.id, b: b.id, required: terms.required, allowed: terms.allowed, run: chosen ? { ...chosen[1] } : null, portA, portB });
    links.push({ a: a.id, b: b.id, required: terms.required });
  }
  for (const child of children) resolveAccessRequirements({ ...parent, cells: child.cells, ports: ports[child.id]! });

  const components = {} as NegotiatedPortals['components'];
  for (const role of CLASSES) {
    const root = new Map(children.map(child => [child.id, child.id]));
    const find = (id: string): string => { let r = id; while (root.get(r) !== r) r = root.get(r)!; return r; };
    for (const link of links) if (RANK[link.required] >= RANK[role]) root.set(find(link.a), find(link.b));
    const groups = new Map<string, string[]>();
    for (const child of children) { const r = find(child.id); if (!groups.has(r)) groups.set(r, []); groups.get(r)!.push(child.id); }
    components[role] = [...groups.values()];
    if (RANK[connect] >= RANK[role] && components[role].length > 1) throw new Error(`Portal policy leaves children disconnected for ${role}: ${components[role].map(g => g.join('+')).join(' | ')}.`);
    const obligated = new Set(children.filter(child => inherited[child.id]!.some(p => RANK[p.required] >= RANK[role])).map(child => find(child.id)));
    if (obligated.size > 1) throw new Error(`External ${role} obligations are held by children the portal policy does not join.`);
  }
  return { ports, crossings, skipped, components };
}
