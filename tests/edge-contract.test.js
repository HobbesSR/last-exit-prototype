import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CAPABILITY, FLAG, FRAME, LINK_VERSION } from '../server/edge-link.js';
import { FLAG as CLIENT_FLAG } from '../public/arena-socket.js';
import { CLOSE_CODE } from '../server/protocol.js';
import { DATAGRAM_HEADER_BYTES, DATAGRAM_PAYLOAD_BYTES, MAX_FAST_FRAGMENTS } from '../shared/fast-state.ts';

// The edge's contracts are written three times: in the Rust edge, in Node (and the browser client), and in
// 24.5. The version handshake catches two sides on different versions, not two that disagree under one, and
// the only check that runs both is the slow edge.browser.mjs (#1185). This reads the Rust source's constants
// and 24.5 as text and holds every side to them, so a change to any side alone fails here.

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const FRAME_RS = read('rust/edge/src/frame.rs'), LIB_RS = read('rust/edge/src/lib.rs'), DOC = read('docs/24.5-transport.md');

/** The `const NAME: type = <integer literal>;` items of Rust source; other consts (expressions, durations) are left out. */
function rustConstants(source) {
  const out = new Map();
  for (const [, name, value] of source.matchAll(/^\s*(?:pub\s+)?const\s+(\w+)\s*:\s*\w+\s*=\s*(0x[0-9a-fA-F_]+|[0-9_]+)\s*;/gm)) {
    assert.ok(!out.has(name), `${name} is declared twice`);
    out.set(name, Number(value.replaceAll('_', '')));
  }
  return out;
}

const edge = new Map([...rustConstants(LIB_RS), ...rustConstants(FRAME_RS)]);
const rust = name => {
  assert.ok(edge.has(name), `rust/edge/src declares no integer const ${name}; update this test with the rename`);
  return edge.get(name);
};

/** The section of 24.5 after `heading` up to the next blank-line-separated bold or heading paragraph. */
const docSection = heading => {
  const at = DOC.indexOf(heading);
  assert.ok(at >= 0, `24.5 has no "${heading}"`);
  return DOC.slice(at, at + DOC.slice(at).search(/\n\n(?=\*\*|#)/));
};

test('the link frame types agree in Rust, Node and 24.5', () => {
  const block = FRAME_RS.match(/pub mod link \{([^}]*)\}/);
  assert.ok(block, 'rust/edge/src/frame.rs has a `pub mod link` holding the frame types');
  const linkTypes = rustConstants(block[1]);
  const doc = new Map();
  for (const [, code, name] of DOC.matchAll(/^\|\s*`(0x[0-9a-fA-F]{2})`\s+([A-Z]+)\s*\|/gm)) {
    assert.ok(!doc.has(name), `24.5's link table lists ${name} twice`);
    doc.set(name, Number(code));
  }
  assert.deepEqual(new Map(Object.entries(FRAME)), linkTypes, "Node's FRAME is Rust's frame::link");
  assert.deepEqual(doc, linkTypes, "24.5's link table is Rust's frame::link");
  assert.equal(new Set(linkTypes.values()).size, linkTypes.size, 'frame types are distinct');
});

test('the link version agrees in Rust, Node and 24.5', () => {
  const stated = DOC.match(/The link version is (\d+)\./);
  assert.ok(stated, '24.5 states the link version');
  assert.equal(rust('LINK_VERSION'), LINK_VERSION);
  assert.equal(Number(stated[1]), LINK_VERSION);
});

test('the message flags and OPEN capability agree in Rust, Node, the client and 24.5', () => {
  const stated = DOC.match(/a `u8` flag, (\d+) for text \(UTF-8\) and (\d+) for binary/);
  assert.ok(stated, "24.5's client stream states the flags");
  assert.deepEqual(FLAG, { TEXT: rust('TEXT'), BINARY: rust('BINARY') });
  assert.deepEqual(CLIENT_FLAG, FLAG);
  assert.deepEqual({ TEXT: Number(stated[1]), BINARY: Number(stated[2]) }, FLAG);
  assert.deepEqual(CAPABILITY, { STREAM_ONLY: rust('STREAM_ONLY'), DATAGRAMS: rust('DATAGRAMS') });
});

test("the edge's own close codes agree with the protocol and 24.5", () => {
  // The edge closes with 1000 when the client ends its stream, and with 1008 for a bad frame, as Node does.
  assert.equal(rust('CLOSE_NORMAL'), CLOSE_CODE.NORMAL);
  assert.equal(rust('CLOSE_POLICY'), CLOSE_CODE.POLICY_VIOLATION);
  // 24.5 lists the closes the edge makes on its own: 1008 for a bad client frame or no stream, 1001 when the
  // link drops. Node never sends 1001, so it has no constant of its own.
  const closes = docSection("**The edge's own closes,**");
  assert.match(closes, new RegExp(`\\*\\*${rust('CLOSE_POLICY')}\\*\\* for an oversized or malformed client frame`));
  assert.match(closes, new RegExp(`\\*\\*${rust('CLOSE_GOING_AWAY')}, "link lost"\\*\\*`));
  assert.match(LIB_RS, /Outcome::Close\(CLOSE_GOING_AWAY, b"link lost"/, 'the edge sends "link lost" with CLOSE_GOING_AWAY');
});

test("the edge's datagram fragments agree with Node's overflow limit and 24.5", () => {
  // Node streams a fast message the edge could not send in its fragments; the client reassembles them.
  assert.equal(rust('HEADER'), DATAGRAM_HEADER_BYTES);
  assert.equal(rust('FRAGMENT_BYTES'), DATAGRAM_PAYLOAD_BYTES);
  assert.equal(rust('MAX_FRAGMENTS'), MAX_FAST_FRAGMENTS);
  const stated = DOC.match(/at most ([\d,]+) bytes of the message, in at most (\d+) datagrams/);
  assert.ok(stated, "24.5 states the edge's fragment size and count");
  assert.deepEqual([Number(stated[1].replaceAll(',', '')), Number(stated[2])], [DATAGRAM_PAYLOAD_BYTES, MAX_FAST_FRAGMENTS]);
});
