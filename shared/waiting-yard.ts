import type { Obstacle, ObstacleId, ObstacleKind, PlayableArea, Vec2, World } from './types.ts';
import type { WaitingMap } from './simulation/waiting.ts';

/**
 * The fixed area players wait in before a match starts (#236, 17.3 #15): one hand-made yard, the
 * same for every room. It is a stand-in until a lobby set piece is authored; nothing reads it but the
 * waiting simulation and the renderer, so replacing it changes no match, recording or fixture.
 */
const WIDTH = 1400, HEIGHT = 900, CELL = 100;

const box = (id: string, kind: ObstacleKind, x: World, y: World, w: World, h: World, color?: number): Obstacle =>
  ({ id: id as ObstacleId, kind, x, y, w, h, ...(color === undefined ? {} : { color }) });
const tree = (id: string, x: World, y: World, r: World): Obstacle =>
  ({ id: id as ObstacleId, kind: 'tree', x, y, w: r * 2, h: r * 2, r });

const OBSTACLES: Obstacle[] = [
  // A low wall of containers across the north side, with a gap to walk through.
  box('yard-container-1', 'container', 260, 150, 220, 70, 1),
  box('yard-container-2', 'container', 600, 150, 220, 70, 2),
  box('yard-container-3', 'container', 940, 150, 220, 70, 3),
  // Crates at the edges of the arrival ground.
  box('yard-crate-1', 'crate', 160, 400, 60, 60),
  box('yard-crate-2', 'crate', 1180, 430, 60, 60),
  box('yard-crate-3', 'crate', 680, 590, 50, 50),
  // A hedge and a pipe along the south side.
  box('yard-hedge-1', 'hedge', 200, 700, 300, 30),
  box('yard-pipe-1', 'pipe', 860, 690, 340, 20),
  tree('yard-tree-1', 140, 120, 34),
  tree('yard-tree-2', 1260, 120, 34),
  tree('yard-tree-3', 1250, 780, 30)
];

const AREA: PlayableArea = { cellSize: CELL, rows: Array.from({ length: HEIGHT / CELL }, (_, y) => ({ y, runs: [[0, WIDTH / CELL]] as Array<[number, number]> })) };

// Where people appear as they arrive, in order; more arrivals than places reuse them.
const ARRIVALS: Vec2[] = [];
for (let row = 0; row < 3; row++) for (let col = 0; col < 6; col++) ARRIVALS.push({ x: 330 + col * 150, y: 300 + row * 90 + (col % 2) * 30 });

export function waitingYard(): WaitingMap {
  return structuredClone({
    seed: 1, generator: 'waiting-yard-1', width: WIDTH, height: HEIGHT, playableArea: AREA,
    modules: [], buildings: [], obstacles: OBSTACLES, gates: [], hazards: [], gaps: [], stations: [], chargers: [],
    sensors: [], items: [], traps: [], routes: [], nodes: [], streets: [], spawns: ARRIVALS
  });
}
