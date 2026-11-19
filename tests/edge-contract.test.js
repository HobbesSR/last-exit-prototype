import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FLAG, FRAME, LINK_VERSION } from '../server/edge-link.js';
import { FLAG as CLIENT_FLAG } from '../public/arena-socket.js';
import { CLOSE_CODE } from '../server/protocol.js';

// The edge's contracts are written three times: in the Rust edge, in Node (and the browser client), and in
// 24.5's table. The version handshake catches two sides on different versions, not two that disagree under
// one, and the only check that runs both is the slow edge.browser.mjs (#1185). This reads the Rust source's
// constants and 24.5's table as text and holds every side to them, so a change to any side alone fails here.

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

/** The `const NAME: type = literal;` items of a Rust source; a value that is not a plain integer is an error. */
function rustConstants(file) {
  const out = new Map();
  for (const [, name, value] of read(file).matchAll(/^\s*(?:pub\s+)?const\s+(\w+)\s*:\s*\w+\s*=\s*([^;]+);/gm)) {
    if (/^(0x[0-9a-fA-F_]+|[0-9_]+)$/.test(value.trim())) out.set(name, Number(value.trim().replaceAll('_', '')));
  }
  return out;
}

const edge = new Map([...rustConstants('rust/edge/src/lib.rs'), ...rustConstants('rust/edge/src/frame.rs')]);
const rust = name => {
  assert.ok(edge.has(name), `rust/edge/src declares no integer const ${name}; update this test with the rename`);
  return edge.get(name);
};

test('the link frame types agree in Rust, Node and 24.5', () => {
  const doc = new Map();
  for (const [, code, name] of read('docs/24.5-transport.md').matchAll(/^\|\s*`(0x[0-9a-fA-F]{2})`\s+([A-Z]+)\s*\|/gm)) {
    doc.set(name, Number(code));
  }
  assert.deepEqual([...doc.keys()].sort(), Object.keys(FRAME).sort(), "24.5's link table names Node's frame types");
  for (const [name, code] of Object.entries(FRAME)) {
    assert.equal(rust(name), code, `${name}: Rust ${rust(name)}, Node ${code}`);
    assert.equal(doc.get(name), code, `${name}: 24.5 ${doc.get(name)}, Node ${code}`);
  }
  assert.equal(new Set(Object.values(FRAME)).size, Object.keys(FRAME).length, 'frame types are distinct');
});

test('the link version agrees in Rust, Node and 24.5', () => {
  const stated = read('docs/24.5-transport.md').match(/The link version is (\d+)\./);
  assert.ok(stated, '24.5 states the link version');
  assert.equal(rust('LINK_VERSION'), LINK_VERSION);
  assert.equal(Number(stated[1]), LINK_VERSION);
});

test('the message flags agree in Rust, Node and the client', () => {
  assert.deepEqual(FLAG, { TEXT: rust('TEXT'), BINARY: rust('BINARY') });
  assert.deepEqual(CLIENT_FLAG, FLAG);
});

test("the edge's own close codes are the protocol's", () => {
  assert.equal(rust('CLOSE_NORMAL'), CLOSE_CODE.NORMAL);
  assert.equal(rust('CLOSE_POLICY'), CLOSE_CODE.POLICY_VIOLATION);
});
