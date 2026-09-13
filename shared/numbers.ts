/**
 * `Number.isFinite` as a type guard. Client input arrives with any field possibly absent, and
 * every axis, aim and coordinate read has to reject NaN and Infinity as well as undefined.
 */
export function finite(value: unknown): value is number {
  return Number.isFinite(value);
}

/** `Number.isInteger` as a type guard, for slot indices arriving from a client. */
export function integer(value: unknown): value is number {
  return Number.isInteger(value);
}

/** `Number.isSafeInteger` as a type guard, for client sequence numbers. */
export function safeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value);
}
