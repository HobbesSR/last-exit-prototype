// The built core carries no host math, SIMD or fused multiply-add (docs/27 "Physics", #1192).
// Rapier and its math crates are dependencies, which clippy's guard does not reach, so the module
// itself is checked. About 0.1 s: one decode of the module the global setup already built.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { auditCore, demangle } from '../tools/core-wasm-audit.mjs';
import { CORE_WASM } from '../tools/build-core.mjs';

test('the core module imports nothing and has no SIMD or fused multiply-add', () => {
  const report = auditCore(readFileSync(CORE_WASM));
  assert.deepEqual(report.problems, []);
  // Rapier's code is in the module: its math comes from the `libm` crate (enhanced-determinism).
  assert.ok(report.math.some(name => name.startsWith('libm::')), report.math.join('\n'));
});

// A minimal module: one type () -> f32, an optional import, one function whose body is `body`.
const leb = n => { const out = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return out; };
const section = (id, bytes) => [id, ...leb(bytes.length), ...bytes];
const text = s => [...leb(s.length), ...Buffer.from(s)];
function module({ imported, body, name }) {
  const types = section(1, [1, 0x60, 0, 1, 0x7d]);
  const imports = imported ? section(2, [1, ...text('env'), ...text(imported), 0, 0]) : [];
  const functions = section(3, [1, 0]);
  const code = section(10, [1, ...leb(body.length + 2), 0, ...body, 0x0b]);
  const index = imported ? 1 : 0;
  const functionNames = [1, ...leb(index), ...text(name)];
  const names = section(0, [...text('name'), 1, ...leb(functionNames.length), ...functionNames]);
  return new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...types, ...imports, ...functions, ...code, ...names]);
}

test('the audit catches an import, a SIMD instruction and a software fma', () => {
  const clean = module({ body: [0x43, 0, 0, 0x80, 0x3f], name: 'probe' });
  assert.deepEqual(auditCore(clean).problems, []);
  assert.match(auditCore(module({ imported: 'sin', body: [0x43, 0, 0, 0, 0], name: 'probe' })).problems.join(), /imports env\.sin/);
  // v128.const 0, f32x4.extract_lane 0
  const simd = [0xfd, 0x0c, ...new Array(16).fill(0), 0xfd, 0x1f, 0];
  assert.match(auditCore(module({ body: simd, name: 'probe' })).problems.join(), /SIMD instruction 0xFD 12 in probe/);
  assert.match(auditCore(module({ body: [0x43, 0, 0, 0, 0], name: 'fmaf' })).problems.join(), /fused multiply-add function fmaf/);
});

test('demangling reads Rust v0 paths', () => {
  assert.equal(demangle('_RNvNtNtCsbnW18ZkJqCJ_4libm4math4cosf4cosf'), 'libm::math::cosf::cosf');
  assert.equal(demangle('sinf'), 'sinf');
});
