// Constrainautor ships its TypeScript source as its types, which this project's module settings
// reject, so the root tsconfig maps the package here (its `paths`). Only the surface the
// free-space index calls is declared.
export interface DelaunatorLike {
  coords: { readonly length: number; readonly [n: number]: number };
  triangles: { readonly length: number; [n: number]: number };
  halfedges: { readonly length: number; [n: number]: number };
  hull: { readonly length: number; readonly [n: number]: number };
}
export default class Constrainautor {
  constructor(del: DelaunatorLike, edges?: readonly [number, number][]);
  del: DelaunatorLike;
  /** Constrain the edge between two point indices; throws when it would cross a constraint or pass through a point. */
  constrainOne(p1: number, p2: number): number;
  /** Whether a half-edge was marked a constraint. */
  isConstrained(edge: number): boolean;
}
