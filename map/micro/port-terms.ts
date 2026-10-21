import type { Passage, RegionPort } from './types.ts';

/** A port's side of its owned cells. */
export type Side = RegionPort['side'];

/** The side that faces it across a shared edge. */
export const OPPOSITE: Readonly<Record<Side, Side>> = Object.freeze({ N: 'S', S: 'N', E: 'W', W: 'E' });

/** Passages in order of what they admit: a hunter passage also admits contestants. */
export const PASSAGE_RANK: Readonly<Record<Passage, number>> = Object.freeze({ none: 0, contestant: 1, hunter: 2 });

/** The ports whose required passage admits `role`, in their given order. */
export function requiredFor<P extends { required: Passage }>(ports: readonly P[], role: Passage): P[] {
  return ports.filter(port => PASSAGE_RANK[port.required] >= PASSAGE_RANK[role]);
}
