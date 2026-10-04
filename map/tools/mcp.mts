#!/usr/bin/env node
/**
 * The map MCP server (53, "Tools"): bounded stdio tools over the same core as the CLI.
 * Maps travel as wire version 7 JSON.
 */
import readline from 'node:readline';
import { chainMapToJson } from '../macro/src/chain/saving.ts';
import { CHAIN_LIBRARY, MAX_BATCH_COUNT, MAX_JSON_BYTES, assertObject, batch, checkMap, generate, readMap, validateLibrary } from './core.ts';

/** The diagnostic takes about a minute a game map, so a call that runs it is kept short. */
export const MAX_DIAGNOSED_BATCH = 5;

type Id = string | number | null | undefined;
interface Request {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: { name?: unknown; arguments?: unknown };
}
type Args = Record<string, unknown>;

const params = { type: 'object', description: 'mode, zoneWidth, zoneHeight, exitCount, contestantCount, hunterCount, lootChance, lootTierStep; omitted ones take the game defaults' };
const library = { type: 'object', description: "a chain library (version 3); the chain's own library when omitted" };
const diagnose = { type: 'boolean', description: "also run the game's per-region portal check, about a minute a game map" };
const tools = [
  {
    name: 'map_generate',
    description: 'Generate a deterministic chain map. Returns it in wire form, with its report.',
    inputSchema: {
      type: 'object', required: ['seed'],
      properties: {
        seed: { type: ['string', 'number'] }, params, library,
        cellSize: { type: 'number', exclusiveMinimum: 0 },
        layoutOnly: { type: 'boolean', description: 'save the Layout alone; reading it rebuilds the regions' },
      },
    },
  },
  {
    name: 'map_validate',
    description: 'Read a saved chain map with the library it was made from, and report its defects.',
    inputSchema: { type: 'object', required: ['map'], properties: { map: { type: 'object' }, library, diagnose } },
  },
  {
    name: 'library_validate',
    description: 'Validate a chain library against the game\'s region types.',
    inputSchema: { type: 'object', required: ['library'], properties: { library: { type: 'object' } } },
  },
  {
    name: 'map_batch',
    description: `Generate and check up to ${MAX_BATCH_COUNT} maps (${MAX_DIAGNOSED_BATCH} with diagnose), returning metric distributions, defects and failures.`,
    inputSchema: {
      type: 'object',
      properties: {
        seedPrefix: { type: ['string', 'number'] },
        count: { type: 'integer', minimum: 1, maximum: MAX_BATCH_COUNT },
        params, library, diagnose,
      },
    },
  },
  {
    name: 'library_get',
    description: "Get the chain's library.",
    inputSchema: { type: 'object', properties: {} },
  },
];

function reply(id: Id, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}
function error(id: Id, code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })}\n`);
}
function content(value: unknown, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) };
}
const optionalObject = (value: unknown, name: string): Args => value === undefined ? {} : assertObject(value, name);

function invoke(name: string, a: Args): unknown {
  if (name === 'map_generate') {
    const map = generate(a.seed, optionalObject(a.params, 'params'), a.library, a.cellSize === undefined ? undefined : Number(a.cellSize));
    const { defects, metrics } = checkMap(map);
    return { map: JSON.parse(chainMapToJson(map, { results: a.layoutOnly !== true })), defects, metrics };
  }
  if (name === 'map_validate') return checkMap(readMap(assertObject(a.map, 'map'), a.library), { diagnose: a.diagnose === true });
  if (name === 'library_validate') return validateLibrary(a.library);
  if (name === 'library_get') return CHAIN_LIBRARY;
  if (name === 'map_batch') {
    const count = a.count ?? 20;
    if (a.diagnose === true && Number(count) > MAX_DIAGNOSED_BATCH) throw new Error(`a diagnosed batch takes at most ${MAX_DIAGNOSED_BATCH} maps`);
    return batch(a.seedPrefix ?? 'batch', count, optionalObject(a.params, 'params'), a.library, { diagnose: a.diagnose === true });
  }
  throw new Error(`unknown tool: ${name}`);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line: string) => {
  let request: Request | undefined;
  try {
    if (Buffer.byteLength(line) > MAX_JSON_BYTES) throw new Error('request too large');
    request = JSON.parse(line);
    if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      error(request?.id, -32600, 'Invalid Request');
      return;
    }
    const notification = request.id === undefined;
    if (request.method === 'notifications/initialized') return;
    if (request.method === 'initialize') {
      if (!notification) reply(request.id, {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'last-exit-map', version: '0.2.0' },
      });
      return;
    }
    if (request.method === 'ping') {
      if (!notification) reply(request.id, {});
      return;
    }
    if (request.method === 'tools/list') {
      if (!notification) reply(request.id, { tools });
      return;
    }
    if (request.method === 'tools/call') {
      const p = request.params;
      if (!p || typeof p.name !== 'string' || (p.arguments !== undefined && (!p.arguments || typeof p.arguments !== 'object' || Array.isArray(p.arguments)))) {
        if (!notification) error(request.id, -32602, 'Invalid params');
        return;
      }
      if (!notification) {
        try {
          reply(request.id, content(invoke(p.name, (p.arguments as Args) || {})));
        } catch (e) {
          reply(request.id, content({ error: e instanceof Error ? e.message : String(e) }, true));
        }
      }
      return;
    }
    if (!notification) error(request.id, -32601, 'Method not found');
  } catch (e) {
    // A line too large, or that isn't JSON, has no id to answer, so it is answered with null.
    if (request === undefined) error(null, -32700, e instanceof Error ? e.message : 'Parse error');
    else if (request.id !== undefined) error(request.id, -32602, e instanceof Error ? e.message : 'Invalid Request');
  }
});
