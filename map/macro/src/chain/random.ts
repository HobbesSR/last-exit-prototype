/**
 * Named random streams. A stage draws only from streams named for itself (51 principle
 * 1), so one stage's draws never shift another's.
 */

export interface Stream {
  /** Uniform in [0, 1). */
  next(): number;
  /** A uniform index below `length`. */
  index(length: number): number;
  /** One of `items`, uniformly. */
  pick<T>(items: readonly T[]): T;
  /** A shuffled copy (Fisher–Yates). */
  shuffle<T>(items: readonly T[]): T[];
}

/** FNV-1a over the text. */
export function hashText(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** The stream `name` of `seed`. A retry passes its attempt, so each attempt draws afresh. */
export function stream(seed: string, name: string, attempt = 0): Stream {
  let state = hashText(`${name}\u0000${attempt}\u0000${seed}`) | 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const index = (length: number): number => Math.floor(next() * length);
  return {
    next,
    index,
    pick: (items) => items[index(items.length)]!,
    shuffle(items) {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i--) {
        const j = index(i + 1);
        [copy[i], copy[j]] = [copy[j]!, copy[i]!];
      }
      return copy;
    },
  };
}
