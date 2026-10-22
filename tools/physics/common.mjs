import { penetration } from './metrics.mjs';
export const DT = 0.05;
const doorQueues = new WeakMap();
export function quantiles(values) {
  const sorted = [...values].sort((a,b) => a-b);
  const at = p => sorted[Math.max(0, Math.ceil(sorted.length * p)-1)] ?? 0;
  return { n: values.length, p50: at(.5), p95: at(.95), p99: at(.99), max: at(1) };
}
// Exact IEEE doubles in a stable JSON representation, without rounding to hide drift.
export function stateText(states) {
  return JSON.stringify(states.map(b => ({id:b.id,x:b.x,y:b.y,vx:b.vx??0,vy:b.vy??0,
    angle:b.angle??0,omega:b.omega??0,sleeping:!!b.sleeping})).sort((a,b)=>a.id.localeCompare(b.id)));
}
export async function digest(text) {
  const bytes = new TextEncoder().encode(text);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
export function actionsAt(world, scenario, tick) {
  let doors=doorQueues.get(world);
  if(!doors){doors={pending:[],deferred:0,closed:0};doorQueues.set(world,doors);}
  for (const action of scenario.actions ?? []) if (action.tick === tick) {
    if(action.method==='closeDoor'){doors.pending.push(action.args[0]);continue;}
    if (typeof world[action.method] !== 'function') throw new Error(`Unsupported action ${action.method}`);
    world[action.method](...(action.args ?? []));
  }
  doors.pending=doors.pending.filter(door=>{
    if(world.states().some(b=>b.kind!=='static'&&penetration(b,door)>0)){doors.deferred++;return true;}
    world.addBody(door);doors.closed++;return false;
  });
}
export function doorStats(world){const d=doorQueues.get(world);return d?{deferred:d.deferred,closed:d.closed,pending:d.pending.length}:null;}
