import type { RegionBrief } from './types.ts';

/**
 * How the Map Lab hands a region's brief to the micro tools (20.5): in a page URL's
 * fragment, `#brief=` and the brief's JSON, deflated and base64url-encoded. A fragment
 * never reaches a server, works across the two dev servers' origins, and keeps a large
 * region's link short enough to share; a `block` brief's 60 KB of JSON becomes a few KB.
 */
const KEY = 'brief=';

/** The fragment, with its `#`, that carries `brief`. */
export async function briefFragment(brief: RegionBrief): Promise<string> {
  const packed = await piped(new TextEncoder().encode(JSON.stringify(brief)), new CompressionStream('deflate-raw'));
  let text = '';
  for (const byte of packed) text += String.fromCharCode(byte);
  return `#${KEY}${btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

/** The brief a fragment carries, or null when it carries none. A malformed one throws. */
export async function briefFromFragment(fragment: string): Promise<RegionBrief | null> {
  const at = fragment.replace(/^#/, '');
  if (!at.startsWith(KEY)) return null;
  const text = atob(at.slice(KEY.length).replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(text, char => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(await piped(bytes, new DecompressionStream('deflate-raw')))) as RegionBrief;
}

async function piped(bytes: Uint8Array<ArrayBuffer>, through: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(through);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
