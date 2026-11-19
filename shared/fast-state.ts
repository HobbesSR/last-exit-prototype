// The fast part of a player view (24.2 "Recommendation", 24.5 stage 3). A view splits by how it changes: the
// slow layers (items, gates and the viewer's own discovery) stay on the reliable stream as keyframe layers
// (frame-layers.ts, discovery.ts), and everything else is fast state, sent on datagrams as changes against a
// frame the client has acknowledged. This module owns where that line falls; the wire schema's `fast`
// message types what is left (wire-schema.ts).

/** The view's fields that stay on the reliable stream. Own discovery (`self.discovered`) stays there too. */
export const SLOW_FIELDS = ['items', 'gates'] as const;

/**
 * The fast part of a projected player view: the view without its slow layers. A new object; the records in it
 * are the projection's own, so a frame kept as a baseline shares them with the view.
 */
export function fastFrame<T extends Record<string, unknown>>(view: T): Record<string, unknown> {
  const fast: Record<string, unknown> = { ...view };
  for (const field of SLOW_FIELDS) delete fast[field];
  const self = fast.self as Record<string, unknown> | undefined;
  if (self?.discovered !== undefined) {
    const { discovered: _discovered, ...rest } = self;
    fast.self = rest;
  }
  return fast;
}
