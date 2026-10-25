// Which numbered docs cost agents context? Reads Claude Code transcripts and totals the
// characters each docs/NN-*.md read returned, per doc and per session (docs/33, issue #510).
// Read-only; nothing leaves the machine.
//
//   node tools/doc-reads.mjs                              all history, top 35 docs
//   node tools/doc-reads.mjs --since 2026-10-26 --top 60  reads from a date on
//   node tools/doc-reads.mjs --match astra --dir ~/.claude/projects
//
// Shell reads (sed -n, cat, Get-Content, grep) count as well as the Read tool: most doc
// reads go through the shell. Only Claude Code transcripts are read.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resultChars, transcriptFiles } from "./forgejo-usage.mjs";

const DOC = /docs\/(\d[\d.]*-[\w.-]+?\.md)/g;
const KINDS = ["read-full", "read-range", "shell-full", "shell-range", "grep"];
const norm = (s) => String(s ?? "").replace(/\\/g, "/");
const docsIn = (s) => [...new Set([...norm(s).matchAll(DOC)].map((m) => m[1]))].sort();

// How a shell command reads its docs, or null when it writes or doesn't read them.
export function shellKind(cmd) {
  if (/\bsed\s+-i|perl\s+-pi|\bgit\s|apply_patch|>\s*docs\//.test(cmd)) return null;
  const ranged = /\bsed\s+-n|\bhead\b|\btail\b|\bawk\b/.test(cmd);
  if (/\b(grep|rg|Select-String)\b/.test(cmd) && !ranged && !/\bcat\b/.test(cmd)) return "grep";
  if (ranged) return "shell-range";
  if (/\bcat\b|Get-Content/.test(cmd)) return "shell-full";
  return null;
}

function docCall(b) {
  const inp = b.input ?? {};
  if (b.name === "Read") {
    const docs = docsIn(inp.file_path);
    return docs.length ? { docs, kind: inp.offset || inp.limit ? "read-range" : "read-full" } : null;
  }
  if (b.name === "Grep") {
    const docs = docsIn(inp.path);
    return docs.length ? { docs, kind: "grep" } : null;
  }
  if (b.name === "Bash" || b.name === "PowerShell") {
    const cmd = norm(inp.command);
    const docs = docsIn(cmd);
    const kind = docs.length && shellKind(cmd);
    return kind ? { docs, kind } : null;
  }
  return null;
}

// Pair doc-reading calls with their result sizes. `seen` dedupes calls repeated across
// resumed transcripts; `session` names the session the lines belong to.
export function collect(lines, session, seen = new Map()) {
  for (const line of lines) {
    const blocks = line?.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks) {
      if (b.type === "tool_use" && !seen.has(b.id)) {
        const call = docCall(b);
        if (call) seen.set(b.id, { ...call, session, ts: line.timestamp ?? "", chars: null });
      } else if (b.type === "tool_result" && seen.get(b.tool_use_id)?.chars === null) {
        seen.get(b.tool_use_id).chars = resultChars(b.content);
      }
    }
  }
  return seen;
}

// Per-doc totals over the answered records from `since` on. A call naming several docs
// splits its characters evenly between them.
export function summarize(records, since = "") {
  const docs = new Map();
  for (const r of records) {
    if (r.chars === null || r.ts < since) continue;
    for (const d of r.docs) {
      const t = docs.get(d) ?? { chars: 0, sessions: new Set(), kinds: Object.fromEntries(KINDS.map((k) => [k, 0])), last: "" };
      t.chars += r.chars / r.docs.length;
      t.sessions.add(r.session);
      t.kinds[r.kind]++;
      if (r.ts > t.last) t.last = r.ts;
      docs.set(d, t);
    }
  }
  return docs;
}

const pad = (s, n) => String(s).padStart(n);
const kb = (n) => Math.round(n / 1024);

export function report(records, { since = "", top = 35 } = {}) {
  const docs = summarize(records, since);
  const total = [...docs.values()].reduce((n, t) => n + t.chars, 0);
  const sessions = new Set([...docs.values()].flatMap((t) => [...t.sessions]));
  const out = [`${sessions.size} sessions read docs${since ? ` from ${since}` : ""}: ${kb(total)} KB (~${Math.round(total / 4000)}k tokens)`];
  out.push(`${"doc".padEnd(44)}${pad("sess", 5)}${pad("KB", 6)}${pad("%", 6)}${pad("full/range/grep", 17)}${pad("KB/sess", 9)}  last`);
  for (const [d, t] of [...docs].sort((a, b) => b[1].chars - a[1].chars).slice(0, top)) {
    const k = t.kinds;
    const mix = `${k["read-full"] + k["shell-full"]}/${k["read-range"] + k["shell-range"]}/${k.grep}`;
    out.push(`${d.slice(0, 43).padEnd(44)}${pad(t.sessions.size, 5)}${pad(kb(t.chars), 6)}${pad((100 * t.chars / total).toFixed(1), 6)}` +
      `${pad(mix, 17)}${pad((t.chars / 1024 / t.sessions.size).toFixed(1), 9)}  ${t.last.slice(0, 10)}`);
  }
  return out.join("\n");
}

if (process.argv[1]?.endsWith("doc-reads.mjs")) {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const dir = opt("--dir", path.join(os.homedir(), ".claude", "projects"));
  const files = transcriptFiles(dir, opt("--match", "astra"));
  const seen = new Map();
  for (const f of files) {
    const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean).flatMap((l) => {
      try { return [JSON.parse(l)]; } catch { return []; }
    });
    // A subagent's transcript counts toward the session that spawned it.
    collect(lines, norm(f).split("/subagents/")[0].replace(/\.jsonl$/, ""), seen);
  }
  console.log(`${files.length} transcripts under ${dir}`);
  console.log(report([...seen.values()], { since: opt("--since", ""), top: Number(opt("--top", 35)) }));
}
