/** Deterministic resource accounting shared by decomposition operations.
 * Units are charged before work: input/copy visits, neighbor probes, scan slots,
 * and size-based sort allowances n * (1 + ceil(log2(n))). They are not time.
 */
export const DEFAULT_WORK_LIMIT = 20_000_000;

export class WorkBudgetExceededError extends Error {
  readonly code = 'DECOMPOSITION_WORK_BUDGET_EXCEEDED';
  readonly limit: number;
  readonly used: number;
  constructor(limit: number, used: number) {
    super(`Decomposition work budget exhausted: used ${used}, limit ${limit}`);
    this.name = 'WorkBudgetExceededError';
    this.limit = limit; this.used = used;
  }
}

export class WorkBudget {
  private consumed = 0;
  private exhausted = false;
  readonly limit: number;
  constructor(limit = DEFAULT_WORK_LIMIT) {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > Number.MAX_SAFE_INTEGER)
      throw new Error('Work budget limit must be a nonnegative safe integer at most MAX_SAFE_INTEGER');
    this.limit = limit;
  }
  get used(): number { return this.consumed; }
  /** Charges attempted work, including the refused charge. Huge box estimates
   * saturate at MAX_SAFE_INTEGER; they cannot overflow or wrap past the limit.
   * An exhausted budget stays exhausted and must not be reused for fallback.
   */
  spend(units = 1): void {
    if (typeof units !== 'number' || Number.isNaN(units) || units < 0 || !Number.isInteger(units) && units !== Infinity)
      throw new Error('Work budget charges must be nonnegative integers');
    if (this.exhausted) throw new WorkBudgetExceededError(this.limit, this.consumed);
    const overflow = units > Number.MAX_SAFE_INTEGER - this.consumed;
    this.consumed = Math.min(Number.MAX_SAFE_INTEGER, this.consumed + units);
    if (overflow || this.consumed > this.limit) { this.exhausted = true; throw new WorkBudgetExceededError(this.limit, this.consumed); }
  }
}

export const createWorkBudget = (limit = DEFAULT_WORK_LIMIT): WorkBudget => new WorkBudget(limit);
