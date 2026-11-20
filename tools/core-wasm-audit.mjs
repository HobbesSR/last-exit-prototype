// Audits the built core module for what determinism forbids (docs/27 "Physics", #1192).
//
// The core's own code is held by rust/core/clippy.toml, but clippy does not lint dependencies, and
// Rapier, nalgebra, parry2d, glam and simba all carry `mul_add` and platform-math paths in their
// source. What matters is what reaches the module, so this reads the module itself:
//   - imports: none. A host function (Math.sin, a platform libm) can only enter through one.
//   - instructions: the whole code section is decoded. WASM's only fused multiply-add is relaxed
//     SIMD's, so any SIMD prefix (0xFD) fails, as does a target feature naming SIMD.
//   - functions: a software fma (`fma`, `fmaf`, `libm::...::fma`) is exactly rounded but is not
//     `a * b + c`, so a function so named fails. The transcendentals present are listed with the
//     crate they come from: compiled into the module, they give every host the same bits.
//
//   node tools/core-wasm-audit.mjs     build the core, audit it and print the report
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Matched against a function's last path segment, after demangling.
const MATH = /^(sin|cos|tan|asin|acos|atan2?|sinh|cosh|tanh|exp2?|expm1|log2?|log10|log1p|powf?|powi|cbrt|hypot|rem_pio2|k_sin|k_cos|k_tan|sincos)f?$/;
const FMA = /^(fmaf?|mul_add)$/;

/**
 * Enough of Rust's v0 demangling to read a path: `_RNvNtCs..._4libm4math4cosf4cosf` becomes
 * `libm::math::cosf::cosf`. Each identifier is a decimal length, an optional `_`, then the text;
 * crate disambiguators (`Cs...`) and the other tags are skipped. Unmangled names pass through.
 */
export function demangle(name) {
  if (!name.startsWith('_R')) return name;
  const parts = [];
  for (let i = 2; i < name.length;) {
    if (name[i] === 'C' && name[i + 1] === 's') { i = name.indexOf('_', i) + 1; continue; }
    if (!/[0-9]/.test(name[i])) { i++; continue; }
    let j = i;
    while (/[0-9]/.test(name[j])) j++;
    const length = Number(name.slice(i, j));
    if (name[j] === '_') j++;
    parts.push(name.slice(j, j + length));
    i = j + length;
  }
  return parts.join('::');
}

function reader(bytes) {
  let at = 0;
  const r = {
    get at() { return at; },
    set at(value) { at = value; },
    byte: () => bytes[at++],
    u32() {
      let result = 0, shift = 0, b;
      do { b = bytes[at++]; result += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80);
      return result;
    },
    skipLeb() { while (bytes[at++] & 0x80); },
    name() { const length = r.u32(); const text = new TextDecoder().decode(bytes.subarray(at, at + length)); at += length; return text; },
  };
  return r;
}

/** Walks one function body's instructions, calling `visit(opcode, sub)` for each. */
function decodeBody(bytes, start, end, visit) {
  const r = reader(bytes);
  r.at = start;
  const locals = r.u32();
  for (let i = 0; i < locals; i++) { r.u32(); r.byte(); }
  while (r.at < end) {
    const op = r.byte();
    if (op === 0x02 || op === 0x03 || op === 0x04) {
      const type = bytes[r.at];
      if (type === 0x40 || (type >= 0x6f && type <= 0x7f)) r.at++; else r.skipLeb();
    } else if (op === 0x0c || op === 0x0d || op === 0x10 || (op >= 0x20 && op <= 0x26) || op === 0xd2 || op === 0x12) r.u32();
    else if (op === 0x0e) { const n = r.u32(); for (let i = 0; i <= n; i++) r.u32(); }
    else if (op === 0x11 || op === 0x13) { r.u32(); r.u32(); }
    else if (op === 0x1c) { const n = r.u32(); r.at += n; }
    else if (op >= 0x28 && op <= 0x3e) { r.u32(); r.u32(); }
    else if (op === 0x3f || op === 0x40) r.u32();
    else if (op === 0x41 || op === 0x42) r.skipLeb();
    else if (op === 0x43) r.at += 4;
    else if (op === 0x44) r.at += 8;
    else if (op === 0xd0) r.at++;
    else if (op === 0xfc) {
      const sub = r.u32();
      if (sub === 8) { r.u32(); r.u32(); }
      else if (sub === 10) { r.u32(); r.u32(); }
      else if (sub === 9 || sub === 11 || sub === 13 || (sub >= 15 && sub <= 17)) r.u32();
      else if (sub === 12 || sub === 14) { r.u32(); r.u32(); }
      else if (sub > 17) throw new Error(`unknown 0xFC instruction ${sub} at byte ${r.at}`);
      visit(op, sub);
      continue;
    } else if (op === 0xfd) { visit(op, r.u32()); return; }
    else if (op > 0xd2 && op !== 0xfc) throw new Error(`unknown opcode 0x${op.toString(16)} at byte ${r.at - 1}`);
    visit(op);
  }
}

/** Audits a module's bytes; `problems` is empty when it passes. */
export function auditCore(bytes) {
  const module = new WebAssembly.Module(bytes);
  const problems = [];
  const imports = WebAssembly.Module.imports(module);
  for (const entry of imports) problems.push(`imports ${entry.module}.${entry.name}`);

  const features = WebAssembly.Module.customSections(module, 'target_features')
    .map(section => new TextDecoder().decode(new Uint8Array(section)));
  for (const text of features) if (/simd/i.test(text)) problems.push(`target features name SIMD: ${text}`);

  // Section walk: the import count offsets function indices; the code section holds the bodies.
  const r = reader(bytes);
  r.at = 8;
  let importedFunctions = 0;
  const names = new Map();
  let code;
  while (r.at < bytes.length) {
    const id = r.byte(), size = r.u32(), end = r.at + size;
    if (id === 2) {
      const count = r.u32();
      for (let i = 0; i < count; i++) {
        r.name(); r.name();
        const kind = r.byte();
        if (kind === 0) { importedFunctions++; r.u32(); }
        else if (kind === 1) { r.byte(); const flags = r.u32(); r.u32(); if (flags & 1) r.u32(); }
        else if (kind === 2) { const flags = r.u32(); r.u32(); if (flags & 1) r.u32(); }
        else if (kind === 3) { r.byte(); r.byte(); }
      }
    } else if (id === 10) code = { start: r.at, end };
    else if (id === 0 && r.name() === 'name') {
      while (r.at < end) {
        const sub = r.byte(), length = r.u32(), subEnd = r.at + length;
        if (sub === 1) {
          const count = r.u32();
          for (let i = 0; i < count; i++) { const index = r.u32(); names.set(index, r.name()); }
        }
        r.at = subEnd;
      }
    }
    r.at = end;
  }
  if (!code) throw new Error('the module has no code section');
  if (!names.size) problems.push('the module has no function names to audit (was it stripped?)');

  r.at = code.start;
  const count = r.u32();
  let instructions = 0;
  for (let i = 0; i < count; i++) {
    const size = r.u32(), start = r.at;
    const index = importedFunctions + i;
    decodeBody(bytes, start, start + size, (op, sub) => {
      instructions++;
      if (op === 0xfd) problems.push(`SIMD instruction 0xFD ${sub} in ${names.get(index) ?? `function ${index}`}`);
    });
    r.at = start + size;
  }

  const math = [], fused = [];
  for (const mangled of names.values()) {
    const name = demangle(mangled), last = name.split('::').at(-1);
    if (FMA.test(last)) fused.push(name);
    else if (MATH.test(last)) math.push(name);
  }
  for (const name of fused) problems.push(`fused multiply-add function ${name}`);
  return { problems, functions: count, instructions, imports: imports.length, features, math: math.sort() };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { buildCore } = await import('./build-core.mjs');
  const report = auditCore(readFileSync(buildCore()));
  console.log(`${report.functions} functions, ${report.instructions} instructions, ${report.imports} imports`);
  console.log(`target features: ${report.features.join(' ') || '(none)'}`);
  console.log(`transcendental functions compiled in (${report.math.length}):`);
  for (const name of report.math) console.log(`  ${name}`);
  if (report.problems.length) {
    console.error(`problems (${report.problems.length}):`);
    for (const problem of report.problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log('no imports, no SIMD, no fused multiply-add');
}
