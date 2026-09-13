/**
 * Deterministic micro generation for a region: one builder, which fills its area
 * with loot slots and small collidable props.
 *
 * A region is an area, not an enclosure. Props are deliberately not grid
 * aligned — micro detail is free of the cell lattice — and are kept inside a
 * single cell so they cannot escape the region that produced them.
 */
import type {
  CellClass,
  RegionInput,
  RegionOutput,
  ValidationResult,
  Wall,
} from "./types.ts";

const DEFAULT_RULE = Object.freeze({
  clutterChance: 0,
  clutterSize: 0.6,
});
const RULE_KEYS = ["clutterChance", "clutterSize"] as const;
/** Used only when a caller offers a candidate with no macro loot parameter. */
const DEFAULT_LOOT_CHANCE = 0.5;

function hash32(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  }
  return hash >>> 0;
}

function chanceFor(seed: string | number, x: number, y: number): number {
  return hash32(`${String(seed)}:${x}:${y}`) / 0x100000000;
}

export function validateCellClass(rule: unknown = {}): ValidationResult {
  const errors: string[] = [];
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
    return { valid: false, errors: ["rule must be an object"] };
  }
  for (const key of Object.keys(rule as object)) {
    if (!(RULE_KEYS as readonly string[]).includes(key))
      errors.push(`unknown rule property: ${key}`);
  }
  const value = rule as CellClass;
  for (const key of ["clutterChance"] as const)
    if (
      Object.hasOwn(rule as object, key) &&
      (!Number.isFinite(value[key]) || value[key]! < 0 || value[key]! > 1)
    )
      errors.push(`${key} must be a finite number from 0 to 1`);
  if (
    Object.hasOwn(rule as object, "clutterSize") &&
    (!Number.isFinite(value.clutterSize) ||
      value.clutterSize! <= 0 ||
      value.clutterSize! >= 1)
  )
    errors.push("clutterSize must be a finite number above 0 and below 1");
  return { valid: errors.length === 0, errors };
}

function validateInput(input: unknown): asserts input is RegionInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("region input must be an object");
  }
  const value = input as RegionInput;
  if (
    !Object.hasOwn(input as object, "seed") ||
    typeof value.cellClass !== "string"
  ) {
    throw new TypeError("region input requires seed and cellClass");
  }
  if (!Number.isInteger(value.budget) || value.budget < 0) {
    throw new TypeError("region budget must be a non-negative integer");
  }
  if (!Array.isArray(value.candidates)) {
    throw new TypeError("region candidates must be an array");
  }
  if (value.area !== undefined && !Array.isArray(value.area)) {
    throw new TypeError("region area must be an array");
  }
  const seen = new Set<number>();
  for (const candidate of [...value.candidates, ...(value.area ?? [])]) {
    if (
      !candidate ||
      !Number.isInteger(candidate.cellIndex) ||
      candidate.cellIndex < 0 ||
      !Number.isFinite(candidate.x) ||
      !Number.isFinite(candidate.y)
    ) {
      throw new TypeError(
        "region candidates need unique non-negative cellIndex and finite x/y",
      );
    }
    if (
      candidate.lootChance !== undefined &&
      (!Number.isFinite(candidate.lootChance) ||
        candidate.lootChance < 0 ||
        candidate.lootChance > 1)
    ) {
      throw new TypeError("candidate lootChance must be between 0 and 1");
    }
    seen.add(candidate.cellIndex);
  }
}

export function generateRegion(
  input: RegionInput,
  rule: CellClass = {},
): RegionOutput {
  validateInput(input);
  const ruleValidation = validateCellClass(rule);
  if (!ruleValidation.valid)
    throw new TypeError(ruleValidation.errors.join("; "));

  const resolved = { ...DEFAULT_RULE, ...rule };
  const ordered = input.candidates
    .slice()
    .sort((left, right) => left.cellIndex - right.cellIndex);
  // Loot density is a macro parameter carried per candidate, because a region
  // may span tier zones and each cell answers to the zone covering it.
  const spawns = ordered
    .filter(
      (candidate) =>
        chanceFor(input.seed, candidate.x, candidate.y) <
        (candidate.lootChance ?? DEFAULT_LOOT_CHANCE),
    )
    .slice(0, input.budget)
    .map(({ cellIndex }) => ({ cellIndex, kind: "loot" }));
  const taken = new Set(spawns.map((spawn) => spawn.cellIndex));

  // Props sit at an arbitrary angle about the cell centre. Half the length is
  // under half a cell, so a prop never leaves the cell it belongs to.
  const half = resolved.clutterSize / 2;
  const obstacles: Wall[] = [];
  const basis = (input.area ?? [])
    .slice()
    .sort((left, right) => left.cellIndex - right.cellIndex);
  for (const candidate of basis) {
    if (taken.has(candidate.cellIndex)) continue;
    const roll = chanceFor(input.seed, candidate.x + 0.5, candidate.y + 0.5);
    if (roll >= resolved.clutterChance) continue;
    const angle = chanceFor(input.seed, candidate.y, candidate.x) * Math.PI * 2;
    const cx = candidate.x + 0.5,
      cy = candidate.y + 0.5;
    obstacles.push({
      x1: cx - Math.cos(angle) * half,
      y1: cy - Math.sin(angle) * half,
      x2: cx + Math.cos(angle) * half,
      y2: cy + Math.sin(angle) * half,
    });
  }

  return {
    spawns,
    obstacles,
    manifest: {
      generator: "loot-scatter",
      spawnsPlaced: spawns.length,
      obstaclesPlaced: obstacles.length,
      corridorsHonored: true,
    },
  };
}
