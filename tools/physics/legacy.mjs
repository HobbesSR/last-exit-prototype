// Timing control only: the actual legacy movement code, not a third rigid-body solver.
import { moveBody } from '../../shared/movement.ts';

export function createWorld(scene) {
  let bodies = structuredClone(scene.bodies), disposed = false;
  const offset = 20000, size = 40000;
  const map = { width: size, height: size, gates: [], obstacles: [] };
  function geometry() {
    map.obstacles = bodies.filter(b => b.kind === 'static').map(b => ({
      x: b.x + offset - (b.hx ?? b.radius ?? 8), y: b.y + offset - (b.hy ?? b.radius ?? 8),
      w: 2 * (b.hx ?? b.radius ?? 8), h: 2 * (b.hy ?? b.radius ?? 8),
    }));
  }
  function live() { if (disposed) throw new Error('Disposed legacy control'); }
  geometry();
  return {
    settings: { legacy: true, scope: 'Actual moveBody timing only; no dynamics/joints/rotation; circle proxy for props; translated legacy diamond 40000 square' },
    step(dt) { live(); for (const b of bodies) if (b.kind !== 'static') {
      const vx = b.motor?.x ?? b.vx ?? 0, vy = b.motor?.y ?? b.vy ?? 0;
      const speed = Math.hypot(vx, vy), p = { x: b.x + offset, y: b.y + offset };
      moveBody(map, p, { x: speed ? vx / speed : 0, y: speed ? vy / speed : 0 }, b.radius ?? Math.max(b.hx, b.hy), speed * dt);
      b.x = p.x - offset; b.y = p.y - offset;
    } },
    states() { live(); return structuredClone(bodies).sort((a,b) => a.id.localeCompare(b.id)); },
    dispose() { disposed = true; bodies = []; map.obstacles = []; },
    counts() { return { bodies: bodies.length, joints: 0 }; },
  };
}
