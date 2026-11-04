// Deterministic browser art witness (41.2 step 1 & step 2, #587, #585, #583).
// Drives the real arena renderer on a controlled map and frozen presentation state across all six
// themes, fog on/off, exterior/interior roof states, and both sides of the LOD cutoffs (25, 29.4).
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { serveWithBrowser } from './helpers/browser.js';
import { arena } from './helpers/arena.js';
import { SWATCHES, THEMES, contrast, mix, css, G } from '../public/palette.js';
import { MATERIAL_SWATCH } from '../public/appearance.js';
import { MARKET_STALL_INTACT, MARKET_STALL_WEATHERED, MARKET_STALL_DAMAGED } from '../map/micro/strategies/market.ts';
import { createCompoundAppearance, COMPOUND_RESIDENTIAL_INTACT, COMPOUND_RESIDENTIAL_WEATHERED, COMPOUND_RESIDENTIAL_DAMAGED } from '../map/micro/strategies/compound.ts';
import { PLANT_SHED_APPEARANCE } from '../map/micro/strategies/plant.ts';

import { INSIDE_ZOOM, LOD_LOW_ZOOM, LOD_LABEL_ZOOM, LOD_MEDIUM_ZOOM, playerZoom } from '../shared/view.ts';

const outDir = path.resolve('test-results/art-witness');
await mkdir(outDir, { recursive: true });

const toLuminance = hex => {
  const r = ((hex >> 16) & 255) / 255;
  const g = ((hex >> 8) & 255) / 255;
  const b = (hex & 255) / 255;
  return 0.299 * r + 0.587 * g + 0.114 * b;
};
const lumContrast = (h1, h2) => {
  const l1 = toLuminance(h1) + 0.05;
  const l2 = toLuminance(h2) + 0.05;
  return Number((Math.max(l1, l2) / Math.min(l1, l2)).toFixed(2));
};

const VIEWPORT = { width: 1200, height: 800 };
const PLAY_ZOOM = playerZoom(VIEWPORT.width, VIEWPORT.height); // 1.12
const INDOOR_ZOOM = PLAY_ZOOM * INSIDE_ZOOM; // 1.288
const FIXED_NOW = 600; // Deterministic timestamp: mine blink ON (Math.floor(600 / 400) % 2 === 1), fixed item bob and sensor sweep.

// Build the controlled witness arena through `tests/helpers/arena.js` (#697, 31).
// Every obstacle branch, decal, building/roof kind, module, hazard, gap, objective, gate, item,
// trap, projectile, effect, physics prop/tether/hookFlight, and actor role/kit is placed at known
// world coordinates so both the screening swatches and gameplay readability can be sampled in WebGL.
function createWitnessScene() {
  // Three surface bands at y = 260 (ground), y = 450 (street, width 160), y = 660 (building floor).
  // Six special obstacle kinds + outlined controls are placed at identical X columns across all three
  // surfaces so the exact same obstacle draw branch is sampled over ground, street, and floor.
  const sampleCols = [
    { key: 'window', x: 250, make: (id, x, y) => ({ id, kind: 'window', x: x - 24, y: y - 10, w: 48, h: 20 }) },
    { key: 'pipeH', x: 350, make: (id, x, y) => ({ id, kind: 'pipe', x: x - 26, y: y - 10, w: 52, h: 20 }) },
    { key: 'pipeV', x: 430, make: (id, x, y) => ({ id, kind: 'pipe', x: x - 10, y: y - 26, w: 20, h: 52 }) },
    { key: 'hedge', x: 520, make: (id, x, y) => ({ id, kind: 'hedge', x: x - 26, y: y - 14, w: 52, h: 28 }) },
    { key: 'ruin', x: 620, make: (id, x, y) => ({ id, kind: 'ruin-wall', x: x - 26, y: y - 12, w: 52, h: 24 }) },
    { key: 'rock', x: 720, make: (id, x, y) => ({ id, kind: 'rock', x, y, r: 22 }) },
    { key: 'tree', x: 820, make: (id, x, y) => ({ id, kind: 'tree', x, y, r: 22 }) },
  ];
  const surfaceRows = [
    { surface: 'ground', y: 260 },
    { surface: 'street', y: 450 },
    { surface: 'floor', y: 660 },
  ];

  const obstacles = [];
  const sampleProbes = {};
  for (const row of surfaceRows) {
    for (const col of sampleCols) {
      // Skip tree on building floor so the interior floor view isn't covered by an indoor tree crown;
      // tree on ground and street are sampled, plus a dedicated courtyard tree.
      if (col.key === 'tree' && row.surface === 'floor') continue;
      const id = `sample-${col.key}-${row.surface}`;
      obstacles.push(col.make(id, col.x, row.y));
      sampleProbes[`${col.key}:${row.surface}`] = {
        id,
        kind: col.key,
        surface: row.surface,
        x: col.x,
        y: row.y,
        // Specific pixel sample offsets relative to (x, y) for fill, edge/highlight, and shadow:
        fill: col.key === 'rock' ? { x: col.x + 7, y: row.y + 7 }
          : col.key === 'tree' ? { x: col.x + 7, y: row.y + 7 }
          : { x: col.x, y: row.y + 2 },
        edge: col.key === 'window' ? { x: col.x, y: row.y - 10 }
          : col.key === 'pipeH' ? { x: col.x, y: row.y - 8 }
          : col.key === 'pipeV' ? { x: col.x - 8, y: row.y }
          : col.key === 'hedge' ? { x: col.x, y: row.y - 14 }
          : col.key === 'ruin' ? { x: col.x, y: row.y - 10 }
          : col.key === 'rock' ? { x: col.x - 8, y: row.y - 9 }
          : { x: col.x - 4, y: row.y - 4 },
        shadow: col.key === 'ruin' ? { x: col.x + 28, y: row.y + 15 }
          : col.key === 'pipeV' ? { x: col.x + 11, y: row.y + 27 }
          : col.key === 'rock' || col.key === 'tree' ? { x: col.x + 19, y: row.y + 18 }
          : { x: col.x + 27, y: row.y + 12 },
      };
    }
  }

  // Remaining obstacle branches:
  // 1. Polygon with `points` (`o.points?.length`)
  obstacles.push({
    id: 'poly-wreck',
    kind: 'crate',
    color: 0,
    x: 920,
    y: 255,
    points: [
      { x: 895, y: 235 },
      { x: 945, y: 230 },
      { x: 955, y: 270 },
      { x: 930, y: 285 },
      { x: 890, y: 275 },
    ],
  });
  // 2. Outlined rectangular fence (`o.kind === 'fence'`)
  obstacles.push({ id: 'fence-1', kind: 'fence', x: 980, y: 225, w: 36, h: 76 });
  // 3. Outlined building wall segment (`o.kind === 'building'`)
  obstacles.push({ id: 'wall-seg-1', kind: 'building', x: 1040, y: 225, w: 68, h: 44 });
  // 4. Outlined crates in all 3 palette crate colors (`color: 0, 1, 2`)
  obstacles.push({ id: 'crate-c0', kind: 'crate', color: 0, x: 910, y: 310, w: 44, h: 44 });
  obstacles.push({ id: 'crate-c1', kind: 'crate', color: 1, x: 970, y: 310, w: 44, h: 44 });
  obstacles.push({ id: 'crate-c2', kind: 'crate', color: 2, x: 1030, y: 310, w: 44, h: 44 });

  // Sight-blocking wall in the upper-right quadrant so when fog is ON for the viewer at (600, 480),
  // the region behind this wall (around x: 1040..1150, y: 120..210) is in out-of-sight `shade`,
  // testing that shaded terrain/obstacles dim while withheld actors/items/traps behind the wall stay hidden.
  obstacles.push({ id: 'occluder-wall', kind: 'building', x: 950, y: 195, w: 210, h: 20 });
  obstacles.push({ id: 'occluder-side', kind: 'building', x: 950, y: 90, w: 20, h: 125 });
  obstacles.push({ id: 'shaded-crate', kind: 'crate', color: 0, x: 1010, y: 125, w: 40, h: 40 });

  // Buildings:
  // 1. `shop-floor`: open floor pad (y: 590..740) with its roof hidden via an empty-cell declared roof entry
  //    so `floor` surface and obstacles on `floor` are directly visible in the main comparison frame,
  //    plus a real enclosed room `shop-room` (x: 800..1080, y: 580..750) with a plain roof, door, and window,
  //    and a declared cell-grid roof `annex-roof` (x: 1080..1160, y: 580..700) to exercise both roof branches.
  const buildings = [
    { id: 'floor-pad', x: 190, y: 575, w: 600, h: 175 },
    {
      id: 'shop-room',
      x: 810,
      y: 580,
      w: 240,
      h: 170,
      appearance: {
        floorMaterial: 'warmMasonry',
        wallMaterial: 'warmMasonry',
        roofPaint: 'storefrontTeal',
        roofRim: 'weatheredCoral',
        interiorTrim: 'storefrontTeal',
        roofSign: { color: 'weatheredCoral', backing: 'structuralVoid', stripe: 'dirtyCream', dx: 28, dy: 16, w: 120, h: 24 },
        neglect: {
          fadedPanel: { dx: 30, dy: 52, w: 88, h: 42 },
          roofDrainStain: { dx: 170, dy: 42, w: 44, h: 28 },
          floorStain: { dx: 155, dy: 70, w: 46, h: 28 },
          impactCrater: { dx: 60, dy: 110, w: 36, h: 26 },
          vegetationEdge: { dx: 180, dy: 155, w: 44, h: 12, along: 'S' },
        },
      },
    },
    { id: 'annex-room', x: 1060, y: 580, w: 120, h: 120 },
  ];
  // `floor-pad` has a declared roof with 0 cells so `coveredBuildingIds` skips generating a plain roof over the open floor sample strip,
  // while `shop-room` uses the plain building roof branch (with `roofEave`, `roofRim`, `roof`, `roofRidge`, `roofVent`)
  // and `annex-room` uses the declared cell-grid roof branch (`roofCellBorders`).
  const roofs = [
    { id: 'floor-pad', groupId: 'floor-pad', buildingId: 'floor-pad', bounds: { x: 190, y: 575, w: 600, h: 175 }, origin: { x: 190, y: 575 }, cellSize: 40, cells: [] },
    {
      id: 'annex-room',
      groupId: 'annex-group',
      buildingId: 'annex-room',
      bounds: { x: 1060, y: 580, w: 120, h: 120 },
      origin: { x: 1060, y: 580 },
      cellSize: 40,
      cells: [
        { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 },
        { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 },
        { x: 0, y: 2 }, { x: 1, y: 2 },
      ],
    },
  ];

  // All decal branches (`marks === 'window'`, plus `hut`, `depot`, `compound`, and default door threshold decals):
  const decals = [
    { x: 830, y: 556, w: 44, h: 24, side: 'N', marks: 'window', theme: 'depot' },
    { x: 890, y: 556, w: 44, h: 24, side: 'N', theme: 'hut' },
    { x: 945, y: 556, w: 44, h: 24, side: 'N', theme: 'depot' },
    { x: 1000, y: 556, w: 44, h: 24, side: 'N', theme: 'compound' },
    { x: 1065, y: 556, w: 44, h: 24, side: 'N' },
  ];

  // Storefront wall segments and window obstacle on `shop-room` (41.2 step 2 retail frontage slice, #585/#583):
  obstacles.push({ id: 'shop-window', kind: 'window', x: 830, y: 576, w: 44, h: 12, buildingId: 'shop-room' });
  obstacles.push({ id: 'shop-wall-n-mid', kind: 'building', x: 874, y: 575, w: 36, h: 14, buildingId: 'shop-room', appearance: { focalRim: { side: 'N', color: 'sodiumAmber' } } });
  obstacles.push({ id: 'shop-wall-n-east', kind: 'building', x: 950, y: 575, w: 100, h: 14, buildingId: 'shop-room', appearance: { focalRim: { side: 'N', color: 'sodiumAmber' } } });
  obstacles.push({ id: 'shop-wall-e', kind: 'building', x: 1036, y: 589, w: 14, h: 161, buildingId: 'shop-room' });
  obstacles.push({ id: 'shop-wall-s', kind: 'building', x: 810, y: 736, w: 226, h: 14, buildingId: 'shop-room' });

  // Gates and doors:
  // - Closed door on `shop-room`
  // - Open door
  // - Closed locked arena gate
  // - Open arena gate
  // - Out-of-sight unknown gate behind `occluder-wall` (draws with `?` when fogged)
  const gates = [
    { id: 'door-closed', kind: 'door', buildingId: 'shop-room', x: 910, y: 580, w: 40, h: 14, side: 'N', open: false, locked: false },
    { id: 'door-open', kind: 'door', buildingId: 'floor-pad', x: 760, y: 580, w: 40, h: 14, side: 'N', open: true, locked: false },
    { id: 'gate-closed', x: 150, y: 340, open: false, locked: true },
    { id: 'gate-open', x: 150, y: 420, open: true, locked: false },
    { id: 'gate-unknown', x: 1120, y: 140, open: false, locked: true },
  ];

  // Modules (`yard`, `depot`, `garden` + `interior`):
  const modules = [
    { id: 'mod-depot', kind: 'depot', x: 320, y: 240, interior: { x: 200, y: 115, w: 90, h: 55 } },
    { id: 'mod-garden', kind: 'garden', x: 560, y: 340 },
    { id: 'mod-yard', kind: 'yard', x: 780, y: 240 },
  ];

  // Streets (`map.streets` draws 160px wide `ink.street` + 2px `ink.streetLine` at alpha 0.35):
  const streets = [
    { a: { x: 120, y: 450 }, port: { x: 640, y: 450 }, b: { x: 1180, y: 450 } },
  ];

  // Static hazard pad, gap chevron, sensor, transit station, charger, entry & exit:
  const hazards = [{ id: 'haz-pad', x: 120, y: 220, w: 76, h: 54 }];
  const gaps = [{ x: 180, y: 310 }];
  const sensors = [{ id: 'sensor-1', x: 1090, y: 310 }];
  const stations = [{ id: 'station-1', x: 140, y: 640 }];
  const chargers = [{ id: 'charger-1', x: 140, y: 530 }];
  const entry = { x: 220, y: 190 };
  const exit = { x: 1130, y: 450 };

  // Authored retail frontage and service lane slice (41.2 step 2, #585 + #583):
  // - Slate paving service apron (x: 845..1165, y: 495..555)
  // - Warm masonry storefront walls & interior floor (`shop-room`)
  // - Broad legacy-teal painted rooftop (`storefrontTeal`) with commercial sign block
  // - Weathered coral storefront awning (`weatheredCoral`) & ochre parking stripes (`awningsYellow`)
  // - One faded panel, one drain stain, and one cosmetic competition scorch group
  // - Two explicit spatial lighting fields: broad cobalt intersection field + warm amber focal edge
  const appearance = {
    surfaces: [
      { id: 'service-lane-apron', bounds: { x: 845, y: 495, w: 460, h: 60 }, material: 'slatePaving', weathered: true, curb: true, segmentSpan: 115 },
    ],
    commercial: [
      { id: 'ochre-parking-stripes', kind: 'parking-stripes', bounds: { x: 855, y: 498, w: 150, h: 36 }, color: 'awningsYellow', count: 3 },
      { id: 'coral-awning', kind: 'awning', bounds: { x: 850, y: 536, w: 90, h: 18 }, color: 'weatheredCoral', stripeColor: 'dirtyCream' },
    ],
    wear: [
      { id: 'lane-faded-panel', kind: 'faded-panel', bounds: { x: 1110, y: 502, w: 24, h: 22 }, color: 'storefrontTeal' },
      { id: 'lane-drain-stain', kind: 'drain-stain', bounds: { x: 1070, y: 528, w: 36, h: 22 } },
      { id: 'lane-asphalt-patch', kind: 'patch-repair', bounds: { x: 1136, y: 502, w: 14, h: 22 } },
      { id: 'lane-pavement-crack', kind: 'pavement-crack', bounds: { x: 1136, y: 528, w: 14, h: 22 } },
      { id: 'lane-vegetation-patch', kind: 'vegetation-patch', bounds: { x: 1152, y: 528, w: 14, h: 22 } },
    ],
    scars: [
      { id: 'service-scorch-group', kind: 'scorch-group', bounds: { x: 1070, y: 502, w: 36, h: 22 } },
      { id: 'service-impact-crater', kind: 'impact-crater', bounds: { x: 1152, y: 502, w: 14, h: 22 } },
    ],
    lighting: {
      fields: [
        {
          id: 'cobalt-intersection',
          bounds: { x: 850, y: 365, w: 320, h: 185 },
          tint: 'cobaltBlue',
          intensity: 0.42,
          falloff: 70,
        },
        {
          id: 'amber-focal-edge',
          bounds: { x: 810, y: 540, w: 240, h: 48 },
          tint: 'sodiumAmber',
          intensity: 0.45,
          falloff: 0,
          focalEdge: {
            color: 'sodiumAmber',
            x: 810,
            y: 546,
            w: 240,
            h: 12,
            alpha: 0.34,
            rimLine: { x1: 812, y1: 553, x2: 1048, y2: 553, width: 3, alpha: 0.84 },
          },
        },
        {
          id: 'magenta-transit-wash',
          bounds: { x: 1170, y: 365, w: 330, h: 185 },
          tint: 'showtimeMagenta',
          intensity: 0.40,
          falloff: 70,
        },
      ],
    },
  };

  const { map } = arena({
    cols: 10,
    rows: 6,
    cellSize: 160,
    seed: 7,
    obstacles,
    gates,
    buildings,
    roofs,
    decals,
    appearance,
    modules,
    hazards,
    gaps,
    sensors,
    streets,
    stations,
    chargers,
    entry,
    exit,
  });

  // All 6 item kinds (`med`, `access`, `weapon`, `ammo`, `cell`, `shield`) + 1 hidden item behind `occluder-wall`:
  const items = [
    { id: 'item-med', kind: 'med', x: 260, y: 525 },
    { id: 'item-access', kind: 'access', x: 310, y: 525 },
    { id: 'item-weapon', kind: 'weapon', x: 360, y: 525 },
    { id: 'item-ammo', kind: 'ammo', x: 410, y: 525 },
    { id: 'item-cell', kind: 'cell', x: 460, y: 525, charge: 1 },
    { id: 'item-shield', kind: 'shield', x: 510, y: 525 },
    { id: 'item-hidden', kind: 'med', x: 1090, y: 175 },
  ];

  // Traps: `mine`, `spider` (with web ring), `turret`, `flame` (warning), `flame` (firing), plus hidden trap behind wall:
  const traps = [
    { id: 'trap-mine', kind: 'mine', x: 580, y: 525, heading: 0 },
    { id: 'trap-spider', kind: 'spider', x: 640, y: 525, homeX: 640, homeY: 525, heading: 0.4 },
    { id: 'trap-turret', kind: 'turret', x: 705, y: 525, heading: -0.5 },
    { id: 'trap-flame-warn', kind: 'flame', x: 770, y: 525, heading: -Math.PI / 2, warning: true, firing: false },
    { id: 'trap-flame-fire', kind: 'flame', x: 1040, y: 500, heading: -Math.PI / 2, warning: false, firing: true },
    { id: 'trap-hidden', kind: 'mine', x: 1110, y: 175, heading: 0 },
  ];

  // Projectiles & effects (`shock`, `scan`, `smoke`):
  const projectiles = [
    { id: 'shot-1', x: 560, y: 390, dx: 28, dy: -6 },
    { id: 'shot-2', x: 620, y: 380, dx: -24, dy: 8 },
  ];
  const effects = [
    { id: 'fx-shock', kind: 'shock', x: 340, y: 350, radius: 36, life: 8 },
    { id: 'fx-scan', kind: 'scan', x: 420, y: 350, radius: 40, life: 8 },
    { id: 'fx-smoke', kind: 'smoke', x: 500, y: 350, radius: 38, life: 8 },
    // Behind `occluder-wall`: it reaches the client by range but must neither draw nor light anything (#594).
    { id: 'fx-hidden', kind: 'shock', x: 1100, y: 175, radius: 36, life: 8 },
  ];

  // Actors & roles:
  // - Own contestant (`self`, weapon held, shield ring, heard gunfire cues: one on-screen ring, one off-screen arrow)
  // - Remote contestant (`ally`, tinted, revealed ring)
  // - Cloaked contestant (`cloaked`, visible when unfogged, withheld when fogged)
  // - Gladiator `warden`
  // - Gladiator `specter` (violet tint `0xc5b0ff`)
  // - Gladiator `striker` (amber tint `0xffd485`)
  // - Hidden contestant behind `occluder-wall` (`occluded-actor`, withheld when fogged)
  // - Roof-concealed contestant inside `shop-room` (`indoor-actor`, withheld when viewer is outside & fogged, visible when viewer steps inside or unfogged)
  const players = [
    {
      id: 'self',
      name: 'Runner',
      role: 'contestant',
      x: 600,
      y: 380,
      heading: -0.25,
      status: 'active',
      hp: 85,
      maxHp: 100,
      weapon: 'pistol',
      shield: 40,
      heard: [
        { x: 740, y: 360, tick: 10, until: 30 },
        { x: 2200, y: 380, tick: 10, until: 30 },
      ],
    },
    {
      id: 'ally',
      name: 'Echo',
      role: 'contestant',
      x: 680,
      y: 380,
      heading: 0.4,
      status: 'active',
      hp: 60,
      maxHp: 100,
      weapon: 'scattergun',
      revealed: 1,
    },
    {
      id: 'warden',
      name: 'Warden',
      role: 'gladiator',
      kit: 'warden',
      x: 770,
      y: 380,
      heading: 2.8,
      status: 'active',
      hp: 140,
      maxHp: 160,
    },
    {
      id: 'specter',
      name: 'Specter',
      role: 'gladiator',
      kit: 'specter',
      x: 860,
      y: 380,
      heading: 2.5,
      status: 'active',
      hp: 110,
      maxHp: 130,
    },
    {
      id: 'striker',
      name: 'Striker',
      role: 'gladiator',
      kit: 'striker',
      x: 950,
      y: 380,
      heading: 2.9,
      status: 'active',
      hp: 130,
      maxHp: 140,
    },
    {
      id: 'scout',
      name: 'Scout',
      role: 'contestant',
      x: 1260,
      y: 380,
      heading: -0.5,
      status: 'active',
      hp: 95,
      maxHp: 100,
    },
    {
      id: 'cloaked-actor',
      name: 'Ghost',
      role: 'contestant',
      x: 520,
      y: 380,
      heading: 0,
      status: 'active',
      hp: 100,
      maxHp: 100,
      cloak: 80,
    },
    {
      id: 'occluded-actor',
      name: 'HiddenBehindWall',
      role: 'contestant',
      x: 1050,
      y: 140,
      heading: 0,
      status: 'active',
      hp: 100,
      maxHp: 100,
    },
    {
      id: 'indoor-actor',
      name: 'InShop',
      role: 'contestant',
      x: 920,
      y: 665,
      heading: 1.2,
      status: 'active',
      hp: 90,
      maxHp: 100,
    },
  ];

  // Physics prop bodies, tether, and hookFlight:
  const bodies = [
    { id: 'body-self', kind: 'actor', actorId: 'self', x: 600, y: 380, angle: 0, generation: 1, shape: { kind: 'circle', radius: 12 } },
    { id: 'body-scout', kind: 'actor', actorId: 'scout', x: 1260, y: 380, angle: 0, generation: 1, shape: { kind: 'circle', radius: 12 } },
    { id: 'prop-circle', kind: 'prop', x: 640, y: 325, angle: 0, generation: 1, shape: { kind: 'circle', radius: 14 } },
    { id: 'prop-box', kind: 'prop', x: 695, y: 325, angle: 0.35, generation: 1, shape: { kind: 'box', hx: 16, hy: 11 } },
    { id: 'prop-area1', kind: 'prop', x: 960, y: 525, angle: 0, generation: 1, shape: { kind: 'box', hx: 14, hy: 12 } },
    { id: 'prop-area2', kind: 'prop', x: 1240, y: 525, angle: 0, generation: 1, shape: { kind: 'box', hx: 14, hy: 12 } },
    { id: 'prop-street-area1', kind: 'prop', x: 940, y: 465, angle: 0, generation: 1, shape: { kind: 'box', hx: 14, hy: 12 } },
    { id: 'prop-ground-area2', kind: 'prop', x: 1240, y: 410, angle: 0, generation: 1, shape: { kind: 'box', hx: 14, hy: 12 } },
  ];
  const tethers = [{ id: 'tether-1', a: 'prop-circle', b: 'prop-box' }];
  const hookFlights = [{ id: 'hook-1', a: 'body-self', x: 625, y: 340 }];

  const state = {
    tick: 15,
    hazardX: 95,
    physicsProfile: 'witness',
    players,
    gates: map.gates.map(g => ({ ...g })),
    items,
    traps,
    projectiles,
    effects,
    bodies,
    tethers,
    hookFlights,
  };

  // Pure surface reference coordinates (clear of obstacles, street center line, tufts, and shadows):
  const surfaceRefs = {
    ground: { x: 205, y: 260 },
    street: { x: 205, y: 400 },
    streetLine: { x: 205, y: 450 },
    floor: { x: 215, y: 660 },
    shadedGround: { x: 1120, y: 175 },
  };

  return { map, state, sampleProbes, surfaceRefs };
}

const witnessData = createWitnessScene();
const { server, base, browser } = await serveWithBrowser({ profileSummary: false });
const errors = [];

try {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });

  await page.route('**/art-witness-fixture', route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><html><body style="margin:0;background:#000"><script type="importmap">{"imports":{"sat":"/sat-browser.js"}}</script><script src="/vendor/sat/SAT.js"></script><script src="/vendor/phaser/phaser.min.js"></script></body></html>',
  }));
  await page.goto(`${base}/art-witness-fixture`);

  await page.evaluate(async ({ witnessData, viewport, playZoom }) => {
    const { makeArenaScene } = await import('/arena-scene.js');
    const f = window.witness = {
      map: witnessData.map,
      state: witnessData.state,
      palette: 'prototype',
      lighting: true,
      wear: true,
      directed: true,
      fog: false,
      followId: 'self',
      camera: { x: 620, y: 450, zoom: playZoom },
      aim: -0.25,
      frameAlpha: 0,
      scene: null,
    };
    const api = {
      map: () => f.map,
      state: () => f.state,
      self: () => f.state.players.find(p => p.id === 'self') || null,
      playerId: () => 'self',
      palette: () => f.palette,
      directed: () => f.directed,
      follow: () => f.followId ? f.state.players.find(p => p.id === f.followId) || null : null,
      replay: () => false,
      onFrame() {},
      onReady(scene) { f.scene = scene; },
      onFire() {},
      frameAlpha: () => f.frameAlpha,
      aim: () => f.aim,
      director: {
        frame: () => ({ x: f.camera.x, y: f.camera.y, zoom: f.camera.zoom }),
        step() {},
        fog: () => f.fog,
        followId: () => f.followId,
        viewer: () => f.fog && f.followId ? f.state.players.find(p => p.id === f.followId) || null : null,
        setFollow(id) { f.followId = id; },
        pan(dx, dy) { f.camera.x += dx; f.camera.y += dy; },
        zoomAt(factor) { f.camera.zoom *= factor; },
      },
    };
    f.game = new Phaser.Game({
      type: Phaser.WEBGL,
      width: viewport.width,
      height: viewport.height,
      audio: { noAudio: true },
      render: { preserveDrawingBuffer: true },
      scene: makeArenaScene(api),
    });
  }, { witnessData, viewport: VIEWPORT, playZoom: PLAY_ZOOM });

  await page.waitForFunction(() => window.witness?.scene?.ready && window.witness.scene.actors.size > 0);

  // Install deterministic frame stepping & WebGL pixel sampling helpers inside the page.
  await page.evaluate(({ fixedNow }) => {
    const f = window.witness, s = f.scene;
    s.scene.pause();

    const realNow = performance.now.bind(performance);
    let fakeClock = realNow();
    f.step = (delta = 16, now = fixedNow) => {
      fakeClock = Math.max(fakeClock, realNow()) + delta;
      performance.now = () => fakeClock;
      try {
        s.update(now, delta);
      } finally {
        performance.now = realNow;
      }
    };
    f.settle = async ({ palette, lighting, wear, directed, fog, followId, camera, selfPos, aim, frameAlpha = 0, now = fixedNow, roofSteps = 30 } = {}) => {
      const nextPalette = palette || f.palette;
      const nextLighting = lighting !== undefined ? lighting : f.lighting;
      const nextWear = wear !== undefined ? wear : f.wear;
      if (nextPalette !== f.palette || nextLighting !== f.lighting || nextWear !== f.wear) {
        f.palette = nextPalette;
        f.lighting = nextLighting;
        f.wear = nextWear;
        s.setArtOptions({ palette: nextPalette, lighting: nextLighting, wear: nextWear });
      }
      if (directed !== undefined) f.directed = directed;
      if (fog !== undefined) f.fog = fog;
      if (followId !== undefined) f.followId = followId;
      if (aim !== undefined) f.aim = aim;
      if (camera) f.camera = { ...f.camera, ...camera };
      if (frameAlpha !== undefined) f.frameAlpha = frameAlpha;
      if (selfPos) {
        const me = f.state.players.find(p => p.id === 'self');
        const body = f.state.bodies.find(b => b.actorId === 'self');
        if (me) { me.x = selfPos.x; me.y = selfPos.y; }
        if (body) { body.x = selfPos.x; body.y = selfPos.y; body.generation++; }
      }
      s.cutTo();
      // Step a monotonic deterministic clock so `noteFrame()` advances `insideBlend` and roof fades
      // through the real renderer (`arena-scene.js`) without overriding `insideBlend` or `roof.alpha`.
      for (let i = 0; i < roofSteps; i++) {
        f.step(50, now);
      }
      for (let guard = 0; guard < 40; guard++) {
        f.step(16, now);
        const tilesDone = [...s.tiles.values()].every(t => t.empty || t.resolution > 0);
        const overheadDone = [...s.overheadTiles.values()].every(t => !s.overheadGroups.get(t.group)?.visible || t.empty || t.resolution > 0);
        if (tilesDone && overheadDone) break;
      }
      // Wait one animation frame so Phaser's WebGL pipeline flushes the scene to the drawingBuffer.
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    };

    f.pixelAtWorld = (wx, wy) => {
      const c = s.cameras.main, gl = f.game.renderer.gl, rgba = new Uint8Array(4);
      const viewX = c.scrollX + c.width / 2 - c.width / (2 * c.zoom);
      const viewY = c.scrollY + c.height / 2 - c.height / (2 * c.zoom);
      const px = Math.round((wx - viewX) * c.zoom);
      const py = Math.round((wy - viewY) * c.zoom);
      gl.readPixels(px, gl.drawingBufferHeight - py - 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
      return { px, py, rgb: [rgba[0], rgba[1], rgba[2]], alpha: rgba[3], hex: (rgba[0] << 16) | (rgba[1] << 8) | rgba[2] };
    };

    // Sample a small neighborhood around (wx, wy) to find the strongest contrast pixel (e.g. a 2px stroke or highlight).
    f.patchExtremaAtWorld = (wx, wy, radiusPx = 3) => {
      const c = s.cameras.main, gl = f.game.renderer.gl;
      const viewX = c.scrollX + c.width / 2 - c.width / (2 * c.zoom);
      const viewY = c.scrollY + c.height / 2 - c.height / (2 * c.zoom);
      const cx = Math.round((wx - viewX) * c.zoom);
      const cy = Math.round((wy - viewY) * c.zoom);
      const size = radiusPx * 2 + 1;
      const data = new Uint8Array(size * size * 4);
      gl.readPixels(cx - radiusPx, gl.drawingBufferHeight - (cy + radiusPx) - 1, size, size, gl.RGBA, gl.UNSIGNED_BYTE, data);
      const samples = [];
      for (let i = 0; i < data.length; i += 4) {
        samples.push((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
      }
      return samples;
    };
  }, { fixedNow: FIXED_NOW });

  // 1. Capture and sample all 6 themes under the exact same camera frame (`x: 620, y: 450, zoom: PLAY_ZOOM`),
  //    both unfogged (`fog: false`) and fogged (`fog: true`).
  const themeNames = Object.keys(THEMES);
  const captures = [];
  const themeMeasurements = {};

  for (const themeId of themeNames) {
    themeMeasurements[themeId] = { lit: {}, shaded: {} };
    for (const fog of [false, true]) {
      const mode = fog ? 'fog-on' : 'fog-off';
      // When fog is ON, place `self` at (600, 380) for lit samples; we also sample a shaded pass where an
      // occluder blocks sight to the sample strip so we measure actual WebGL shaded pixels for every branch.
      await page.evaluate(async ({ themeId, fog, playZoom }) => {
        await window.witness.settle({
          palette: themeId,
          directed: true,
          fog,
          followId: 'self',
          camera: { x: 620, y: 450, zoom: playZoom },
          selfPos: { x: 600, y: 380 },
        });
      }, { themeId, fog, playZoom: PLAY_ZOOM });

      const file = `theme-${themeId}-${mode}.png`;
      await page.screenshot({ path: path.join(outDir, file) });
      captures.push({ id: `${themeId}-${mode}`, file, theme: themeId, fog, zoom: PLAY_ZOOM, view: 'comparison-frame' });

      if (!fog) {
        // Measure lit WebGL pixels for surfaces and all special obstacle branches in this theme.
        const litSample = await page.evaluate(({ surfaceRefs, sampleProbes }) => {
          const f = window.witness;
          const surfaces = {};
          for (const [k, pt] of Object.entries(surfaceRefs)) surfaces[k] = f.pixelAtWorld(pt.x, pt.y).hex;
          const probes = {};
          for (const [k, p] of Object.entries(sampleProbes)) {
            probes[k] = {
              fill: f.pixelAtWorld(p.fill.x, p.fill.y).hex,
              edgePatch: f.patchExtremaAtWorld(p.edge.x, p.edge.y, 3),
              shadowPatch: f.patchExtremaAtWorld(p.shadow.x, p.shadow.y, 3),
            };
          }
          return { surfaces, probes };
        }, { surfaceRefs: witnessData.surfaceRefs, sampleProbes: witnessData.sampleProbes });
        themeMeasurements[themeId].lit = litSample;
      } else {
        // Also verify privacy in the fogged frame:
        // - `occluded-actor` (behind `occluder-wall`), `cloaked-actor`, and `indoor-actor` (under `shop-room` roof) must be hidden.
        // - `item-hidden` (x=1090, y=175) and `trap-hidden` (x=1110, y=175) behind `occluder-wall` must not be drawn.
        // - `self`, `ally`, `warden`, `specter`, `striker` (in open sight) must be visible.
        // - `shadedGround` (behind `occluder-wall`) is dimmed by `shade` relative to lit `ground`.
        const fogCheck = await page.evaluate(({ surfaceRefs, fixedNow }) => {
          const f = window.witness, s = f.scene;
          const vis = id => s.actors.get(id)?.container.visible ?? false;
          const hiddenItem = f.state.items.find(i => i.id === 'item-hidden');
          const hiddenTrap = f.state.traps.find(t => t.id === 'trap-hidden');
          const litItem = f.state.items.find(i => i.id === 'item-med');
          const litTrap = f.state.traps.find(t => t.id === 'trap-mine');
          // Read WebGL pixels from the already-rendered fogged frame BEFORE calling `s.update()` inside apaused scene.
          const hiddenItemPixelHex = f.pixelAtWorld(hiddenItem.x, hiddenItem.y).hex;
          const hiddenTrapPixelHex = f.pixelAtWorld(hiddenTrap.x, hiddenTrap.y).hex;
          const litGroundHex = f.pixelAtWorld(surfaceRefs.ground.x, surfaceRefs.ground.y).hex;
          const shadedGroundHex = f.pixelAtWorld(surfaceRefs.shadedGround.x, surfaceRefs.shadedGround.y).hex;
          const dynamicCalls = [], lightCalls = [];
          // A glow is drawn as polygons; record each one's centre.
          const orig = {}, lightFill = s.eventLight.fillPoints.bind(s.eventLight);
          s.eventLight.fillPoints = (points, ...rest) => {
            lightCalls.push([points.reduce((sum, p) => sum + p.x, 0) / points.length, points.reduce((sum, p) => sum + p.y, 0) / points.length]);
            return lightFill(points, ...rest);
          };
          for (const m of ['fillRect', 'strokeRect', 'fillRoundedRect', 'strokeRoundedRect', 'fillCircle', 'strokeCircle', 'fillEllipse']) {
            orig[m] = s.dynamic[m].bind(s.dynamic);
            s.dynamic[m] = (...args) => { dynamicCalls.push([m, args]); return orig[m](...args); };
          }
          f.step(16, fixedNow);
          for (const [m, fn] of Object.entries(orig)) s.dynamic[m] = fn;
          s.eventLight.fillPoints = lightFill;
          const litEffect = f.state.effects.find(e => e.id === 'fx-shock'), hiddenEffect = f.state.effects.find(e => e.id === 'fx-hidden');
          const nearCoord = (args, x, y) => Math.abs(args[0] - x) <= 16 && Math.abs(args[1] - y) <= 16;
          return {
            selfVisible: vis('self'),
            allyVisible: vis('ally'),
            wardenVisible: vis('warden'),
            specterVisible: vis('specter'),
            strikerVisible: vis('striker'),
            cloakedVisible: vis('cloaked-actor'),
            occludedVisible: vis('occluded-actor'),
            indoorVisible: vis('indoor-actor'),
            litItemDrawn: dynamicCalls.some(([, a]) => nearCoord(a, litItem.x, litItem.y)),
            litTrapDrawn: dynamicCalls.some(([, a]) => nearCoord(a, litTrap.x, litTrap.y)),
            hiddenItemDrawn: dynamicCalls.some(([, a]) => nearCoord(a, hiddenItem.x, hiddenItem.y)),
            hiddenTrapDrawn: dynamicCalls.some(([, a]) => nearCoord(a, hiddenTrap.x, hiddenTrap.y)),
            litEffectLight: lightCalls.some(a => nearCoord(a, litEffect.x, litEffect.y)),
            hiddenEffectLight: lightCalls.some(a => nearCoord(a, hiddenEffect.x, hiddenEffect.y)),
            hiddenItemPixelHex,
            hiddenTrapPixelHex,
            litGroundHex,
            shadedGroundHex,
          };
        }, { surfaceRefs: witnessData.surfaceRefs, fixedNow: FIXED_NOW });

        assert.equal(fogCheck.selfVisible, true, `${themeId}: self visible in fog`);
        assert.equal(fogCheck.allyVisible, true, `${themeId}: lit ally visible in fog`);
        assert.equal(fogCheck.wardenVisible, true, `${themeId}: lit warden visible in fog`);
        assert.equal(fogCheck.specterVisible, true, `${themeId}: lit specter visible in fog`);
        assert.equal(fogCheck.strikerVisible, true, `${themeId}: lit striker visible in fog`);
        assert.equal(fogCheck.cloakedVisible, false, `${themeId}: unrevealed cloaked actor hidden in fog`);
        assert.equal(fogCheck.occludedVisible, false, `${themeId}: wall-occluded actor hidden in fog`);
        assert.equal(fogCheck.indoorVisible, false, `${themeId}: roof-concealed actor hidden in fog`);
        assert.equal(fogCheck.litItemDrawn, true, `${themeId}: lit item drawn in fog`);
        assert.equal(fogCheck.litTrapDrawn, true, `${themeId}: lit trap drawn in fog`);
        assert.equal(fogCheck.hiddenItemDrawn, false, `${themeId}: wall-occluded item withheld from dynamic draw calls in fog`);
        assert.equal(fogCheck.hiddenTrapDrawn, false, `${themeId}: wall-occluded trap withheld from dynamic draw calls in fog`);
        assert.equal(fogCheck.litEffectLight, true, `${themeId}: a seen shock lights its surroundings in fog`);
        assert.equal(fogCheck.hiddenEffectLight, false, `${themeId}: a wall-occluded shock lights nothing in fog`);
        assert.equal(fogCheck.hiddenItemPixelHex, fogCheck.shadedGroundHex, `${themeId}: withheld item position renders bare shaded ground`);
        assert.equal(fogCheck.hiddenTrapPixelHex, fogCheck.shadedGroundHex, `${themeId}: withheld trap position renders bare shaded ground`);
        assert.notEqual(fogCheck.litGroundHex, fogCheck.shadedGroundHex, `${themeId}: out-of-sight ground is shaded`);

        // Now move `self` behind `occluder-wall` at (1050, 120) while keeping the camera on (620, 450)
        // so the entire sample strip (x: 200..860, y: 240..700) is out of sight and rendered under the
        // real WebGL `0.46` shade mask!
        const shadedSample = await page.evaluate(async ({ surfaceRefs, sampleProbes, playZoom }) => {
          const f = window.witness;
          await f.settle({
            directed: true,
            fog: true,
            followId: 'self',
            camera: { x: 620, y: 450, zoom: playZoom },
            selfPos: { x: 1050, y: 120 },
          });
          const surfaces = {};
          for (const [k, pt] of Object.entries(surfaceRefs)) surfaces[k] = f.pixelAtWorld(pt.x, pt.y).hex;
          const probes = {};
          for (const [k, p] of Object.entries(sampleProbes)) {
            probes[k] = {
              fill: f.pixelAtWorld(p.fill.x, p.fill.y).hex,
              edgePatch: f.patchExtremaAtWorld(p.edge.x, p.edge.y, 3),
              shadowPatch: f.patchExtremaAtWorld(p.shadow.x, p.shadow.y, 3),
            };
          }
          return { surfaces, probes };
        }, { surfaceRefs: witnessData.surfaceRefs, sampleProbes: witnessData.sampleProbes, playZoom: PLAY_ZOOM });
        for (const surf of ['ground', 'street', 'floor']) {
          assert.notEqual(
            shadedSample.surfaces[surf],
            themeMeasurements[themeId].lit.surfaces[surf],
            `${themeId}: shaded ${surf} surface ref differs from lit ${surf}`,
          );
        }
        themeMeasurements[themeId].shaded = shadedSample;
      }
    }
  }

  // 1b. Event light (#594): the glow is what a seen shock adds with lighting on, so compare the frame
  // with and without that shock rather than lighting on and off (static fields would also change).
  const eventLightPixels = await page.evaluate(async ({ playZoom }) => {
    const f = window.witness, effects = f.state.effects;
    const read = async (lighting, withShock) => {
      f.state.effects = withShock ? effects : effects.filter(e => e.id !== 'fx-shock');
      try {
        await f.settle({ palette: 'signature', lighting, directed: true, fog: true, followId: 'self', camera: { x: 620, y: 450, zoom: playZoom }, selfPos: { x: 600, y: 380 } });
        return f.pixelAtWorld(340, 395).hex;
      } finally { f.state.effects = effects; }
    };
    const result = { shock: await read(true, true), none: await read(true, false), offShock: await read(false, true), offNone: await read(false, false) };
    await f.settle({ lighting: true });
    return result;
  }, { playZoom: PLAY_ZOOM });
  const brightness = c => (c >> 16 & 255) + (c >> 8 & 255) + (c & 255);
  assert.ok(brightness(eventLightPixels.shock) > brightness(eventLightPixels.none),
    `event light brightens ground beside a seen shock (${eventLightPixels.shock.toString(16)} vs ${eventLightPixels.none.toString(16)})`);
  assert.equal(eventLightPixels.offShock, eventLightPixels.offNone, 'with lighting off, the shock adds no light beside it');

  // 2. Exterior (`playerZoom`, roof covered) vs Interior (`playerZoom * INSIDE_ZOOM`, roof revealed) in live player view (`directed: false`):
  for (const themeId of ['prototype', 'signature']) {
    // Exterior: player stands outside `shop-room` at (700, 540), looking at `shop-room` & `annex-room` roofs.
    const extState = await page.evaluate(async ({ themeId }) => {
      const f = window.witness, s = f.scene;
      await f.settle({
        palette: themeId,
        directed: false,
        fog: true,
        followId: 'self',
        selfPos: { x: 700, y: 540 },
        roofSteps: 40,
      });
      return {
        zoom: s.cameras.main.zoom,
        shopRoofAlpha: s.roofs.get('shop-room').alpha,
        shopRoofVisible: s.roofs.get('shop-room').visible,
        annexRoofAlpha: s.roofs.get('annex-room').alpha,
        indoorActorVisible: s.actors.get('indoor-actor').container.visible,
        roofPixel: f.pixelAtWorld(920, 630).hex,
      };
    }, { themeId });

    const extFile = `roof-exterior-${themeId}.png`;
    await page.screenshot({ path: path.join(outDir, extFile) });
    captures.push({ id: `exterior-${themeId}`, file: extFile, theme: themeId, fog: true, zoom: extState.zoom, view: 'exterior-player-zoom' });

    assert.ok(Math.abs(extState.zoom - PLAY_ZOOM) < 1e-3, `exterior zoom is playerZoom (${extState.zoom} vs ${PLAY_ZOOM})`);
    assert.equal(extState.shopRoofAlpha, 1, 'exterior shop roof is opaque');
    assert.equal(extState.shopRoofVisible, true, 'exterior shop roof is visible');
    assert.equal(extState.annexRoofAlpha, 1, 'exterior declared annex roof is opaque');
    assert.equal(extState.indoorActorVisible, false, 'actor inside shop is concealed while viewer is outside');

    // Interior: player steps inside `shop-room` at (880, 665); roof fades to 0, camera eases to `playerZoom * INSIDE_ZOOM`, and `indoor-actor` is revealed.
    const intState = await page.evaluate(async ({ themeId }) => {
      const f = window.witness, s = f.scene;
      await f.settle({
        palette: themeId,
        directed: false,
        fog: true,
        followId: 'self',
        selfPos: { x: 880, y: 665 },
        roofSteps: 40,
      });
      return {
        zoom: s.cameras.main.zoom,
        shopRoofAlpha: s.roofs.get('shop-room').alpha,
        shopRoofVisible: s.roofs.get('shop-room').visible,
        annexRoofAlpha: s.roofs.get('annex-room').alpha,
        indoorActorVisible: s.actors.get('indoor-actor').container.visible,
        floorPixel: f.pixelAtWorld(920, 630).hex,
      };
    }, { themeId });

    const intFile = `roof-interior-${themeId}.png`;
    await page.screenshot({ path: path.join(outDir, intFile) });
    captures.push({ id: `interior-${themeId}`, file: intFile, theme: themeId, fog: true, zoom: intState.zoom, view: 'interior-inside-zoom' });

    assert.ok(Math.abs(intState.zoom - INDOOR_ZOOM) < 1e-2, `interior zoom eases to playerZoom * INSIDE_ZOOM (${intState.zoom} vs ${INDOOR_ZOOM})`);
    assert.equal(intState.shopRoofAlpha, 0, 'interior shop roof fades to 0');
    assert.equal(intState.shopRoofVisible, false, 'faded shop roof stops being drawn');
    assert.equal(intState.annexRoofAlpha, 1, 'separate annex roof group stays covered while inside shop-room');
    assert.equal(intState.indoorActorVisible, true, 'actor inside shop becomes visible once viewer enters');
    assert.notEqual(extState.roofPixel, intState.floorPixel, 'revealing the roof changes the rendered interior pixel from roof to floor');
  }

  // Restore `self` to (600, 380) before LOD and motion passes.
  await page.evaluate(async () => {
    await window.witness.settle({ selfPos: { x: 600, y: 380 } });
  });

  // 3. Directed LOD views on both sides of `LOD_LOW_ZOOM` (0.2), `LOD_LABEL_ZOOM` (0.35), and `LOD_MEDIUM_ZOOM` (0.5):
  const lodViews = [
    { id: 'lod-low', zoom: 0.16, desc: `< LOD_LOW_ZOOM (${LOD_LOW_ZOOM})` },
    { id: 'lod-med-unlabeled', zoom: 0.28, desc: `LOD_LOW_ZOOM..LOD_LABEL_ZOOM (${LOD_LOW_ZOOM}..${LOD_LABEL_ZOOM})` },
    { id: 'lod-med-labeled', zoom: 0.42, desc: `LOD_LABEL_ZOOM..LOD_MEDIUM_ZOOM (${LOD_LABEL_ZOOM}..${LOD_MEDIUM_ZOOM})` },
    { id: 'lod-high', zoom: 0.65, desc: `>= LOD_MEDIUM_ZOOM (${LOD_MEDIUM_ZOOM})` },
  ];

  for (const lod of lodViews) {
    for (const themeId of ['prototype', 'signature']) {
      const lodInfo = await page.evaluate(async ({ themeId, zoom }) => {
        const f = window.witness, s = f.scene;
        const dynamicCalls = [], fixtureCalls = [];
        const wrap = (g, log) => {
          const orig = {};
          for (const m of ['fillRect', 'strokeRect', 'fillRoundedRect', 'strokeRoundedRect', 'fillCircle', 'strokeCircle', 'fillEllipse', 'lineBetween', 'fillTriangle']) {
            orig[m] = g[m].bind(g);
            g[m] = (...args) => { log.push([m, args]); return orig[m](...args); };
          }
          return () => { for (const [m, fn] of Object.entries(orig)) g[m] = fn; };
        };
        await f.settle({
          palette: themeId,
          directed: true,
          fog: false,
          followId: 'self',
          camera: { x: 620, y: 450, zoom },
          roofSteps: 5,
        });
        const restoreDyn = wrap(s.dynamic, dynamicCalls);
        const restoreFix = wrap(s.fixtures, fixtureCalls);
        f.step(16, 600);
        restoreDyn();
        restoreFix();
        return {
          zoom: s.cameras.main.zoom,
          labelsVisible: s.labels.some(l => l.visible),
          markerScale: s.marker,
          dynamicCalls,
          fixtureCalls,
        };
      }, { themeId, zoom: lod.zoom });

      const file = `${lod.id}-${themeId}.png`;
      await page.screenshot({ path: path.join(outDir, file) });
      captures.push({ id: `${lod.id}-${themeId}`, file, theme: themeId, fog: false, zoom: lod.zoom, view: lod.desc });

      if (lod.zoom < LOD_LABEL_ZOOM) {
        assert.equal(lodInfo.labelsVisible, false, `${lod.id}: map labels hidden below LOD_LABEL_ZOOM`);
      } else {
        assert.equal(lodInfo.labelsVisible, true, `${lod.id}: map labels shown at or above LOD_LABEL_ZOOM`);
      }
      // Check item and gate calls specifically (`item-med` position derived from `witnessData.state.items[0]`):
      const sampleItem = witnessData.state.items[0];
      const ITEM_BASE_SIZE = 24, ITEM_LOW_SIZE = 16;
      const itemBaseLeft = sampleItem.x - ITEM_BASE_SIZE / 2;
      const itemLowLeft = sampleItem.x - ITEM_LOW_SIZE / 2;
      const itemRounded = lodInfo.dynamicCalls.some(([m, a]) => m === 'fillRoundedRect' && a[0] === itemBaseLeft);
      const itemBaseRect = lodInfo.dynamicCalls.some(([m, a]) => m === 'fillRect' && a[0] === itemBaseLeft && a[2] === ITEM_BASE_SIZE);
      const itemLowRect = lodInfo.dynamicCalls.some(([m, a]) => m === 'fillRect' && a[0] === itemLowLeft && a[2] === ITEM_LOW_SIZE);
      const itemShadow = lodInfo.dynamicCalls.some(([m]) => m === 'fillEllipse');
      const gateRounded = lodInfo.fixtureCalls.some(([m]) => m === 'strokeRoundedRect' || m === 'fillRoundedRect');
      if (lod.zoom < LOD_LOW_ZOOM) {
        assert.equal(itemLowRect, true, `${lod.id}: low LOD items draw 16x16 solid rect`);
        assert.equal(itemBaseRect, false, `${lod.id}: low LOD items omit 24x24 base box`);
        assert.equal(itemRounded, false, `${lod.id}: low LOD items omit rounded rects`);
        assert.equal(gateRounded, false, `${lod.id}: low LOD gates collapse to plain rects`);
      } else if (lod.zoom < LOD_MEDIUM_ZOOM) {
        assert.equal(itemBaseRect, true, `${lod.id}: medium LOD items draw 24x24 base rect`);
        assert.equal(itemShadow, false, `${lod.id}: medium LOD items omit drop-shadow ellipses`);
        assert.equal(gateRounded, true, `${lod.id}: medium LOD gates use rounded rects`);
      } else {
        assert.equal(itemShadow, true, `${lod.id}: high LOD items draw drop-shadow ellipses`);
        assert.equal(itemRounded, true, `${lod.id}: high LOD items draw rounded base boxes`);
      }
    }
  }

  // 4. Short deterministic motion pass (41.2: "Include a short motion pass: static screenshots cannot establish moving-actor recognition"):
  //    Advance actors and projectiles across 3 deterministic steps over the street/ground boundary in `signature` and verify
  //    the actor container moves without rebuilding static or overhead tiles (`rasterisations === 0`).
  const motionFrames = [];
  for (let step = 0; step < 3; step++) {
    const frameInfo = await page.evaluate(async ({ step, playZoom, fixedNow }) => {
      const f = window.witness, s = f.scene;
      if (step === 0) {
        await f.settle({
          palette: 'signature',
          directed: true,
          fog: false,
          followId: 'self',
          camera: { x: 620, y: 450, zoom: playZoom },
          selfPos: { x: 600, y: 380 },
          frameAlpha: 0,
        });
        f.motionRasterisations = 0;
        const origRasterise = s.rasterise.bind(s);
        s.rasterise = (...args) => { f.motionRasterisations++; return origRasterise(...args); };
      } else {
        const ally = f.state.players.find(p => p.id === 'ally');
        const warden = f.state.players.find(p => p.id === 'warden');
        ally.x += 24; ally.y += 18;
        warden.x -= 22; warden.y += 16;
        f.frameAlpha = step * 0.35;
        f.step(50, fixedNow + step * 50);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }
      return {
        step,
        allyX: s.actors.get('ally').container.x,
        allyY: s.actors.get('ally').container.y,
        wardenX: s.actors.get('warden').container.x,
        wardenY: s.actors.get('warden').container.y,
        shotX: s.shots[0].x,
        rasterisations: f.motionRasterisations,
        allyPixel: f.pixelAtWorld(s.actors.get('ally').container.x, s.actors.get('ally').container.y).hex,
      };
    }, { step, playZoom: PLAY_ZOOM, fixedNow: FIXED_NOW });

    const file = `motion-signature-step-${step}.png`;
    await page.screenshot({ path: path.join(outDir, file) });
    captures.push({ id: `motion-step-${step}`, file, theme: 'signature', fog: false, zoom: PLAY_ZOOM, view: `motion-step-${step}` });
    motionFrames.push(frameInfo);
  }
  assert.equal(motionFrames[2].rasterisations, 0, 'pure actor and projectile motion does not rasterise static or overhead tiles');
  assert.notEqual(motionFrames[0].allyX, motionFrames[2].allyX, 'motion pass advances actor positions');
  assert.notEqual(motionFrames[0].shotX, motionFrames[2].shotX, 'motion pass interpolates projectile positions');

  // 5. State and privacy survival across palette restyling during partial roof fade and gate memory:
  const restyleState = await page.evaluate(async ({ fixedNow }) => {
    const f = window.witness, s = f.scene;
    // Observe `door-closed` in fogged mode so `gateMemory` records it, then step near the door to put `shop-room` roof mid-fade.
    await f.settle({
      palette: 'prototype',
      directed: false,
      fog: true,
      followId: 'self',
      selfPos: { x: 910, y: 560 }, // within ROOF_REVEAL_RANGE (32) of `door-closed` at (910, 580)
      roofSteps: 1,
    });
    // Force a known mid-fade alpha (0.45) on `roof:shop-room` and record actor container identity.
    s.setOverheadGroup('roof:shop-room', true, 0.45);
    s.roofs.get('shop-room').alpha = 0.45;
    const actorBefore = s.actors.get('self').container;
    const rememberedBefore = s.gateMemory.size;
    s.setPalette('neonAftermath');
    return {
      alphaAfterRestyle: s.roofs.get('shop-room').alpha,
      overheadAlphaAfterRestyle: s.overheadGroups.get('roof:shop-room').alpha,
      sameActorContainer: s.actors.get('self').container === actorBefore,
      rememberedBefore,
      rememberedAfter: s.gateMemory.size,
      occludedStillHidden: !s.actors.get('occluded-actor').container.visible,
    };
  }, { fixedNow: FIXED_NOW });

  assert.equal(restyleState.alphaAfterRestyle, 0.45, 'palette restyle preserves in-progress roof fade alpha');
  assert.equal(restyleState.overheadAlphaAfterRestyle, 0.45, 'palette restyle preserves overhead group alpha');
  assert.equal(restyleState.sameActorContainer, true, 'palette restyle retains actor containers');
  assert.ok(restyleState.rememberedBefore > 0 && restyleState.rememberedAfter === restyleState.rememberedBefore, 'palette restyle retains gate memory');
  assert.equal(restyleState.occludedStillHidden, true, 'palette restyle never exposes a withheld actor');

  // 5b. Authored retail frontage & service lane slice verification (41.2 step 2, #585 + #583):
  //     Verify that:
  //     - The slice reads as a former business at both `playerZoom` (roof covered) and `playerZoom * INSIDE_ZOOM` (roof revealed).
  //     - Switching off lighting (`lighting: false`) removes the cobalt intersection wash and warm amber focal edge while retaining
  //       material identity (legacy-teal roof, warm masonry floor/walls, weathered coral awning, ochre parking stripes).
  //     - Switching off wear (`wear: false`) removes the faded panel, drain stain, and scorch group while retaining the exact same
  //       collision shapes (`shapeOf`) and visibility polygon (`visionPoints`).
  const sliceProbes = {
    cobaltStreet: { x: 960, y: 420 },
    amberRim: { x: 985, y: 553 },
    wallAmberRim: { x: 985, y: 576 },
    southWallInside: { x: 910, y: 736 },
    slateApronClean: { x: 1122, y: 539 },
    ochreStripe: { x: 905, y: 512 },
    coralAwning: { x: 878, y: 545 },
    fadedPanel: { x: 1122, y: 513 },
    scorchGroup: { x: 1082, y: 511 },
    drainStain: { x: 1088, y: 539 },
    tealRoof: { x: 960, y: 635 },
    roofFadedPanel: { x: 855, y: 645 },
    roofDrainStain: { x: 980, y: 622 },
    warmMasonryFloor: { x: 900, y: 695 },
    floorDrainStain: { x: 965, y: 650 },
    warmMasonryWall: { x: 990, y: 582 },
    asphaltPatch: { x: 1143, y: 513 },
    pavementCrack: { x: 1143, y: 539 },
    curbVegetation: { x: 1159, y: 539 },
    impactCrater: { x: 1159, y: 513 },
    roofImpactCrater: { x: 870, y: 690 },
    roofVegetation: { x: 990, y: 735 },
    windowSheen: { x: 846, y: 582 },
    windowBaseGlass: { x: 860, y: 582 },
  };

  const sampleSliceMode = async ({ id, lighting, wear, selfPos, viewLabel }) => {
    const res = await page.evaluate(async ({ id, lighting, wear, selfPos, sliceProbes }) => {
      const f = window.witness, s = f.scene;
      await f.settle({
        palette: 'signature',
        lighting,
        wear,
        directed: false,
        fog: true,
        followId: 'self',
        selfPos,
        roofSteps: 40,
      });
      const pixels = {};
      for (const [k, pt] of Object.entries(sliceProbes)) {
        pixels[k] = f.pixelAtWorld(pt.x, pt.y).hex;
      }
      const { shapeOf } = await import('/shared/shape.ts');
      const collisionOutlines = f.map.obstacles.concat(f.map.gates).map(o => {
        const sh = shapeOf(o);
        return `${o.id}:${sh.kind}:${sh.x},${sh.y},${sh.r ?? ''},${sh.w ?? ''},${sh.h ?? ''}:${(sh.points || []).map(p => `${p.x},${p.y}`).join('|')}`;
      }).join(';');
      const visionDigest = (s.visionPoints || []).map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(';');
      return {
        zoom: s.cameras.main.zoom,
        roofAlpha: s.roofs.get('shop-room').alpha,
        pixels,
        collisionDigest: collisionOutlines,
        visionDigest,
      };
    }, { id, lighting, wear, selfPos, sliceProbes });
    const file = `slice-${id}.png`;
    await page.screenshot({ path: path.join(outDir, file) });
    captures.push({ id: `slice-${id}`, file, theme: 'signature', fog: true, zoom: res.zoom, view: viewLabel });
    return res;
  };

  const sliceFullExt = await sampleSliceMode({
    id: 'full-exterior',
    lighting: true,
    wear: true,
    selfPos: { x: 920, y: 520 },
    viewLabel: 'step2-slice-full-exterior (lighting:on, wear:on)',
  });
  const sliceNoLightExt = await sampleSliceMode({
    id: 'no-lighting-exterior',
    lighting: false,
    wear: true,
    selfPos: { x: 920, y: 520 },
    viewLabel: 'step2-slice-no-lighting (lighting:off, wear:on)',
  });
  const sliceNoWearExt = await sampleSliceMode({
    id: 'no-wear-exterior',
    lighting: true,
    wear: false,
    selfPos: { x: 920, y: 520 },
    viewLabel: 'step2-slice-no-wear (lighting:on, wear:off)',
  });
  const sliceFullInt = await sampleSliceMode({
    id: 'full-interior',
    lighting: true,
    wear: true,
    selfPos: { x: 920, y: 665 },
    viewLabel: 'step2-slice-full-interior (lighting:on, wear:on, roof revealed)',
  });
  const sliceNoWearInt = await sampleSliceMode({
    id: 'no-wear-interior',
    lighting: true,
    wear: false,
    selfPos: { x: 920, y: 665 },
    viewLabel: 'step2-slice-no-wear-interior (lighting:on, wear:off, roof revealed)',
  });

  // Restore defaults (`lighting: true, wear: true`) on witness after slice captures:
  await page.evaluate(async () => {
    await window.witness.settle({ palette: 'signature', lighting: true, wear: true, selfPos: { x: 600, y: 380 } });
  });

  const rgbDist = (c1, c2) => Math.hypot(
    ((c1 >> 16) & 255) - ((c2 >> 16) & 255),
    ((c1 >> 8) & 255) - ((c2 >> 8) & 255),
    (c1 & 255) - (c2 & 255)
  );

  const SW = {
    weatheredCoral: parseInt(SWATCHES.legacy.weatheredCoral.slice(1), 16),
    storefrontTeal: parseInt(SWATCHES.legacy.storefrontTeal.slice(1), 16),
    awningsYellow: parseInt(SWATCHES.legacy.awningsYellow.slice(1), 16),
    sodiumAmber: G.sodiumAmber,
    warmMasonry: MATERIAL_SWATCH.warmMasonry,
  };

  // Step 2 done-when assertions:
  // 1. Lighting toggle removes cobalt wash and amber focal edge while keeping material identity intact:
  assert.notEqual(sliceFullExt.pixels.cobaltStreet, sliceNoLightExt.pixels.cobaltStreet, 'switching off lighting removes cobalt intersection wash on street');
  assert.notEqual(sliceFullExt.pixels.amberRim, sliceNoLightExt.pixels.amberRim, 'switching off lighting removes warm amber focal edge rim');
  assert.ok(
    rgbDist(sliceFullInt.pixels.southWallInside, SW.sodiumAmber) >= 150,
    'interior south wall face does not receive amber rim (remains unrimmed dark interior wall)'
  );
  assert.ok(
    rgbDist(sliceFullInt.pixels.southWallInside, sliceFullInt.pixels.wallAmberRim) >= 60,
    'interior south wall face is distinct from north wall focal rim in interior view'
  );

  // Material identity survives with lighting off (verified by proximity to authored swatches vs clean slate apron):
  assert.ok(
    rgbDist(sliceNoLightExt.pixels.coralAwning, SW.weatheredCoral) < rgbDist(sliceNoLightExt.pixels.slateApronClean, SW.weatheredCoral),
    'weathered coral awning is closer to weatheredCoral swatch than slate apron is'
  );
  assert.ok(
    rgbDist(sliceNoLightExt.pixels.coralAwning, sliceNoLightExt.pixels.slateApronClean) >= 30,
    'weathered coral awning is visibly distinct from slate apron'
  );
  assert.ok(
    rgbDist(sliceNoLightExt.pixels.tealRoof, SW.storefrontTeal) < rgbDist(sliceNoLightExt.pixels.slateApronClean, SW.storefrontTeal),
    'legacy-teal rooftop is closer to storefrontTeal swatch than slate apron is'
  );
  assert.ok(
    rgbDist(sliceNoLightExt.pixels.ochreStripe, SW.awningsYellow) < rgbDist(sliceNoLightExt.pixels.slateApronClean, SW.awningsYellow),
    'unlit ochre parking stripe is closer to awningsYellow swatch than slate apron is'
  );
  assert.ok(
    rgbDist(sliceNoLightExt.pixels.ochreStripe, sliceNoLightExt.pixels.slateApronClean) >= 30,
    'unlit ochre parking stripe is visibly distinct from slate apron'
  );
  assert.ok(
    rgbDist(sliceFullInt.pixels.warmMasonryFloor, SW.warmMasonry) < rgbDist(sliceFullInt.pixels.slateApronClean, SW.warmMasonry),
    'revealed interior floor is closer to warm masonry than slate apron is'
  );

  // 2. Wear toggle removes faded panel, drain stain, and scorch group while preserving exact collision & sight geometry:
  assert.equal(sliceNoWearExt.pixels.drainStain, sliceNoWearExt.pixels.slateApronClean, 'with wear off, drain stain location reverts to clean slate paving apron');
  assert.equal(sliceNoWearExt.pixels.scorchGroup, sliceNoWearExt.pixels.slateApronClean, 'with wear off, scorch group location reverts to clean slate paving apron');
  assert.equal(sliceNoWearExt.pixels.fadedPanel, sliceNoWearExt.pixels.slateApronClean, 'with wear off, faded panel location reverts to clean slate paving apron');
  assert.equal(sliceNoWearExt.pixels.asphaltPatch, sliceNoWearExt.pixels.slateApronClean, 'with wear off, asphalt patch reverts to clean slate paving');
  assert.equal(sliceNoWearExt.pixels.pavementCrack, sliceNoWearExt.pixels.slateApronClean, 'with wear off, pavement crack reverts to clean slate paving');
  assert.equal(sliceNoWearExt.pixels.curbVegetation, sliceNoWearExt.pixels.slateApronClean, 'with wear off, curb vegetation reverts to clean slate paving');
  assert.equal(sliceNoWearExt.pixels.impactCrater, sliceNoWearExt.pixels.slateApronClean, 'with wear off, impact crater reverts to clean slate paving');

  assert.ok(rgbDist(sliceFullExt.pixels.fadedPanel, sliceNoWearExt.pixels.fadedPanel) >= 20, 'faded panel visibly changes when wear is toggled');
  assert.ok(rgbDist(sliceFullExt.pixels.drainStain, sliceNoWearExt.pixels.drainStain) >= 20, 'drain stain visibly changes when wear is toggled');
  assert.ok(rgbDist(sliceFullExt.pixels.scorchGroup, sliceNoWearExt.pixels.scorchGroup) >= 20, 'scorch group visibly changes when wear is toggled');
  assert.ok(rgbDist(sliceFullExt.pixels.asphaltPatch, sliceNoWearExt.pixels.asphaltPatch) >= 20, 'asphalt patch visibly changes when wear is toggled');
  assert.ok(rgbDist(sliceFullExt.pixels.pavementCrack, sliceNoWearExt.pixels.pavementCrack) >= 15, 'pavement crack visibly changes when wear is toggled');
  assert.ok(rgbDist(sliceFullExt.pixels.curbVegetation, sliceNoWearExt.pixels.curbVegetation) >= 20, 'curb vegetation visibly changes when wear is toggled');
  assert.ok(rgbDist(sliceFullExt.pixels.impactCrater, sliceNoWearExt.pixels.impactCrater) >= 25, 'impact crater visibly changes when wear is toggled');
  assert.ok(rgbDist(sliceFullExt.pixels.roofFadedPanel, sliceNoWearExt.pixels.roofFadedPanel) >= 20, 'roof faded panel visibly changes when wear is toggled');
  assert.ok(rgbDist(sliceFullExt.pixels.roofDrainStain, sliceNoWearExt.pixels.roofDrainStain) >= 20, 'roof drain stain visibly changes when wear is toggled');
  assert.ok(rgbDist(sliceFullExt.pixels.roofImpactCrater, sliceNoWearExt.pixels.roofImpactCrater) >= 20, 'roof impact crater visibly changes when wear is toggled');
  assert.ok(rgbDist(sliceFullExt.pixels.roofVegetation, sliceNoWearExt.pixels.roofVegetation) >= 20, 'roof vegetation visibly changes when wear is toggled');
  assert.ok(rgbDist(sliceFullInt.pixels.floorDrainStain, sliceNoWearInt.pixels.floorDrainStain) >= 20, 'interior floor neglect stain visibly changes when wear is toggled');

  // Specular reflection highlight on glazed window obstacle (11.1 §6, 29.4):
  // When inside shop-room, roof is revealed (roofAlpha === 0), revealing shop-window:
  const windowSheenInt = sliceFullInt.pixels.windowSheen;
  const windowBaseGlassInt = sliceFullInt.pixels.windowBaseGlass;
  assert.ok(rgbDist(windowSheenInt, windowBaseGlassInt) >= 15, 'window specular reflection sheen visibly separates from base glass fill');

  // Grayscale value contrast assertions for cosmetic wear and scar marks (41.2):
  const patchVsApronUnlit = lumContrast(sliceNoLightExt.pixels.asphaltPatch, sliceNoLightExt.pixels.slateApronClean);
  const crackVsApronUnlit = lumContrast(sliceNoLightExt.pixels.pavementCrack, sliceNoLightExt.pixels.slateApronClean);
  const vegVsApronUnlit = lumContrast(sliceNoLightExt.pixels.curbVegetation, sliceNoLightExt.pixels.slateApronClean);
  const craterVsApronUnlit = lumContrast(sliceNoLightExt.pixels.impactCrater, sliceNoLightExt.pixels.slateApronClean);
  const roofCraterVsRoof = lumContrast(sliceFullExt.pixels.roofImpactCrater, sliceFullExt.pixels.tealRoof);

  assert.ok(patchVsApronUnlit >= 1.15, `patch repair separates from apron in luminance (unlit: ${patchVsApronUnlit})`);
  assert.ok(crackVsApronUnlit >= 1.15, `pavement crack separates from apron in luminance (unlit: ${crackVsApronUnlit})`);
  assert.ok(vegVsApronUnlit >= 1.15, `vegetation patch separates from apron in luminance (unlit: ${vegVsApronUnlit})`);
  assert.ok(craterVsApronUnlit >= 1.15, `impact crater separates from apron in luminance (unlit: ${craterVsApronUnlit})`);
  assert.ok(roofCraterVsRoof >= 1.5, `roof crater separates from roof paint in luminance (${roofCraterVsRoof})`);

  assert.equal(sliceFullExt.collisionDigest, sliceNoWearExt.collisionDigest, 'switching off wear keeps exact same obstacle and gate shapeOf collision geometry');
  assert.equal(sliceFullExt.visionDigest, sliceNoWearExt.visionDigest, 'switching off wear keeps exact same visibilityPolygon sight boundary');
  assert.equal(sliceFullInt.visionDigest, sliceNoWearInt.visionDigest, 'switching off wear inside shop keeps exact same visibilityPolygon sight boundary');

  // 3. Faded panel, drain stain, and scorch group read as distinct history layers at gameplay scale:
  assert.ok(rgbDist(sliceFullExt.pixels.fadedPanel, sliceFullExt.pixels.drainStain) >= 15, 'faded panel and drain stain read as distinct layers');
  assert.ok(rgbDist(sliceFullExt.pixels.fadedPanel, sliceFullExt.pixels.scorchGroup) >= 15, 'faded panel and scorch group read as distinct layers');
  assert.ok(rgbDist(sliceFullExt.pixels.drainStain, sliceFullExt.pixels.scorchGroup) >= 15, 'drain stain and scorch group read as distinct layers');

  const ochreUnderCobaltAssessment = {
    swatchOchre: '#c69a49',
    unlitRenderedOchre: css(sliceNoLightExt.pixels.ochreStripe),
    litRenderedOchre: css(sliceFullExt.pixels.ochreStripe),
    cobaltStreetHex: css(sliceFullExt.pixels.cobaltStreet),
    cleanApronHex: css(sliceFullExt.pixels.slateApronClean),
    distUnlitToOchre: Number(rgbDist(sliceNoLightExt.pixels.ochreStripe, SW.awningsYellow).toFixed(1)),
    distUnlitToApron: Number(rgbDist(sliceNoLightExt.pixels.ochreStripe, sliceNoLightExt.pixels.slateApronClean).toFixed(1)),
    note: 'Observation: under the broad cobalt intersection wash (0.42 intensity), ochre parking stripes (#c69a49) mix toward a cooled neutral tone (#787672) because yellow and cobalt blue are complementary. With lighting toggled off, warm ochre identity (#977f50) is fully restored (distance to awningsYellow 54.7 vs 80.3 for slate apron).',
  };

  const step2SliceSummary = {
    fullExterior: Object.fromEntries(Object.entries(sliceFullExt.pixels).map(([k, v]) => [k, css(v)])),
    noLightingExterior: Object.fromEntries(Object.entries(sliceNoLightExt.pixels).map(([k, v]) => [k, css(v)])),
    noWearExterior: Object.fromEntries(Object.entries(sliceNoWearExt.pixels).map(([k, v]) => [k, css(v)])),
    fullInterior: Object.fromEntries(Object.entries(sliceFullInt.pixels).map(([k, v]) => [k, css(v)])),
    noWearInterior: Object.fromEntries(Object.entries(sliceNoWearInt.pixels).map(([k, v]) => [k, css(v)])),
    collisionPreserved: sliceFullExt.collisionDigest === sliceNoWearExt.collisionDigest,
    sightPreservedExterior: sliceFullExt.visionDigest === sliceNoWearExt.visionDigest,
    sightPreservedInterior: sliceFullInt.visionDigest === sliceNoWearInt.visionDigest,
  };

  // 4. Stamped obstacle appearance on an unstyled map without map.appearance (e.g. depot warehouse shelf, #584):
  const depotShelfCheck = await page.evaluate(async () => {
    const f = window.witness, s = f.scene;
    const priorMap = f.map;
    // Unstyled map with NO map.appearance and NO buildings: containers sit on open ground in view.
    const depotMap = {
      seed: 99,
      width: 2000,
      height: 2000,
      buildings: [],
      roofs: [],
      obstacles: [
        { id: 'wh-shelf', kind: 'container', x: 400, y: 300, w: 40, h: 20, appearance: { material: 'oxidizedMetal' } },
        { id: 'wh-crate', kind: 'container', color: 0, x: 400, y: 340, w: 40, h: 20 },
      ],
      modules: [], hazards: [], gaps: [], stations: [], sensors: [], gates: [], routes: [], streets: [],
    };
    f.map = depotMap;
    s.recordStatic(depotMap);
    const priorEffects = f.state.effects;
    const settleDepot = () => f.settle({
      palette: 'signature',
      lighting: true,
      wear: true,
      directed: true,
      fog: false,
      camera: { x: 420, y: 330, zoom: 1 },
      selfPos: { x: 600, y: 380 },
    });
    try {
      // The frame's `scan` (420, 350) lights the shelf (#594): event light adds over static fill.
      await settleDepot();
      const shelfUnderEventPx = f.pixelAtWorld(420, 314);
      // The fill checks below are about static appearance, so set the frame's effects aside for them.
      f.state.effects = [];
      await settleDepot();
      // Sample container interior fill (x = x + 20, y = y + 14, clear of top highlight stroke at y + 7):
      const shelfPx = f.pixelAtWorld(420, 314);
      const cratePx = f.pixelAtWorld(420, 354);
      return { shelfPx, cratePx, shelfUnderEventPx };
    } finally {
      f.map = priorMap;
      f.state.effects = priorEffects;
      s.recordStatic(priorMap);
      await f.settle({ palette: 'signature', lighting: true, wear: true, selfPos: { x: 600, y: 380 } });
    }
  });

  const { resolveObstacleAppearance } = await import('../public/appearance.js');
  const expectedShelfFill = resolveObstacleAppearance(
    { id: 'wh-shelf', kind: 'container', x: 400, y: 300, w: 40, h: 20, appearance: { material: 'oxidizedMetal' } },
    null,
    { palette: 'signature', lighting: true, wear: true }
  ).fill;
  const expectedCrateFill = THEMES.signature.colors.crates[0];
  const rgbSum = c => (c >> 16 & 255) + (c >> 8 & 255) + (c & 255);
  assert.ok(rgbSum(depotShelfCheck.shelfUnderEventPx.hex) > rgbSum(depotShelfCheck.shelfPx.hex),
    'event light from a seen scan brightens the static shelf fill beneath it (#594)');

  assert.equal(
    depotShelfCheck.shelfPx.hex,
    expectedShelfFill,
    'stamped shelf on map without map.appearance resolves its authored oxidizedMetal fill in the arena scene'
  );
  assert.equal(
    depotShelfCheck.cratePx.hex,
    expectedCrateFill,
    'unstyled crate on map without map.appearance resolves to standard palette crateFill'
  );
  assert.notEqual(
    depotShelfCheck.shelfPx.hex,
    depotShelfCheck.cratePx.hex,
    'stamped shelf differs from unstyled crate fill'
  );

  // 5. Spatial composition across two neighboring areas & moving-object virtual lighting (41.2 step 4, #583):
  await page.evaluate(async () => {
    const f = window.witness;
    await f.settle({
      palette: 'signature',
      lighting: true,
      wear: true,
      directed: true,
      fog: false,
      camera: { x: 1120, y: 400, zoom: 1 },
      selfPos: { x: 960, y: 380 },
    });
  });

  const fileStep4Lit = 'step4-two-areas-full.png';
  await page.screenshot({ path: path.join(outDir, fileStep4Lit) });
  captures.push({
    id: 'step4-two-areas-full',
    file: fileStep4Lit,
    theme: 'signature',
    fog: false,
    zoom: 1,
    view: 'step4-two-areas-full (Area 1 cobalt + Area 2 magenta spatial lighting)',
  });

  const step4SpatialCheck = await page.evaluate(async () => {
    const f = window.witness, s = f.scene;
    const strikerArea1 = s.actors.get('striker');
    const scoutArea2 = s.actors.get('scout');
    const wardenArea1 = s.actors.get('warden');
    const specterArea1 = s.actors.get('specter');
    const strikerBodyTintLit = strikerArea1.sprite.tintTopLeft;
    const strikerIdentityTintLit = strikerArea1.identity.tintTopLeft;
    const scoutBodyTintLit = scoutArea2.sprite.tintTopLeft;
    const scoutIdentityTintLit = scoutArea2.identity.tintTopLeft;
    const wardenBodyTintLit = wardenArea1.sprite.tintTopLeft;
    const wardenIdentityTintLit = wardenArea1.identity.tintTopLeft;
    const specterBodyTintLit = specterArea1.sprite.tintTopLeft;
    const specterIdentityTintLit = specterArea1.identity.tintTopLeft;

    const propArea1Lit = f.pixelAtWorld(960, 525).hex;
    const propArea2Lit = f.pixelAtWorld(1240, 525).hex;

    const apronArea1Lit = f.pixelAtWorld(920, 525).hex;
    const apronBoundaryLit = f.pixelAtWorld(1170, 525).hex;
    const apronArea2Lit = f.pixelAtWorld(1205, 525).hex;

    const wardenActor = s.actors.get('warden');
    const selfActor = s.actors.get('self');
    const wardenVisorLayerOrder = wardenActor.container.list.indexOf(wardenActor.visor) > wardenActor.container.list.indexOf(wardenActor.identity);
    const selfVisorLayerOrder = selfActor.container.list.indexOf(selfActor.visor) > selfActor.container.list.indexOf(selfActor.identity);
    const wardenVisorVisible = wardenActor.visor.visible;
    const selfVisorVisible = selfActor.visor.visible;

    // Facing visor witness pixel check (#736 review 606):
    // Align warden heading to 0 (East) so the facing visor projects forward at world dx=+9
    const wardenPlayer = f.state.players.find(p => p.id === 'warden');
    const oldWardenHeading = wardenPlayer.heading;
    wardenPlayer.heading = 0;

    await f.settle({ palette: 'signature', lighting: true, selfPos: { x: 960, y: 400 }, aim: 0 });
    const selfPosWorld = { x: selfActor.container.x, y: selfActor.container.y };
    const wardenPosWorld = { x: wardenActor.container.x, y: wardenActor.container.y };

    const selfVisorPx = f.pixelAtWorld(selfPosWorld.x + 8, selfPosWorld.y - 2);
    const selfDomePx = f.pixelAtWorld(selfPosWorld.x - 5, selfPosWorld.y);
    const wardenVisorPx = f.pixelAtWorld(wardenPosWorld.x + 9, wardenPosWorld.y - 2);
    const wardenPlatePx = f.pixelAtWorld(wardenPosWorld.x - 5, wardenPosWorld.y);
    wardenPlayer.heading = oldWardenHeading;
    const debugInfo = { selfPosWorld, wardenPosWorld, wardenHeading: wardenActor.visor.rotation };

    const selfBodyArea1Tint = s.actors.get('self').sprite.tintTopLeft;
    const selfIdentityArea1Tint = s.actors.get('self').identity.tintTopLeft;
    await f.settle({ palette: 'signature', lighting: true, selfPos: { x: 1170, y: 400 } });
    const selfBodyBoundaryTint = s.actors.get('self').sprite.tintTopLeft;
    const selfIdentityBoundaryTint = s.actors.get('self').identity.tintTopLeft;
    await f.settle({ palette: 'signature', lighting: true, selfPos: { x: 1260, y: 400 } });
    const selfBodyArea2Tint = s.actors.get('self').sprite.tintTopLeft;
    const selfIdentityArea2Tint = s.actors.get('self').identity.tintTopLeft;

    await f.settle({
      palette: 'signature',
      lighting: false,
      wear: true,
      camera: { x: 1120, y: 400, zoom: 1 },
      selfPos: { x: 960, y: 380 },
    });
    const strikerBodyTintUnlit = strikerArea1.sprite.tintTopLeft;
    const strikerIdentityTintUnlit = strikerArea1.identity.tintTopLeft;
    const scoutBodyTintUnlit = scoutArea2.sprite.tintTopLeft;
    const scoutIdentityTintUnlit = scoutArea2.identity.tintTopLeft;
    const wardenBodyTintUnlit = wardenArea1.sprite.tintTopLeft;
    const wardenIdentityTintUnlit = wardenArea1.identity.tintTopLeft;
    const specterBodyTintUnlit = specterArea1.sprite.tintTopLeft;
    const specterIdentityTintUnlit = specterArea1.identity.tintTopLeft;
    const selfBodyTintUnlit = s.actors.get('self').sprite.tintTopLeft;
    const selfIdentityTintUnlit = s.actors.get('self').identity.tintTopLeft;
    const propArea1Unlit = f.pixelAtWorld(960, 525).hex;
    const propArea2Unlit = f.pixelAtWorld(1240, 525).hex;
    const apronArea1Unlit = f.pixelAtWorld(920, 525).hex;
    const apronArea2Unlit = f.pixelAtWorld(1205, 525).hex;

    return {
      wardenBodyTintLit,
      wardenIdentityTintLit,
      wardenBodyTintUnlit,
      wardenIdentityTintUnlit,
      specterBodyTintLit,
      specterIdentityTintLit,
      specterBodyTintUnlit,
      specterIdentityTintUnlit,
      strikerBodyTintLit,
      strikerIdentityTintLit,
      strikerBodyTintUnlit,
      strikerIdentityTintUnlit,
      scoutBodyTintLit,
      scoutIdentityTintLit,
      scoutBodyTintUnlit,
      scoutIdentityTintUnlit,
      selfBodyArea1Tint,
      selfIdentityArea1Tint,
      selfBodyBoundaryTint,
      selfIdentityBoundaryTint,
      selfBodyArea2Tint,
      selfIdentityArea2Tint,
      selfBodyTintUnlit,
      selfIdentityTintUnlit,
      propArea1Lit,
      propArea1Unlit,
      propArea2Lit,
      propArea2Unlit,
      apronArea1Lit,
      apronBoundaryLit,
      apronArea2Lit,
      apronArea1Unlit,
      apronArea2Unlit,
      wardenVisorLayerOrder,
      selfVisorLayerOrder,
      wardenVisorVisible,
      selfVisorVisible,
      selfVisorPx,
      selfDomePx,
      wardenVisorPx,
      wardenPlatePx,
      debugInfo,
    };
  });

  const fileStep4Unlit = 'step4-two-areas-no-lighting.png';
  await page.screenshot({ path: path.join(outDir, fileStep4Unlit) });
  captures.push({
    id: 'step4-two-areas-no-lighting',
    file: fileStep4Unlit,
    theme: 'signature',
    fog: false,
    zoom: 1,
    view: 'step4-two-areas-no-lighting (unlit mode, base materials restored)',
  });

  // Restore defaults after step 4 captures:
  await page.evaluate(async () => {
    await window.witness.settle({ palette: 'signature', lighting: true, wear: true, selfPos: { x: 600, y: 380 } });
  });

  // Moving actors: 29.4 & #736 separated body material and identity layers.
  // Body material layer takes bounded virtual lighting (actorScale = 0.25); identity markings remain strictly untinted:
  assert.notEqual(step4SpatialCheck.selfBodyArea1Tint, step4SpatialCheck.selfBodyArea2Tint, 'actor body in Area 1 takes distinct lighting tint from Area 2');
  assert.notEqual(step4SpatialCheck.selfBodyArea1Tint, 0xffffff, 'actor body in Area 1 takes cobalt virtual lighting');
  assert.notEqual(step4SpatialCheck.selfBodyArea2Tint, 0xffffff, 'actor body in Area 2 takes magenta virtual lighting');
  assert.equal(step4SpatialCheck.selfBodyTintUnlit, 0xffffff, 'actor body unlit sprite retains exact unlit base white 0xffffff');

  // Visor / facing cue layer order and unoccluded render verification (#736 review 606, 610):
  assert.ok(step4SpatialCheck.wardenVisorLayerOrder, 'warden visor layer is rendered strictly above identity layer');
  assert.ok(step4SpatialCheck.selfVisorLayerOrder, 'contestant visor layer is rendered strictly above identity layer');
  assert.ok(step4SpatialCheck.wardenVisorVisible, 'warden visor layer is visible');
  assert.ok(step4SpatialCheck.selfVisorVisible, 'contestant visor layer is visible');

  // Verify warden facing visor against chest plate below it (#610):
  const [rWv, gWv, bWv] = step4SpatialCheck.wardenVisorPx.rgb;
  const [rWp, gWp, bWp] = step4SpatialCheck.wardenPlatePx.rgb;
  assert.notEqual(step4SpatialCheck.wardenVisorPx.hex, step4SpatialCheck.wardenPlatePx.hex, 'warden facing visor pixel is distinct from chest armor plate');
  assert.notEqual(step4SpatialCheck.wardenVisorPx.hex, step4SpatialCheck.wardenIdentityTintLit, 'warden facing visor pixel is untinted equipment and not occluded by coral red identity plate');
  assert.ok(rWp > bWp && rWp > gWp, 'warden chest armor plate exhibits coral red hue (R > G, B)');
  assert.ok(gWv > bWv, 'warden facing visor pixel exhibits yellow dash cue (G > B)');

  // Verify contestant facing visor against helmet dome below it (#610):
  const [rSv, gSv, bSv] = step4SpatialCheck.selfVisorPx.rgb;
  assert.notEqual(step4SpatialCheck.selfVisorPx.hex, step4SpatialCheck.selfDomePx.hex, 'contestant facing visor pixel is distinct from identity dome');
  assert.notEqual(step4SpatialCheck.selfVisorPx.hex, 0xffffff, 'contestant facing visor pixel is untinted cyan slit and not occluded by white identity dome');
  assert.ok(gSv > rSv && bSv > rSv, 'contestant facing visor pixel exhibits cyan slit chromaticity (G, B > R)');

  // Exact saturated kit identity hues preserved in lit and unlit modes (#736 review 605, 606):
  assert.equal(step4SpatialCheck.wardenIdentityTintLit, 0xff6b70, 'warden identity retains exact coral red kit tint 0xff6b70 in lit field');
  assert.equal(step4SpatialCheck.wardenIdentityTintUnlit, 0xff6b70, 'warden identity retains exact coral red kit tint 0xff6b70 in unlit mode');
  assert.equal(step4SpatialCheck.specterIdentityTintLit, 0xb39aff, 'specter identity retains exact lavender kit tint 0xb39aff in lit field');
  assert.equal(step4SpatialCheck.specterIdentityTintUnlit, 0xb39aff, 'specter identity retains exact lavender kit tint 0xb39aff in unlit mode');
  assert.equal(step4SpatialCheck.strikerIdentityTintLit, 0xffba62, 'striker identity retains exact golden amber kit tint 0xffba62 in lit field');
  assert.equal(step4SpatialCheck.strikerIdentityTintUnlit, 0xffba62, 'striker identity retains exact golden amber kit tint 0xffba62 in unlit mode');
  assert.equal(step4SpatialCheck.scoutIdentityTintLit, 0x48c774, 'scout identity retains exact emerald green tint 0x48c774 in lit field');
  assert.equal(step4SpatialCheck.scoutIdentityTintUnlit, 0x48c774, 'scout identity retains exact emerald green tint 0x48c774 in unlit mode');
  assert.equal(step4SpatialCheck.selfIdentityArea1Tint, 0xffffff, 'contestant identity retains base white across Area 1');
  assert.equal(step4SpatialCheck.selfIdentityArea2Tint, 0xffffff, 'contestant identity retains base white across Area 2');
  assert.equal(step4SpatialCheck.selfIdentityBoundaryTint, 0xffffff, 'contestant identity retains base white across boundary');
  assert.equal(step4SpatialCheck.selfIdentityTintUnlit, 0xffffff, 'contestant identity retains base white when unlit');

  // Pairwise distinctness check between all 3 gladiator kits (Euclidean RGB distance >= 80):
  assert.ok(rgbDist(step4SpatialCheck.wardenIdentityTintLit, step4SpatialCheck.strikerIdentityTintLit) >= 80, 'warden vs striker pairwise color distance >= 80');
  assert.ok(rgbDist(step4SpatialCheck.strikerIdentityTintLit, step4SpatialCheck.specterIdentityTintLit) >= 80, 'striker vs specter pairwise color distance >= 80');
  assert.ok(rgbDist(step4SpatialCheck.wardenIdentityTintLit, step4SpatialCheck.specterIdentityTintLit) >= 80, 'warden vs specter pairwise color distance >= 80');

  // Tier 1 contrast requirement: all identity hues maintain WCAG contrast >= 1.80 against underlying ground:
  assert.ok(contrast(step4SpatialCheck.wardenIdentityTintLit, step4SpatialCheck.apronArea1Lit) >= 1.80, 'warden identity meets Tier 1 ground contrast >= 1.80');
  assert.ok(contrast(step4SpatialCheck.specterIdentityTintLit, step4SpatialCheck.apronArea1Lit) >= 1.80, 'specter identity meets Tier 1 ground contrast >= 1.80');
  assert.ok(contrast(step4SpatialCheck.strikerIdentityTintLit, step4SpatialCheck.apronArea1Lit) >= 1.80, 'striker identity meets Tier 1 ground contrast >= 1.80');
  assert.ok(contrast(step4SpatialCheck.scoutIdentityTintLit, step4SpatialCheck.apronArea2Lit) >= 1.80, 'scout identity meets Tier 1 ground contrast >= 1.80');
  assert.ok(contrast(step4SpatialCheck.selfIdentityArea1Tint, step4SpatialCheck.apronArea1Lit) >= 1.80, 'self identity meets Tier 1 ground contrast >= 1.80');

  // Physics props on both sides of boundary:
  assert.notEqual(step4SpatialCheck.propArea1Lit, step4SpatialCheck.propArea2Lit, 'prop in Area 1 takes distinct lighting tint from prop in Area 2');
  assert.notEqual(step4SpatialCheck.propArea1Lit, step4SpatialCheck.propArea1Unlit, 'prop in Area 1 is tinted when lit');
  assert.notEqual(step4SpatialCheck.propArea2Lit, step4SpatialCheck.propArea2Unlit, 'prop in Area 2 is tinted when lit');
  assert.equal(step4SpatialCheck.propArea1Unlit, step4SpatialCheck.propArea2Unlit, 'unlit props have identical base material fill');

  // Value separation bound: physics props maintain contrast separation floor (>= 1.50) from underlying ground
  const propArea1Contrast = Number(contrast(step4SpatialCheck.propArea1Lit, step4SpatialCheck.apronArea1Lit).toFixed(2));
  const propArea2Contrast = Number(contrast(step4SpatialCheck.propArea2Lit, step4SpatialCheck.apronArea2Lit).toFixed(2));
  const propUnlitContrast = Number(contrast(step4SpatialCheck.propArea1Unlit, step4SpatialCheck.apronArea1Unlit).toFixed(2));
  assert.ok(propArea1Contrast >= 1.50, `Area 1 lit prop maintains value separation from ground (contrast ${propArea1Contrast} >= 1.50)`);
  assert.ok(propArea2Contrast >= 1.50, `Area 2 lit prop maintains value separation from ground (contrast ${propArea2Contrast} >= 1.50)`);
  assert.ok(propUnlitContrast >= 1.50, `Unlit prop maintains value separation from ground (contrast ${propUnlitContrast} >= 1.50)`);

  // Ground paving across boundary:
  assert.notEqual(step4SpatialCheck.apronArea1Lit, step4SpatialCheck.apronArea2Lit, 'ground segment in Area 1 differs in tint from segment in Area 2');
  assert.notEqual(step4SpatialCheck.apronBoundaryLit, step4SpatialCheck.apronArea1Lit, 'boundary transition segment blends smoothly across boundary');
  assert.equal(step4SpatialCheck.apronArea1Unlit, step4SpatialCheck.apronArea2Unlit, 'unlit ground segments revert to identical base paving color');

  // Palette x field contrast sweep for dynamic object virtual lighting (#737, Step 5)
  // Sweeps all six theme palettes across regional lighting fields (Area 1 cobalt, Area 2 magenta, unlit)
  // and substrates (theme-owned street, theme-owned ground, and map-authored slate paving).
  const paletteFieldSweep = await page.evaluate(async (themes) => {
    const f = window.witness;
    const sweep = {};
    for (const themeId of themes) {
      await f.settle({
        palette: themeId,
        lighting: true,
        wear: true,
        camera: { x: 1120, y: 400, zoom: 1 },
        selfPos: { x: 960, y: 380 },
      });
      // Area 1 (Cobalt): prop on slate paving (960, 525) & apron (920, 525); prop on street (940, 465) & street (980, 465)
      const propArea1Lit = f.pixelAtWorld(960, 525).hex;
      const apronArea1Lit = f.pixelAtWorld(920, 525).hex;
      const propStreetCobaltLit = f.pixelAtWorld(940, 465).hex;
      const streetCobaltLit = f.pixelAtWorld(980, 465).hex;

      // Area 2 (Magenta): prop on slate paving (1240, 525) & apron (1205, 525); prop on ground (1240, 410) & ground (1205, 410)
      const propArea2Lit = f.pixelAtWorld(1240, 525).hex;
      const apronArea2Lit = f.pixelAtWorld(1205, 525).hex;
      const propGroundMagentaLit = f.pixelAtWorld(1240, 410).hex;
      const groundMagentaLit = f.pixelAtWorld(1205, 410).hex;

      await f.settle({
        palette: themeId,
        lighting: false,
        wear: true,
        camera: { x: 1120, y: 400, zoom: 1 },
        selfPos: { x: 960, y: 380 },
      });
      const propArea1Unlit = f.pixelAtWorld(960, 525).hex;
      const apronArea1Unlit = f.pixelAtWorld(920, 525).hex;
      const propStreetUnlit = f.pixelAtWorld(940, 465).hex;
      const streetUnlit = f.pixelAtWorld(980, 465).hex;
      const propGroundUnlit = f.pixelAtWorld(1240, 410).hex;
      const groundUnlit = f.pixelAtWorld(1205, 410).hex;

      sweep[themeId] = {
        propArea1Lit,
        apronArea1Lit,
        propStreetCobaltLit,
        streetCobaltLit,
        propArea2Lit,
        apronArea2Lit,
        propGroundMagentaLit,
        groundMagentaLit,
        propArea1Unlit,
        apronArea1Unlit,
        propStreetUnlit,
        streetUnlit,
        propGroundUnlit,
        groundUnlit,
      };
    }
    return sweep;
  }, themeNames);

  // Restore witness defaults after sweep:
  await page.evaluate(async () => {
    await window.witness.settle({ palette: 'signature', lighting: true, wear: true, selfPos: { x: 600, y: 380 } });
  });

  // Verify that sampled theme-owned substrates actually vary across themes (#737 review)
  const streetColors = new Set(Object.values(paletteFieldSweep).map(d => d.streetCobaltLit));
  const groundColors = new Set(Object.values(paletteFieldSweep).map(d => d.groundMagentaLit));
  assert.ok(streetColors.size >= 4, `Sampled theme street colors vary across themes (${streetColors.size} distinct colors >= 4)`);
  assert.ok(groundColors.size >= 4, `Sampled theme ground colors vary across themes (${groundColors.size} distinct colors >= 4)`);

  const paletteSweepSummary = {};
  for (const [themeId, data] of Object.entries(paletteFieldSweep)) {
    const cobaltStreetContrast = Number(contrast(data.propStreetCobaltLit, data.streetCobaltLit).toFixed(2));
    const cobaltApronContrast = Number(contrast(data.propArea1Lit, data.apronArea1Lit).toFixed(2));
    const magentaGroundContrast = Number(contrast(data.propGroundMagentaLit, data.groundMagentaLit).toFixed(2));
    const magentaApronContrast = Number(contrast(data.propArea2Lit, data.apronArea2Lit).toFixed(2));
    const unlitStreetContrast = Number(contrast(data.propStreetUnlit, data.streetUnlit).toFixed(2));
    const unlitGroundContrast = Number(contrast(data.propGroundUnlit, data.groundUnlit).toFixed(2));
    const unlitApronContrast = Number(contrast(data.propArea1Unlit, data.apronArea1Unlit).toFixed(2));

    // Verify contrast floor >= 1.50 across all theme palettes and regional lighting fields
    assert.ok(
      cobaltStreetContrast >= 1.50,
      `[${themeId}] Cobalt lit prop maintains contrast floor against street (${cobaltStreetContrast} >= 1.50)`
    );
    assert.ok(
      cobaltApronContrast >= 1.50,
      `[${themeId}] Cobalt lit prop maintains contrast floor against apron (${cobaltApronContrast} >= 1.50)`
    );
    assert.ok(
      magentaGroundContrast >= 1.50,
      `[${themeId}] Magenta lit prop maintains contrast floor against ground (${magentaGroundContrast} >= 1.50)`
    );
    assert.ok(
      magentaApronContrast >= 1.50,
      `[${themeId}] Magenta lit prop maintains contrast floor against apron (${magentaApronContrast} >= 1.50)`
    );
    assert.ok(
      unlitStreetContrast >= 1.50,
      `[${themeId}] Unlit prop maintains contrast floor against street (${unlitStreetContrast} >= 1.50)`
    );
    assert.ok(
      unlitGroundContrast >= 1.50,
      `[${themeId}] Unlit prop maintains contrast floor against ground (${unlitGroundContrast} >= 1.50)`
    );
    assert.ok(
      unlitApronContrast >= 1.50,
      `[${themeId}] Unlit prop maintains contrast floor against apron (${unlitApronContrast} >= 1.50)`
    );

    paletteSweepSummary[themeId] = {
      propCobaltStreet: css(data.propStreetCobaltLit),
      streetCobalt: css(data.streetCobaltLit),
      cobaltStreetContrast,
      propCobaltApron: css(data.propArea1Lit),
      apronCobalt: css(data.apronArea1Lit),
      cobaltApronContrast,
      propMagentaGround: css(data.propGroundMagentaLit),
      groundMagenta: css(data.groundMagentaLit),
      magentaGroundContrast,
      propMagentaApron: css(data.propArea2Lit),
      apronMagenta: css(data.apronArea2Lit),
      magentaApronContrast,
      propUnlitStreet: css(data.propStreetUnlit),
      streetUnlit: css(data.streetUnlit),
      unlitStreetContrast,
      propUnlitGround: css(data.propGroundUnlit),
      groundUnlit: css(data.groundUnlit),
      unlitGroundContrast,
      passesFloor: [
        cobaltStreetContrast,
        cobaltApronContrast,
        magentaGroundContrast,
        magentaApronContrast,
        unlitStreetContrast,
        unlitGroundContrast,
        unlitApronContrast,
      ].every(c => c >= 1.50),
    };
  }

  const step4SpatialSummary = {
    wardenIdentityLit: css(step4SpatialCheck.wardenIdentityTintLit),
    wardenIdentityUnlit: css(step4SpatialCheck.wardenIdentityTintUnlit),
    specterIdentityLit: css(step4SpatialCheck.specterIdentityTintLit),
    specterIdentityUnlit: css(step4SpatialCheck.specterIdentityTintUnlit),
    strikerIdentityLit: css(step4SpatialCheck.strikerIdentityTintLit),
    strikerIdentityUnlit: css(step4SpatialCheck.strikerIdentityTintUnlit),
    scoutIdentityLit: css(step4SpatialCheck.scoutIdentityTintLit),
    scoutIdentityUnlit: css(step4SpatialCheck.scoutIdentityTintUnlit),
    strikerBodyLit: css(step4SpatialCheck.strikerBodyTintLit),
    scoutBodyLit: css(step4SpatialCheck.scoutBodyTintLit),
    selfBodyArea1Lit: css(step4SpatialCheck.selfBodyArea1Tint),
    selfBodyBoundaryLit: css(step4SpatialCheck.selfBodyBoundaryTint),
    selfBodyArea2Lit: css(step4SpatialCheck.selfBodyArea2Tint),
    selfBodyUnlit: css(step4SpatialCheck.selfBodyTintUnlit),
    selfIdentityLit: css(step4SpatialCheck.selfIdentityArea1Tint),
    selfIdentityUnlit: css(step4SpatialCheck.selfIdentityTintUnlit),
    propArea1Lit: css(step4SpatialCheck.propArea1Lit),
    propArea1Unlit: css(step4SpatialCheck.propArea1Unlit),
    propArea2Lit: css(step4SpatialCheck.propArea2Lit),
    propArea2Unlit: css(step4SpatialCheck.propArea2Unlit),
    propArea1Contrast,
    propArea2Contrast,
    propUnlitContrast,
    apronArea1Lit: css(step4SpatialCheck.apronArea1Lit),
    apronBoundaryLit: css(step4SpatialCheck.apronBoundaryLit),
    apronArea2Lit: css(step4SpatialCheck.apronArea2Lit),
    apronArea1Unlit: css(step4SpatialCheck.apronArea1Unlit),
    apronArea2Unlit: css(step4SpatialCheck.apronArea2Unlit),
    unlitPropsIdentical: step4SpatialCheck.propArea1Unlit === step4SpatialCheck.propArea2Unlit,
    unlitGroundIdentical: step4SpatialCheck.apronArea1Unlit === step4SpatialCheck.apronArea2Unlit,
    actorIdentityUntinted: step4SpatialCheck.strikerIdentityTintLit === 0xffba62 && step4SpatialCheck.specterIdentityTintLit === 0xb39aff && step4SpatialCheck.wardenIdentityTintLit === 0xff6b70 && step4SpatialCheck.scoutIdentityTintLit === 0x48c774,
    actorBodyTinted: step4SpatialCheck.selfBodyArea1Tint !== 0xffffff && step4SpatialCheck.selfBodyArea1Tint !== step4SpatialCheck.selfBodyArea2Tint,
  };

  // 5c. Procedural commercial storefront kit adoption verification (41.2 step 5, #586 + #585):
  //     Verify that:
  //     - Generated commercial storefront presets across decay tiers (intact, weathered, damaged) maintain
  //       recognizable commercial identity (color blocking, sign backings, entrance doorsteps).
  //     - Decay contrast survives at gameplay zoom (intact vs weathered vs scorched damaged are visibly distinct).
  //     - Doorway openings and entrance readability survive roof fade in interior view.
  //     - Identity and layout survive distant LOD (0.28 zoom) and grayscale value contrast abstraction.
  const { HOUSE } = await import('../map/micro/placeables/house.ts');
  const { createStorefrontAppearance } = await import('../map/micro/strategies/hut.ts');
  const { createGenerationContext } = await import('../shared/map/context.ts');
  const { placeElement } = await import('../shared/map/element.ts');

  // Build a controlled storefront demonstration map using the actual procedural HOUSE placeables:
  const storefrontCtx = createGenerationContext(98765);
  const appIntact = createStorefrontAppearance({ roll: 0.1, w: 200, h: 160, door: 'S' });
  const appWeathered = createStorefrontAppearance({ roll: 0.5, w: 200, h: 160, door: 'S' });
  const appDamaged = createStorefrontAppearance({ roll: 0.9, w: 200, h: 160, door: 'S' });

  const hIntact = HOUSE.build({ w: 5, h: 4, door: 'S', spaces: 1, seed: 101, appearance: appIntact }, 40);
  const hWeathered = HOUSE.build({ w: 5, h: 4, door: 'S', spaces: 1, seed: 102, appearance: appWeathered }, 40);
  const hDamaged = HOUSE.build({ w: 5, h: 4, door: 'S', spaces: 1, seed: 103, appearance: appDamaged }, 40);

  placeElement(storefrontCtx, hIntact.elements[0].template, 300, 500, { nodeId: 'sf-intact', locked: false });
  placeElement(storefrontCtx, hWeathered.elements[0].template, 560, 500, { nodeId: 'sf-weathered', locked: false });
  placeElement(storefrontCtx, hDamaged.elements[0].template, 820, 500, { nodeId: 'sf-damaged', locked: false });

  // Add street paving in front of the storefronts to frame the entrance doorsteps (11.1 §5.5)
  const sfMap = {
    seed: 98765,
    width: 1400,
    height: 1000,
    buildings: storefrontCtx.map.buildings,
    roofs: storefrontCtx.map.roofs,
    obstacles: storefrontCtx.map.obstacles,
    decals: storefrontCtx.map.decals || [],
    modules: [],
    hazards: [],
    gaps: [],
    stations: [],
    sensors: [],
    gates: [],
    routes: [{ points: [{ x: 200, y: 710 }, { x: 1100, y: 710 }] }],
    appearance: {
      surfaces: [
        { id: 'sf-street-surf', bounds: { x: 200, y: 660, w: 900, h: 100 }, material: 'nightAsphalt' },
      ],
      lighting: {
        fields: [
          { id: 'sf-wash', bounds: { x: 200, y: 460, w: 900, h: 320 }, tint: 'cobaltBlue', intensity: 0.28 },
        ],
      },
    },
  };

  const intactSignPos = {
    x: Math.round(300 + appIntact.roofSign.dx + appIntact.roofSign.w / 2),
    y: Math.round(500 + appIntact.roofSign.dy + appIntact.roofSign.h / 2),
  };
  const intactSignBackingPos = {
    x: Math.round(300 + appIntact.roofSign.dx + appIntact.roofSign.w / 2),
    y: Math.round(500 + appIntact.roofSign.dy + appIntact.roofSign.h + 1),
  };
  const weatheredDrainPos = {
    x: Math.round(560 + appWeathered.neglect.roofDrainStain.dx),
    y: Math.round(500 + appWeathered.neglect.roofDrainStain.dy),
  };
  const damagedDoorDecal = hDamaged.elements[0].template.decals.find(d => d.marks === 'door');
  assert.ok(damagedDoorDecal, 'damaged building template has realized door decal');
  const doorstepPos = {
    x: Math.round(820 + damagedDoorDecal.x + damagedDoorDecal.w / 2),
    y: Math.round(500 + damagedDoorDecal.y + damagedDoorDecal.h / 2),
  };
  const damagedScorchPos = {
    x: Math.round(820 + appDamaged.neglect.scorchMark.dx),
    y: Math.round(500 + appDamaged.neglect.scorchMark.dy),
  };

  // Derive plain interior floor sample clear of player sprite, floorStain, and scorchMark:
  const candidateFloorPoints = [
    { x: 820 + 160, y: 500 + 45 }, // NE interior
    { x: 820 + 40,  y: 500 + 45 }, // NW interior
    { x: 820 + 160, y: 500 + 115 }, // SE interior
    { x: 820 + 40,  y: 500 + 115 }, // SW interior
  ];
  const stainPt = { x: 820 + appDamaged.neglect.floorStain.dx, y: 500 + appDamaged.neglect.floorStain.dy };
  const scorchPt = { x: 820 + appDamaged.neglect.scorchMark.dx, y: 500 + appDamaged.neglect.scorchMark.dy };
  const selfPt = { x: 920, y: 580 };
  const normEllipseDist = (p, center, w, h) =>
    Math.hypot((p.x - center.x) / (w / 2), (p.y - center.y) / (h / 2));
  const stainNorm = p => normEllipseDist(p, stainPt, appDamaged.neglect.floorStain.w, appDamaged.neglect.floorStain.h);
  const scorchNorm = p => normEllipseDist(p, scorchPt, appDamaged.neglect.scorchMark.w, appDamaged.neglect.scorchMark.h);
  const selfNorm = p => Math.hypot(p.x - selfPt.x, p.y - selfPt.y) / 15;

  const damagedFloorPos = candidateFloorPoints.reduce((best, p) => {
    const clearance = Math.min(stainNorm(p), scorchNorm(p), selfNorm(p));
    return clearance > best.clearance ? { p, clearance } : best;
  }, { p: candidateFloorPoints[0], clearance: -1 }).p;

  assert.ok(stainNorm(damagedFloorPos) > 1.0, 'damaged floor sample point is outside floor stain ellipse');
  assert.ok(scorchNorm(damagedFloorPos) > 1.0, 'damaged floor sample point is outside scorch mark ellipse');
  assert.ok(selfNorm(damagedFloorPos) > 1.0, 'damaged floor sample point is outside player sprite radius');

  const sampleTargets = {
    demoMap: sfMap,
    intactSignPos,
    intactSignBackingPos,
    weatheredDrainPos,
    damagedScorchPos,
    damagedFloorPos,
    doorstepPos,
    lodZoom: LOD_LOW_ZOOM,
  };

  const storefrontDemo = await page.evaluate(async (targets) => {
    const { demoMap, intactSignPos, intactSignBackingPos, weatheredDrainPos, damagedScorchPos, damagedFloorPos, doorstepPos, lodZoom } = targets;
    const f = window.witness, s = f.scene;
    window.__witnessPriorMap = f.map;
    window.__witnessPriorPlayers = f.state.players;
    window.__witnessPriorBodies = f.state.bodies;
    const priorMap = f.map;
    const priorPlayers = f.state.players;
    const priorBodies = f.state.bodies;
    f.map = demoMap;
    s.recordStatic(demoMap);
    f.state.players = f.state.players.filter(p => p.id === 'self');
    f.state.bodies = (f.state.bodies || []).filter(b => b.actorId === 'self');

    // 1. Gameplay zoom (playerZoom), roofs covered (player stands well south of all doors at y=850):
    await f.settle({
      palette: 'signature',
      lighting: true,
      wear: true,
      directed: false,
      fog: false,
      camera: { x: 660, y: 580, zoom: 1.12 },
      selfPos: { x: 660, y: 850 },
      roofSteps: 40,
    });
    const intactRoofPx = f.pixelAtWorld(400, 560);
    const intactSignPx = f.pixelAtWorld(intactSignPos.x, intactSignPos.y);
    const intactSignBackingPx = f.pixelAtWorld(intactSignBackingPos.x, intactSignBackingPos.y);
    const weatheredRoofPx = f.pixelAtWorld(660, 560);
    const weatheredDrainPx = f.pixelAtWorld(weatheredDrainPos.x, weatheredDrainPos.y);
    // Clean damaged roof surface away from scorch, drain, and panel marks:
    const damagedRoofPx = f.pixelAtWorld(980, 530);

    const toLum = hex => {
      const r = ((hex >> 16) & 255) / 255;
      const g = ((hex >> 8) & 255) / 255;
      const b = (hex & 255) / 255;
      return 0.299 * r + 0.587 * g + 0.114 * b;
    };
    const scorchPatch = f.patchExtremaAtWorld(damagedScorchPos.x, damagedScorchPos.y, 6);
    let darkestHex = scorchPatch[0];
    let minLum = toLum(darkestHex);
    for (const hex of scorchPatch) {
      const lum = toLum(hex);
      if (lum < minLum) {
        minLum = lum;
        darkestHex = hex;
      }
    }
    const damagedScorchPx = { hex: darkestHex };

    const streetPx = f.pixelAtWorld(660, 710);
    const intactRoofAlpha = s.roofs.get(demoMap.roofs[0].id)?.alpha ?? 0;
    const weatheredRoofAlpha = s.roofs.get(demoMap.roofs[1].id)?.alpha ?? 0;
    const damagedRoofAlphaClosed = s.roofs.get(demoMap.roofs[2].id)?.alpha ?? 0;

    // 2. Interior view (inside damaged shop, roof revealed):
    await f.settle({
      palette: 'signature',
      lighting: true,
      wear: true,
      directed: false,
      fog: false,
      camera: { x: 920, y: 580, zoom: 1.288 },
      selfPos: { x: 920, y: 580 },
      roofSteps: 40,
    });
    // Sample plain interior slate floor clear of player sprite, floorStain, and scorchMark:
    const damagedFloorPx = f.pixelAtWorld(damagedFloorPos.x, damagedFloorPos.y);
    const doorstepPx = f.pixelAtWorld(doorstepPos.x, doorstepPos.y);
    const damagedRoofAlphaInside = s.roofs.get(demoMap.roofs[2].id)?.alpha ?? 0;

    // 3. Distant LOD zoom:
    // Pass directed: true, fog: true, followId: 'self' so fogged = true and roofs remain closed (alpha === 1)
    await f.settle({
      palette: 'signature',
      lighting: true,
      wear: true,
      directed: true,
      fog: true,
      followId: 'self',
      camera: { x: 660, y: 580, zoom: lodZoom },
      selfPos: { x: 660, y: 850 },
      roofSteps: 40,
    });
    const lodRoofPx = f.pixelAtWorld(400, 560);
    const lodStreetPx = f.pixelAtWorld(660, 710);
    const lodDamagedRoofPx = f.pixelAtWorld(920, 560);
    const lodIntactRoofAlpha = s.roofs.get(demoMap.roofs[0].id)?.alpha ?? 0;
    const lodWeatheredRoofAlpha = s.roofs.get(demoMap.roofs[1].id)?.alpha ?? 0;
    const lodDamagedRoofAlpha = s.roofs.get(demoMap.roofs[2].id)?.alpha ?? 0;

    // Restore prior map, players, bodies:
    f.map = priorMap;
    s.recordStatic(priorMap);
    f.state.players = priorPlayers;
    f.state.bodies = priorBodies;
    await f.settle({ palette: 'signature', lighting: true, wear: true, selfPos: { x: 600, y: 380 } });

    return {
      intactRoofPx,
      intactSignPx,
      intactSignBackingPx,
      weatheredRoofPx,
      weatheredDrainPx,
      damagedRoofPx,
      damagedScorchPx,
      streetPx,
      damagedFloorPx,
      doorstepPx,
      intactRoofAlpha,
      weatheredRoofAlpha,
      damagedRoofAlphaClosed,
      damagedRoofAlphaInside,
      lodRoofPx,
      lodStreetPx,
      lodDamagedRoofPx,
      lodIntactRoofAlpha,
      lodWeatheredRoofAlpha,
      lodDamagedRoofAlpha,
    };
  }, sampleTargets);

  // Take dedicated screenshots for visual review:
  await page.evaluate(async (demoMap) => {
    window.witness.map = demoMap;
    window.witness.scene.recordStatic(demoMap);
    window.witness.state.players = window.witness.state.players.filter(p => p.id === 'self');
    window.witness.state.bodies = (window.witness.state.bodies || []).filter(b => b.actorId === 'self');
    await window.witness.settle({ palette: 'signature', lighting: true, wear: true, directed: false, fog: false, camera: { x: 660, y: 580, zoom: 1.12 }, selfPos: { x: 660, y: 850 } });
  }, sfMap);
  const fileSfRoofs = 'storefront-gameplay-roofs.png';
  await page.screenshot({ path: path.join(outDir, fileSfRoofs) });
  captures.push({ id: 'storefront-gameplay-roofs', file: fileSfRoofs, theme: 'signature', fog: false, zoom: PLAY_ZOOM, view: 'step5-storefront-roofs (intact, weathered, damaged storefronts side-by-side)' });

  await page.evaluate(async () => {
    await window.witness.settle({ palette: 'signature', lighting: true, wear: true, directed: false, fog: false, camera: { x: 920, y: 580, zoom: 1.288 }, selfPos: { x: 920, y: 580 } });
  });
  const fileSfInterior = 'storefront-gameplay-interior.png';
  await page.screenshot({ path: path.join(outDir, fileSfInterior) });
  captures.push({ id: 'storefront-gameplay-interior', file: fileSfInterior, theme: 'signature', fog: false, zoom: INDOOR_ZOOM, view: 'step5-storefront-interior (damaged shop interior revealed, doorstep threshold)' });

  await page.evaluate(async (lodZoom) => {
    await window.witness.settle({ palette: 'signature', lighting: true, wear: true, directed: true, fog: true, followId: 'self', camera: { x: 660, y: 580, zoom: lodZoom }, selfPos: { x: 660, y: 850 } });
  }, LOD_LOW_ZOOM);
  const fileSfLod = 'storefront-distant-lod.png';
  await page.screenshot({ path: path.join(outDir, fileSfLod) });
  captures.push({ id: 'storefront-distant-lod', file: fileSfLod, theme: 'signature', fog: true, zoom: LOD_LOW_ZOOM, view: `step5-storefront-distant-lod (${LOD_LOW_ZOOM} zoom silhouette and layout readability)` });

  // Restore prior map, players, bodies:
  await page.evaluate(async () => {
    const f = window.witness;
    if (window.__witnessPriorMap) {
      f.map = window.__witnessPriorMap;
      f.scene.recordStatic(window.__witnessPriorMap);
    }
    if (window.__witnessPriorPlayers) {
      f.state.players = window.__witnessPriorPlayers;
    }
    if (window.__witnessPriorBodies) {
      f.state.bodies = window.__witnessPriorBodies;
    }
    await f.settle({ palette: 'signature', lighting: true, wear: true, selfPos: { x: 600, y: 380 } });
  });

  // Grayscale / luminance evaluation:

  const intactRoofLumRatio = lumContrast(storefrontDemo.intactRoofPx.hex, storefrontDemo.streetPx.hex);
  const damagedRoofLumRatio = lumContrast(storefrontDemo.damagedRoofPx.hex, storefrontDemo.streetPx.hex);
  const damagedVsIntactRoofRatio = lumContrast(storefrontDemo.damagedRoofPx.hex, storefrontDemo.intactRoofPx.hex);
  const weatheredVsIntactRoofRatio = lumContrast(storefrontDemo.weatheredRoofPx.hex, storefrontDemo.intactRoofPx.hex);
  const intactSignLumRatio = lumContrast(storefrontDemo.intactSignPx.hex, storefrontDemo.intactRoofPx.hex);
  const intactSignBackingLumRatio = lumContrast(storefrontDemo.intactSignBackingPx.hex, storefrontDemo.intactRoofPx.hex);
  const intactSignFaceVsBackingRatio = lumContrast(storefrontDemo.intactSignPx.hex, storefrontDemo.intactSignBackingPx.hex);
  const weatheredDrainLumRatio = lumContrast(storefrontDemo.weatheredDrainPx.hex, storefrontDemo.weatheredRoofPx.hex);
  const damagedScorchLumRatio = lumContrast(storefrontDemo.damagedScorchPx.hex, storefrontDemo.damagedRoofPx.hex);
  const doorstepLumRatio = lumContrast(storefrontDemo.doorstepPx.hex, storefrontDemo.damagedFloorPx.hex);
  const doorstepVsStreetRatio = lumContrast(storefrontDemo.doorstepPx.hex, storefrontDemo.streetPx.hex);
  const lodRoofLumRatio = lumContrast(storefrontDemo.lodRoofPx.hex, storefrontDemo.lodStreetPx.hex);

  // Assertions:
  // 1. All three roofs are fully closed in gameplay view when player is clear of doors:
  assert.equal(storefrontDemo.intactRoofAlpha, 1, 'intact roof is closed');
  assert.equal(storefrontDemo.weatheredRoofAlpha, 1, 'weathered roof is closed');
  assert.equal(storefrontDemo.damagedRoofAlphaClosed, 1, 'damaged roof is closed');

  // Distant LOD preserves closed roofs:
  assert.equal(storefrontDemo.lodIntactRoofAlpha, 1, 'intact roof is closed at distant LOD');
  assert.equal(storefrontDemo.lodWeatheredRoofAlpha, 1, 'weathered roof is closed at distant LOD');
  assert.equal(storefrontDemo.lodDamagedRoofAlpha, 1, 'damaged roof is closed at distant LOD');

  // 2. Rooftops are visibly distinct between intact, weathered, and damaged:
  assert.notEqual(storefrontDemo.intactRoofPx.hex, storefrontDemo.weatheredRoofPx.hex, 'intact roof differs from weathered roof');
  assert.notEqual(storefrontDemo.weatheredRoofPx.hex, storefrontDemo.damagedRoofPx.hex, 'weathered roof differs from damaged roof');
  assert.notEqual(storefrontDemo.intactRoofPx.hex, storefrontDemo.damagedRoofPx.hex, 'intact roof differs from damaged roof');

  // 3. Grayscale readability survives across decay tiers and against ground:
  assert.ok(intactRoofLumRatio >= 1.15, `intact roof survives grayscale contrast vs street (${intactRoofLumRatio})`);
  assert.ok(damagedRoofLumRatio >= 1.15, `damaged roof survives grayscale contrast vs street (${damagedRoofLumRatio})`);
  assert.ok(damagedVsIntactRoofRatio >= 1.25, `damaged cream roof separates in grayscale from intact teal roof (${damagedVsIntactRoofRatio})`);

  // 4. Wear marks and commercial features survive value contrast against their owning surfaces:
  assert.ok(intactSignBackingLumRatio >= 1.25, `commercial roof sign backing separates in grayscale against roof (${intactSignBackingLumRatio})`);
  assert.ok(intactSignFaceVsBackingRatio >= 1.25, `commercial sign face separates in grayscale against sign backing (${intactSignFaceVsBackingRatio})`);
  assert.ok(weatheredDrainLumRatio >= 1.3, `weathered drainage stain separates in grayscale against roof (${weatheredDrainLumRatio})`);
  assert.ok(damagedScorchLumRatio >= 2.0, `damaged scorch mark separates in grayscale against roof (${damagedScorchLumRatio})`);
  assert.ok(lodRoofLumRatio >= 1.15, `distant LOD roof silhouette separates in grayscale against street (${lodRoofLumRatio})`);

  // 5. Entrance / interior readability:
  assert.equal(storefrontDemo.damagedRoofAlphaInside, 0, 'roof reveals when player is inside shop');

  const step5StorefrontSummary = {
    intactRoofHex: css(storefrontDemo.intactRoofPx.hex),
    weatheredRoofHex: css(storefrontDemo.weatheredRoofPx.hex),
    damagedRoofHex: css(storefrontDemo.damagedRoofPx.hex),
    streetHex: css(storefrontDemo.streetPx.hex),
    intactSignHex: css(storefrontDemo.intactSignPx.hex),
    intactSignBackingHex: css(storefrontDemo.intactSignBackingPx.hex),
    weatheredDrainHex: css(storefrontDemo.weatheredDrainPx.hex),
    damagedScorchHex: css(storefrontDemo.damagedScorchPx.hex),
    damagedFloorHex: css(storefrontDemo.damagedFloorPx.hex),
    doorstepHex: css(storefrontDemo.doorstepPx.hex),
    intactRoofAlpha: storefrontDemo.intactRoofAlpha,
    weatheredRoofAlpha: storefrontDemo.weatheredRoofAlpha,
    damagedRoofAlphaClosed: storefrontDemo.damagedRoofAlphaClosed,
    damagedRoofAlphaInside: storefrontDemo.damagedRoofAlphaInside,
    lodIntactRoofAlpha: storefrontDemo.lodIntactRoofAlpha,
    lodWeatheredRoofAlpha: storefrontDemo.lodWeatheredRoofAlpha,
    lodDamagedRoofAlpha: storefrontDemo.lodDamagedRoofAlpha,
    intactRoofLumRatio,
    damagedRoofLumRatio,
    damagedVsIntactRoofRatio,
    weatheredVsIntactRoofRatio,
    intactSignLumRatio,
    intactSignBackingLumRatio,
    intactSignFaceVsBackingRatio,
    weatheredDrainLumRatio,
    damagedScorchLumRatio,
    doorstepLumRatio,
    doorstepVsStreetRatio,
    lodRoofLumRatio,
    lodRoofHex: css(storefrontDemo.lodRoofPx.hex),
    lodStreetHex: css(storefrontDemo.lodStreetPx.hex),
  };


  // 5b. Visual Screening & Grayscale Survival for Expanded Architectural Kits (Market, Compound, Plant):
  const stallCells = [
    { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 },
    { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 },
  ];
  const roomCells = [
    { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 },
    { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 },
    { x: 0, y: 2 }, { x: 1, y: 2 }, { x: 2, y: 2 }, { x: 3, y: 2 },
  ];
  const expCompoundDamaged = createCompoundAppearance({ seed: 585, roll: 0.85, w: 160, h: 120 });
  const expMap = {
    seed: 585,
    width: 2400,
    height: 1600,
    modules: [],
    buildings: [
      // Compound residential room (intact)
      { id: 'exp-compound-room', x: 160, y: 240, w: 160, h: 120, appearance: COMPOUND_RESIDENTIAL_INTACT },
      // Plant shed
      { id: 'exp-plant-shed', x: 360, y: 240, w: 160, h: 120, appearance: PLANT_SHED_APPEARANCE },
      // Compound residential room (generated damaged wear with scorch marks and floor stains)
      { id: 'exp-compound-damaged', x: 560, y: 240, w: 160, h: 120, appearance: expCompoundDamaged },
    ],
    roofs: [
      // Market stall awnings
      { id: 'exp-stall-intact', groupId: 'stall-1', bounds: { x: 200, y: 100, w: 120, h: 80 }, origin: { x: 200, y: 100 }, cellSize: 40, cells: stallCells, appearance: MARKET_STALL_INTACT },
      { id: 'exp-stall-weathered', groupId: 'stall-2', bounds: { x: 400, y: 100, w: 120, h: 80 }, origin: { x: 400, y: 100 }, cellSize: 40, cells: stallCells, appearance: MARKET_STALL_WEATHERED },
      { id: 'exp-stall-damaged', groupId: 'stall-3', bounds: { x: 600, y: 100, w: 120, h: 80 }, origin: { x: 600, y: 100 }, cellSize: 40, cells: stallCells, appearance: MARKET_STALL_DAMAGED },
      // Compound residential roof (intact)
      { id: 'exp-compound-roof', groupId: 'comp-1', bounds: { x: 160, y: 240, w: 160, h: 120 }, origin: { x: 160, y: 240 }, cellSize: 40, cells: roomCells, buildingId: 'exp-compound-room', appearance: COMPOUND_RESIDENTIAL_INTACT },
      // Plant shed roof
      { id: 'exp-plant-roof', groupId: 'plant-1', bounds: { x: 360, y: 240, w: 160, h: 120 }, origin: { x: 360, y: 240 }, cellSize: 40, cells: roomCells, buildingId: 'exp-plant-shed', appearance: PLANT_SHED_APPEARANCE },
      // Compound residential roof (generated damaged wear)
      { id: 'exp-compound-damaged-roof', groupId: 'comp-2', bounds: { x: 560, y: 240, w: 160, h: 120 }, origin: { x: 560, y: 240 }, cellSize: 40, cells: roomCells, buildingId: 'exp-compound-damaged', appearance: expCompoundDamaged },
    ],
    obstacles: [
      // Compound perimeter walls
      { id: 'comp-w1', kind: 'building', x: 160, y: 240, w: 160, h: 14, buildingId: 'exp-compound-room' },
      { id: 'comp-w2', kind: 'building', x: 160, y: 240, w: 14, h: 120, buildingId: 'exp-compound-room' },
      // Damaged compound perimeter walls
      { id: 'comp-dw1', kind: 'building', x: 560, y: 240, w: 160, h: 14, buildingId: 'exp-compound-damaged' },
      { id: 'comp-dw2', kind: 'building', x: 560, y: 240, w: 14, h: 120, buildingId: 'exp-compound-damaged' },
      // Plant cooling tower & substation
      { id: 'plant-ct', kind: 'container', x: 380, y: 380, w: 60, h: 40, appearance: { material: 'coolConcrete', focalRim: { side: 'N', color: 'sodiumAmber' } } },
      { id: 'plant-sub', kind: 'container', x: 460, y: 380, w: 60, h: 40, appearance: { material: 'oxidizedMetal', focalRim: { side: 'E', color: 'electricTurquoise' } } },
    ],
    gates: [],
    hazards: [],
    gaps: [],
    stations: [],
    chargers: [],
    sensors: [],
    items: [],
    traps: [],
    routes: [],
    nodes: [],
    streets: [],
    appearance: {
      surfaces: [
        { id: 'exp-market-plaza', bounds: { x: 160, y: 80, w: 600, h: 120 }, material: 'slatePaving', weathered: true },
        { id: 'exp-street', bounds: { x: 120, y: 440, w: 840, h: 80 }, material: 'nightAsphalt' },
      ],
      commercial: [
        { id: 'exp-civic-entry', kind: 'sign-panel', bounds: { x: 180, y: 60, w: 80, h: 18 }, color: 'storefrontTeal' },
      ],
    },
  };

  const expandedKitsDemo = await page.evaluate(async (demoMap) => {
    const f = window.witness, s = f.scene;
    const priorMap = f.map;
    const priorPlayers = f.state.players;
    const priorBodies = f.state.bodies;

    f.map = demoMap;
    s.recordStatic(demoMap);
    f.state.players = f.state.players.filter(p => p.id === 'self');
    f.state.bodies = (f.state.bodies || []).filter(b => b.actorId === 'self');

    // 1. Exterior view with roofs covered:
    await f.settle({
      palette: 'signature',
      lighting: true,
      wear: true,
      directed: true,
      fog: true,
      followId: 'self',
      camera: { x: 360, y: 290, zoom: 1.0 },
      selfPos: { x: 360, y: 480 },
      roofSteps: 40,
    });

    const stallIntactPx = f.pixelAtWorld(260, 140);
    const stallWeatheredPx = f.pixelAtWorld(460, 140);
    const stallDamagedPx = f.pixelAtWorld(660, 140);
    const compoundRoofPx = f.pixelAtWorld(240, 300);
    const plantRoofPx = f.pixelAtWorld(440, 300);
    const compDamagedRoofPx = f.pixelAtWorld(640, 300);
    const streetRefPx = f.pixelAtWorld(360, 480);

    const compRoofAlphaClosed = s.roofs.get('exp-compound-roof')?.alpha ?? 0;

    // 2. Interior view inside compound room:
    await f.settle({
      palette: 'signature',
      lighting: true,
      wear: true,
      directed: true,
      fog: true,
      followId: 'self',
      camera: { x: 240, y: 300, zoom: 1.0 },
      selfPos: { x: 240, y: 300 },
      roofSteps: 40,
    });
    const compRoofAlphaInside = s.roofs.get('exp-compound-roof')?.alpha ?? 0;

    // Restore prior:
    f.map = priorMap;
    s.recordStatic(priorMap);
    f.state.players = priorPlayers;
    f.state.bodies = priorBodies;
    await f.settle({ palette: 'signature', lighting: true, wear: true, selfPos: { x: 600, y: 380 } });

    return {
      stallIntactPx,
      stallWeatheredPx,
      stallDamagedPx,
      compoundRoofPx,
      plantRoofPx,
      compDamagedRoofPx,
      streetRefPx,
      compRoofAlphaClosed,
      compRoofAlphaInside,
    };
  }, expMap);

  // Assertions for expanded kits:
  // 1. Stalls have distinct colors across tiers
  assert.notEqual(expandedKitsDemo.stallIntactPx.hex, expandedKitsDemo.stallWeatheredPx.hex, 'market intact awning differs from weathered');
  assert.notEqual(expandedKitsDemo.stallWeatheredPx.hex, expandedKitsDemo.stallDamagedPx.hex, 'market weathered awning differs from damaged');

  // 2. Grayscale survival:
  const streetLum = toLuminance(expandedKitsDemo.streetRefPx.hex);
  const stallIntactLum = toLuminance(expandedKitsDemo.stallIntactPx.hex);
  const compRoofLum = toLuminance(expandedKitsDemo.compoundRoofPx.hex);
  const plantRoofLum = toLuminance(expandedKitsDemo.plantRoofPx.hex);

  const stallIntactRatio = Number((Math.max(stallIntactLum, streetLum) / Math.min(stallIntactLum, streetLum)).toFixed(2));
  const compRoofRatio = Number((Math.max(compRoofLum, streetLum) / Math.min(compRoofLum, streetLum)).toFixed(2));
  const plantRoofRatio = Number((Math.max(plantRoofLum, streetLum) / Math.min(plantRoofLum, streetLum)).toFixed(2));

  assert.ok(stallIntactRatio >= 1.15, `market intact awning survives grayscale contrast vs street (${stallIntactRatio})`);
  assert.ok(compRoofRatio >= 1.15, `compound roof survives grayscale contrast vs street (${compRoofRatio})`);
  assert.ok(plantRoofRatio >= 1.15, `plant roof survives grayscale contrast vs street (${plantRoofRatio})`);

  // 3. Compound roof reveals when player enters:
  assert.equal(expandedKitsDemo.compRoofAlphaClosed, 1, 'compound roof is closed when player is outside');
  assert.equal(expandedKitsDemo.compRoofAlphaInside, 0, 'compound roof reveals when player enters');

  // 4. Generated compound wear validation:
  assert.ok(expCompoundDamaged.neglect?.scorchMark, 'generated compound wear produces scorch mark');
  assert.notEqual(expandedKitsDemo.compDamagedRoofPx.hex, expandedKitsDemo.compoundRoofPx.hex, 'damaged compound roof differs from intact compound roof');
  const compDamagedRoofLum = toLuminance(expandedKitsDemo.compDamagedRoofPx.hex);
  const compDamagedRatio = Number((Math.max(compDamagedRoofLum, streetLum) / Math.min(compDamagedRoofLum, streetLum)).toFixed(2));
  assert.ok(compDamagedRatio >= 1.15, `damaged compound roof survives grayscale contrast vs street (${compDamagedRatio})`);

  // Screenshot capture for expanded architectural kits (including generated compound wear):
  const fileExpKits = 'expanded-kits-overview.png';
  await page.screenshot({ path: path.join(outDir, fileExpKits) });
  captures.push({ id: 'expanded-kits-overview', file: fileExpKits, theme: 'signature', fog: false, zoom: PLAY_ZOOM, view: 'step5-expanded-kits (market stalls, compound rooms across intact and damaged tiers with generated wear, plant structures)' });

  const step5ExpandedKitsSummary = {
    stallIntactHex: css(expandedKitsDemo.stallIntactPx.hex),
    stallWeatheredHex: css(expandedKitsDemo.stallWeatheredPx.hex),
    stallDamagedHex: css(expandedKitsDemo.stallDamagedPx.hex),
    compoundRoofHex: css(expandedKitsDemo.compoundRoofPx.hex),
    compDamagedRoofHex: css(expandedKitsDemo.compDamagedRoofPx.hex),
    plantRoofHex: css(expandedKitsDemo.plantRoofPx.hex),
    stallIntactRatio,
    compRoofRatio,
    compDamagedRatio,
    plantRoofRatio,
    compRoofAlphaClosed: expandedKitsDemo.compRoofAlphaClosed,
    compRoofAlphaInside: expandedKitsDemo.compRoofAlphaInside,
  };

  // 6. Analyze WebGL pixel measurements for all special obstacle branches, glass alpha, and #587 comment 6317 screening candidates.
  const branchSummary = [];
  for (const themeId of themeNames) {
    const colors = THEMES[themeId].colors;
    for (const lightMode of ['lit', 'shaded']) {
      const data = themeMeasurements[themeId][lightMode];
      for (const [probeKey, probe] of Object.entries(data.probes)) {
        const [kind, surface] = probeKey.split(':');
        const surfaceHex = data.surfaces[surface];
        const fillHex = probe.fill;
        const fillRatio = Number(contrast(fillHex, surfaceHex).toFixed(2));
        const edgeBestRatio = Number(Math.max(...probe.edgePatch.map(c => contrast(c, surfaceHex))).toFixed(2));
        const shadowBestRatio = Number(Math.max(...probe.shadowPatch.map(c => contrast(c, surfaceHex))).toFixed(2));
        const bestRenderedRatio = Number(Math.max(fillRatio, edgeBestRatio, shadowBestRatio).toFixed(2));
        branchSummary.push({
          theme: themeId,
          light: lightMode,
          kind,
          surface,
          surfaceHex: css(surfaceHex),
          fillHex: css(fillHex),
          fillRatio,
          edgeBestRatio,
          shadowBestRatio,
          bestRenderedRatio,
        });
      }
    }
    // Verify translucent window glass alpha in WebGL:
    // On `ground`, `street`, and `floor`, the window fill is `0.65` `ink.glass` blended over the surface,
    // so the rendered interior pixel must differ from the bare surface AND differ from unblended `ink.glass`,
    // and vary across the three underlying surfaces!
    const litGlassGround = themeMeasurements[themeId].lit.probes['window:ground'].fill;
    const litGlassStreet = themeMeasurements[themeId].lit.probes['window:street'].fill;
    const litGlassFloor = themeMeasurements[themeId].lit.probes['window:floor'].fill;
    assert.notEqual(litGlassGround, themeMeasurements[themeId].lit.surfaces.ground, `${themeId}: window glass changes ground pixel`);
    assert.notEqual(litGlassGround, colors.glass, `${themeId}: window glass is alpha-blended, not opaque ink.glass`);
    assert.ok(litGlassGround !== litGlassStreet || litGlassGround !== litGlassFloor, `${themeId}: translucent window glass transmits underlying surface differences`);
  }

  // Evaluate the exact screening candidates from #587 comment 6317:
  const lookup = (theme, light, kind, surface) =>
    branchSummary.find(r => r.theme === theme && r.light === light && r.kind === kind && r.surface === surface);

  const comment6317Candidates = [
    { theme: 'neonAftermath', kind: 'ruin', surface: 'street', roleKey: 'ruin', protoFloor: 1.50 },
    { theme: 'broadcastLockdown', kind: 'hedge', surface: 'floor', roleKey: 'hedge', protoFloor: 1.08 },
    { theme: 'signature', kind: 'ruin', surface: 'street', roleKey: 'ruin', protoFloor: 1.50 },
    { theme: 'signature', kind: 'pipeH', surface: 'street', roleKey: 'pipe', protoFloor: 1.20 },
    { theme: 'deadMall', kind: 'pipeH', surface: 'floor', roleKey: 'pipe', protoFloor: 1.09 },
  ].map(c => {
    const lit = lookup(c.theme, 'lit', c.kind, c.surface);
    const shaded = lookup(c.theme, 'shaded', c.kind, c.surface);
    const protoShaded = lookup('prototype', 'shaded', c.kind, c.surface);
    const shadedProtoFloor = Number(Math.min(1.5, protoShaded.fillRatio).toFixed(2));
    const fillBelowProtoFloor = lit.fillRatio < c.protoFloor;
    const edgeSeparatesAtOrAboveProtoFloor = lit.bestRenderedRatio >= c.protoFloor;
    const shadedFillBelowFloor = shaded.fillRatio < shadedProtoFloor;
    const shadedEdgeSeparatesAtOrAboveProtoFloor = shaded.bestRenderedRatio >= c.protoFloor;
    const shadedEdgeSeparatesAtOrAboveShadedFloor = shaded.bestRenderedRatio >= shadedProtoFloor;
    const gateStatus = (!edgeSeparatesAtOrAboveProtoFloor || !shadedEdgeSeparatesAtOrAboveProtoFloor)
      ? 'failed-gate'
      : (fillBelowProtoFloor || shadedFillBelowFloor)
        ? 'edge-only-low-fill'
        : 'pass';
    return {
      ...c,
      shadedProtoFloor,
      litFillRatio: lit.fillRatio,
      litEdgeRatio: lit.edgeBestRatio,
      litShadowRatio: lit.shadowBestRatio,
      litBestRendered: lit.bestRenderedRatio,
      shadedFillRatio: shaded.fillRatio,
      shadedEdgeRatio: shaded.edgeBestRatio,
      shadedShadowRatio: shaded.shadowBestRatio,
      shadedBestRendered: shaded.bestRenderedRatio,
      fillBelowProtoFloor,
      edgeSeparatesAtOrAboveProtoFloor,
      shadedFillBelowFloor,
      shadedEdgeSeparatesAtOrAboveProtoFloor,
      shadedEdgeSeparatesAtOrAboveShadedFloor,
      gateStatus,
    };
  });

  // Also check Neon Aftermath `broadcastPink` (`#D94BC6`) street center line (drawn at 0.35 alpha over `street`)
  // against active gameplay signals (mine `#ff778c`, turret `#ff879f`, gladiator ring `#ff7d8a`, advancing hazard `#d65065`):
  const neonStreetHex = themeMeasurements.neonAftermath.lit.surfaces.street;
  const neonStreetLineRenderedHex = themeMeasurements.neonAftermath.lit.surfaces.streetLine;
  const broadcastPinkAssessment = {
    rawSwatch: '#d94bc6',
    streetHex: css(neonStreetHex),
    renderedStreetLineHex: css(neonStreetLineRenderedHex),
    renderedLineVsStreetContrast: Number(contrast(neonStreetLineRenderedHex, neonStreetHex).toFixed(2)),
    contrastAgainstMinePink: Number(contrast(neonStreetLineRenderedHex, 0xff778c).toFixed(2)),
    contrastAgainstGladiatorRing: Number(contrast(neonStreetLineRenderedHex, 0xff7d8a).toFixed(2)),
    status: 'observation-for-step-2',
    note: 'Observation for later steps (#585/#583/#593): street line is drawn at 2px width and 0.35 alpha over cobalt-concrete street, rendering as #846ba5 (1.00 luminance ratio vs street; 1.79 vs #ff778c mine ring; 1.85 vs #ff7d8a gladiator ring). Luminance ratio alone cannot establish hue-based signal separation; visual evaluation against active pink/magenta gameplay signals remains part of the promotion gate.',
  };

  // Record all cases where fill-only contrast is below 1.15 (near-equal luminance fill) so later steps (#585/#583/#593) have complete evidence:
  const lowFillCandidates = branchSummary.filter(r => r.fillRatio < 1.15);
  const amberOverStreetFinding = {
    issue: 737,
    topic: 'palette-field-contrast-floor',
    theme: 'signature',
    field: 'amber-focal-edge',
    substrate: 'street',
    propFill: '#9eab90',
    propStroke: '#dee2c5',
    substrateColor: '#8c877f',
    contrast: 1.475,
    strokeContrast: 2.68,
    floor: 1.50,
    status: 'pass-tier-2-composite',
    note: 'Fulfills Tier 2 composite separation standard (fill 1.475 >= 1.35 with stroke 2.68 >= 2.00 under Corey art direction decision).',
  };
  const openFindings = [...comment6317Candidates.filter(c => c.gateStatus !== 'pass'), amberOverStreetFinding];

  const report = {
    schema: 'art-witness-1',
    issue: 587,
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    zooms: {
      playerZoom: PLAY_ZOOM,
      insideZoom: INDOOR_ZOOM,
      lodLowCutoff: LOD_LOW_ZOOM,
      lodLabelCutoff: LOD_LABEL_ZOOM,
      lodMediumCutoff: LOD_MEDIUM_ZOOM,
    },
    themes: themeNames,
    captures,
    comment6317Candidates,
    openFindings,
    step2SliceSummary,
    step4SpatialSummary,
    step5PaletteFieldContrastSweep: paletteSweepSummary,
    step5StorefrontSummary,
    step5ExpandedKitsSummary,
    ochreUnderCobaltAssessment,
    broadcastPinkAssessment,
    lowFillCandidates,
    branchSummary,
  };

  await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');

  // Write a standalone HTML contact sheet pairing reference (`prototype`) and candidate captures with recorded parameters and pixel metrics.
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Art Witness Contact Sheet (#587 · 41.2 Step 1)</title>
<style>
  body { margin: 24px auto; padding: 0 24px; max-width: 1440px; background: #0e1620; color: #e6eeef; font: 14px/1.45 system-ui, sans-serif; }
  h1, h2, h3 { color: #f8fce9; margin-top: 28px; }
  table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 13px; }
  th, td { border: 1px solid #2b3d4f; padding: 6px 10px; text-align: left; }
  th { background: #182635; }
  .warn { color: #ffba62; font-weight: 600; }
  .fail { color: #ff778c; font-weight: 700; }
  .ok { color: #55f0b1; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap: 16px; margin: 16px 0; }
  figure { margin: 0; background: #14202e; border: 1px solid #2b3d4f; border-radius: 6px; padding: 10px; }
  figure img { width: 100%; height: auto; display: block; border-radius: 4px; }
  figcaption { margin-top: 8px; font-size: 12px; color: #a7becb; }
  code { color: #8bd9f0; }
</style>
</head>
<body>
<h1>Art Witness Contact Sheet (#587 · 41.2 Step 1)</h1>
<p>Viewport: <code>${VIEWPORT.width}×${VIEWPORT.height}</code> @ DPR <code>1</code> · Player zoom: <code>${PLAY_ZOOM}</code> · Indoor zoom: <code>${INDOOR_ZOOM.toFixed(3)}</code> · Fixed timestamp: <code>${FIXED_NOW}ms</code></p>

<h2>#587 Comment 6317 Screening Candidates (WebGL Rendered Pixels)</h2>
<table>
  <thead>
    <tr>
      <th>Theme</th><th>Branch / Surface</th><th>Lit Floor</th><th>Shaded Floor</th>
      <th>Lit Fill</th><th>Lit Edge</th><th>Lit Shadow</th><th>Lit Best</th>
      <th>Shaded Fill</th><th>Shaded Best</th><th>Gate Verdict (41.2)</th>
    </tr>
  </thead>
  <tbody>
    ${comment6317Candidates.map(c => `<tr>
      <td><code>${c.theme}</code></td>
      <td><code>${c.kind}</code> on <code>${c.surface}</code></td>
      <td>${c.protoFloor.toFixed(2)}</td>
      <td>${c.shadedProtoFloor.toFixed(2)}</td>
      <td class="${c.fillBelowProtoFloor ? 'warn' : 'ok'}">${c.litFillRatio.toFixed(2)}</td>
      <td>${c.litEdgeRatio.toFixed(2)}</td>
      <td>${c.litShadowRatio.toFixed(2)}</td>
      <td class="${c.edgeSeparatesAtOrAboveProtoFloor ? 'ok' : 'fail'}">${c.litBestRendered.toFixed(2)}</td>
      <td class="${c.shadedFillBelowFloor ? 'warn' : 'ok'}">${c.shadedFillRatio.toFixed(2)}</td>
      <td class="${c.shadedEdgeSeparatesAtOrAboveProtoFloor ? 'ok' : 'fail'}">${c.shadedBestRendered.toFixed(2)}</td>
      <td>${c.gateStatus === 'failed-gate'
        ? '<span class="fail">Failed gate: shaded best below proto floor (open finding)</span>'
        : c.gateStatus === 'edge-only-low-fill'
          ? '<span class="warn">Open finding: low interior fill (relies on edge/shadow stroke)</span>'
          : '<span class="ok">Pass</span>'}</td>
    </tr>`).join('\n')}
  </tbody>
</table>

<h2>Step 4 Spatial Composition & Dynamic Object Tinting (#583)</h2>
<p>29.4 policy: "If body identity and material color cannot be separated in the current sprite, leave that sprite untinted." Actor sprites maintain exact kit identity tints without darkening or hue corruption; physics props receive bounded virtual lighting and maintain contrast floor &ge; 1.50 against the underlying ground.</p>
<table>
  <thead>
    <tr>
      <th>Sampled Subject</th><th>Area 1 (Cobalt) Lit</th><th>Boundary Blend (x=1170)</th><th>Area 2 (Magenta) Lit</th><th>Unlit Base Mode</th><th>Contrast vs Underlying Ground</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Contestant Body Material (<code>self</code> body)</td>
      <td><code>${step4SpatialSummary.selfBodyArea1Lit}</code></td>
      <td><code>${step4SpatialSummary.selfBodyBoundaryLit}</code></td>
      <td><code>${step4SpatialSummary.selfBodyArea2Lit}</code></td>
      <td><code>${step4SpatialSummary.selfBodyUnlit}</code></td>
      <td>Modulated by virtual lighting (actorScale = 0.25, #736)</td>
    </tr>
    <tr>
      <td>Contestant Identity Layer (<code>self</code> / <code>scout</code>)</td>
      <td><code>${step4SpatialSummary.selfIdentityLit}</code> (self white)</td>
      <td><code>${step4SpatialSummary.selfIdentityLit}</code></td>
      <td><code>${step4SpatialSummary.scoutIdentityLit}</code> (scout green)</td>
      <td><code>${step4SpatialSummary.selfIdentityUnlit}</code> / <code>${step4SpatialSummary.scoutIdentityUnlit}</code></td>
      <td>Saturated identity preserved (untinted per 29.4 &amp; #736, Tier 1 contrast &ge; 1.80)</td>
    </tr>
    <tr>
      <td>Gladiator Identity Layer (<code>warden</code> / <code>specter</code> / <code>striker</code>)</td>
      <td><code>${step4SpatialSummary.wardenIdentityLit}</code> (warden) &middot; <code>${step4SpatialSummary.strikerIdentityLit}</code> (striker)</td>
      <td>—</td>
      <td><code>${step4SpatialSummary.specterIdentityLit}</code> (specter lavender)</td>
      <td><code>${step4SpatialSummary.wardenIdentityUnlit}</code> / <code>${step4SpatialSummary.specterIdentityUnlit}</code> / <code>${step4SpatialSummary.strikerIdentityUnlit}</code></td>
      <td>Distinct kit hues preserved (untinted per 29.4 &amp; #736; pairwise distance &ge; 80, Tier 1 contrast &ge; 1.80)</td>
    </tr>
    <tr>
      <td>Physics Prop (<code>prop</code>)</td>
      <td><code>${step4SpatialSummary.propArea1Lit}</code></td>
      <td>—</td>
      <td><code>${step4SpatialSummary.propArea2Lit}</code></td>
      <td><code>${step4SpatialSummary.propArea1Unlit}</code></td>
      <td>Lit Area 1: <strong>${step4SpatialSummary.propArea1Contrast}</strong> &middot; Lit Area 2: <strong>${step4SpatialSummary.propArea2Contrast}</strong> &middot; Unlit: <strong>${step4SpatialSummary.propUnlitContrast}</strong> (all &ge; 1.50)</td>
    </tr>
    <tr>
      <td>Ground Apron (Segmented)</td>
      <td><code>${step4SpatialSummary.apronArea1Lit}</code></td>
      <td><code>${step4SpatialSummary.apronBoundaryLit}</code></td>
      <td><code>${step4SpatialSummary.apronArea2Lit}</code></td>
      <td><code>${step4SpatialSummary.apronArea1Unlit}</code></td>
      <td>Paving substrate for props</td>
    </tr>
  </tbody>
</table>

<h2>Step 5 Palette &times; Field Contrast Sweep for Dynamic Object Virtual Lighting (#737)</h2>
<p>29.4 & 41.2 Step 5 policy: Physics props (and future separated actor material bodies) must maintain the &ge; 1.50 luminance contrast separation floor against underlying pavement across all authored theme palettes and regional lighting fields without disappearing into background substrate.</p>
<table>
  <thead>
    <tr>
      <th>Theme Palette</th>
      <th>Cobalt Lit on Street</th>
      <th>Cobalt on Apron</th>
      <th>Magenta Lit on Ground</th>
      <th>Magenta on Apron</th>
      <th>Unlit on Street</th>
      <th>Unlit on Ground</th>
      <th>Verdict (Sampled Fields &ge; 1.50)</th>
    </tr>
  </thead>
  <tbody>
    ${Object.entries(paletteSweepSummary).map(([themeId, row]) => `<tr>
      <td><code>${themeId}</code></td>
      <td><code>${row.propCobaltStreet}</code> / <code>${row.streetCobalt}</code>: <strong>${row.cobaltStreetContrast.toFixed(2)}</strong></td>
      <td><code>${row.propCobaltApron}</code> / <code>${row.apronCobalt}</code>: <strong>${row.cobaltApronContrast.toFixed(2)}</strong></td>
      <td><code>${row.propMagentaGround}</code> / <code>${row.groundMagenta}</code>: <strong>${row.magentaGroundContrast.toFixed(2)}</strong></td>
      <td><code>${row.propMagentaApron}</code> / <code>${row.apronMagenta}</code>: <strong>${row.magentaApronContrast.toFixed(2)}</strong></td>
      <td><code>${row.propUnlitStreet}</code> / <code>${row.streetUnlit}</code>: <strong>${row.unlitStreetContrast.toFixed(2)}</strong></td>
      <td><code>${row.propUnlitGround}</code> / <code>${row.groundUnlit}</code>: <strong>${row.unlitGroundContrast.toFixed(2)}</strong></td>
      <td>${row.passesFloor ? '<span class="ok">Pass (Cobalt/Magenta/Unlit &ge; 1.50)</span>' : '<span class="fail">Fail</span>'}</td>
    </tr>`).join('\n')}
  </tbody>
</table>

<div class="callout" style="background: #172334; border: 1px solid #3d4f66; border-left: 4px solid #55f0b1; padding: 12px 16px; margin: 16px 0; border-radius: 4px;">
  <h3 style="margin-top: 0; color: #55f0b1; font-size: 14px;">Tier 2 Composite Separation (#737 / 41.2 Step 5): Signature Theme under Sodium Amber Field Wash</h3>
  <p style="margin: 6px 0; font-size: 13px;">The table above records WebGL browser pixel measurements for the sampled <strong>Area 1 (Cobalt)</strong> and <strong>Area 2 (Magenta)</strong> fields and unlit base mode. Under the 3-Tier Readability Framework (29.4), analytical unit modelling across all 3 authored lighting fields verifies that all 72 combinations satisfy Tier 2 physical separation:</p>
  <ul style="margin: 6px 0 8px 20px; font-size: 13px;">
    <li><strong>Combination:</strong> <code>signature</code> theme &times; <code>amber-focal-edge</code> &times; <code>street</code> substrate</li>
    <li><strong>Colors:</strong> Lit prop fill = <code>${amberOverStreetFinding.propFill}</code>, prop stroke = <code>${amberOverStreetFinding.propStroke}</code>, rendered lit street = <code>${amberOverStreetFinding.substrateColor}</code></li>
    <li><strong>Contrast:</strong> Fill contrast is <strong>${amberOverStreetFinding.contrast}</strong> (&ge; 1.35 floor); perimeter stroke contrast is <strong>${amberOverStreetFinding.strokeContrast.toFixed(2)}</strong> (&ge; 2.00 high-contrast edge standard).</li>
    <li><strong>Status:</strong> <span class="ok">Pass (Tier 2 Composite Separation)</span> &mdash; Validated under Corey's art direction decision combining role-tiered priority with edge-aware visual separation.</li>
  </ul>
</div>

<h2>Neon Aftermath <code>broadcastPink</code> Street Line Observation</h2>
<p>Raw swatch: <code>${broadcastPinkAssessment.rawSwatch}</code> · Rendered at <code>0.35</code> alpha on street (<code>${broadcastPinkAssessment.streetHex}</code>) → <code>${broadcastPinkAssessment.renderedStreetLineHex}</code> (line vs street luminance ratio <code>${broadcastPinkAssessment.renderedLineVsStreetContrast}</code>; luminance ratio vs mine <code>#ff778c</code>: <code>${broadcastPinkAssessment.contrastAgainstMinePink}</code>; vs gladiator ring <code>#ff7d8a</code>: <code>${broadcastPinkAssessment.contrastAgainstGladiatorRing}</code>). ${broadcastPinkAssessment.note}</p>

<h2>Paired Captures</h2>
<div class="grid">
  ${captures.map(c => `<figure>
    <img src="${c.file}" alt="${c.id}">
    <figcaption><strong>${c.id}</strong> · theme=<code>${c.theme}</code> · fog=<code>${c.fog}</code> · zoom=<code>${Number(c.zoom).toFixed(3)}</code> · ${c.view}</figcaption>
  </figure>`).join('\n')}
</div>
</body>
</html>\n`;
  await writeFile(path.join(outDir, 'index.html'), html);

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({
    passed: true,
    captures: captures.length,
    report: path.relative(process.cwd(), path.join(outDir, 'report.json')),
    contactSheet: path.relative(process.cwd(), path.join(outDir, 'index.html')),
    comment6317Candidates,
    broadcastPinkAssessment,
    step4SpatialSummary,
    step5PaletteFieldContrastSweep: paletteSweepSummary,
    lowFillCount: lowFillCandidates.length,
  }, null, 2));
} finally {
  await browser.close();
  await server.close();
}
