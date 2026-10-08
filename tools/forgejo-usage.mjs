// How much context do Forgejo MCP results cost? Reads Claude Code transcripts and totals
// result characters per tool (docs/34, issue #282). Read-only; nothing leaves the machine.
//
//   node tools/forgejo-usage.mjs                          all history, per tool
//   node tools/forgejo-usage.mjs --split 2026-10-08       before vs after a restart
//   node tools/forgejo-usage.mjs --match astra --dir ~/.claude/projects
//
// Only Claude Code transcripts are read (Codex and Antigravity log elsewhere).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FORGEJO = "mcp__forgejo__";

function resultChars(content) {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((n, part) => n + (typeof part?.text === "string" ? part.text.length : 0), 0);
}

// Pair tool calls with their results. `seen` dedupes calls repeated across resumed transcripts.
export function collect(lines, seen = new Map()) {
  for (const line of lines) {
    const blocks = line?.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks) {
      if (b.type === "tool_use" && !seen.has(b.id)) {
        seen.set(b.id, { name: b.name, ts: line.timestamp ?? "", chars: null });
      } else if (b.type === "tool_result" && seen.has(b.tool_use_id)) {
        const rec = seen.get(b.tool_use_id);
        if (rec.chars === null) rec.chars = resultChars(b.content);
      }
    }
  }
  return seen;
}

// Totals for forgejo tools and for everything else, over the records matching `inRange`.
export function summarize(records, inRange = () => true) {
  const tools = new Map();
  const other = { calls: 0, chars: 0 };
  for (const r of records) {
    if (r.chars === null || !inRange(r)) continue;
    if (r.name.startsWith(FORGEJO)) {
      const t = tools.get(r.name) ?? { calls: 0, chars: 0 };
      t.calls++;
      t.chars += r.chars;
      tools.set(r.name, t);
    } else {
      other.calls++;
      other.chars += r.chars;
    }
  }
  return { tools, other };
}

const avg = (t) => (t && t.calls ? Math.round(t.chars / t.calls) : 0);
const pad = (s, n) => String(s).padStart(n);

export function report(records, split) {
  const out = [];
  const total = (m) => [...m.values()].reduce((a, t) => ({ calls: a.calls + t.calls, chars: a.chars + t.chars }), { calls: 0, chars: 0 });
  const names = (...sums) => [...new Set(sums.flatMap((s) => [...s.tools.keys()]))].sort();
  const short = (n) => n.slice(FORGEJO.length);

  if (!split) {
    const s = summarize(records);
    out.push(`${"tool".padEnd(30)}${pad("calls", 7)}${pad("chars", 11)}${pad("avg", 8)}`);
    for (const n of names(s)) {
      const t = s.tools.get(n);
      out.push(`${short(n).padEnd(30)}${pad(t.calls, 7)}${pad(t.chars, 11)}${pad(avg(t), 8)}`);
    }
    const f = total(s.tools);
    out.push(`${"forgejo total".padEnd(30)}${pad(f.calls, 7)}${pad(f.chars, 11)}${pad(avg(f), 8)}`);
    out.push(`${"all other tools".padEnd(30)}${pad(s.other.calls, 7)}${pad(s.other.chars, 11)}${pad(avg(s.other), 8)}`);
    return out.join("\n");
  }

  const before = summarize(records, (r) => r.ts < split);
  const after = summarize(records, (r) => r.ts >= split);
  out.push(`before ${split} vs from ${split}`);
  out.push(`${"tool".padEnd(30)}${pad("calls", 11)}${pad("avg chars", 22)}${pad("change", 9)}`);
  const row = (label, b, a) => {
    const change = avg(b) && a?.calls ? `${Math.round((avg(a) / avg(b) - 1) * 100)}%` : "-";
    out.push(`${label.padEnd(30)}${pad(`${b?.calls ?? 0} / ${a?.calls ?? 0}`, 11)}${pad(`${avg(b)} / ${avg(a)}`, 22)}${pad(change, 9)}`);
  };
  for (const n of names(before, after)) row(short(n), before.tools.get(n), after.tools.get(n));
  row("forgejo total", total(before.tools), total(after.tools));
  row("all other tools", before.other, after.other);
  return out.join("\n");
}

function transcriptFiles(dir, match) {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".jsonl")) files.push(p);
    }
  };
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && e.name.toLowerCase().includes(match.toLowerCase())) walk(path.join(dir, e.name));
  }
  return files;
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("forgejo-usage.mjs")) {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const dir = opt("--dir", path.join(os.homedir(), ".claude", "projects"));
  const files = transcriptFiles(dir, opt("--match", "astra"));
  const seen = new Map();
  for (const f of files) {
    const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean).flatMap((l) => {
      try { return [JSON.parse(l)]; } catch { return []; }
    });
    collect(lines, seen);
  }
  console.log(`${files.length} transcripts under ${dir}`);
  console.log(report([...seen.values()], opt("--split")));
}
