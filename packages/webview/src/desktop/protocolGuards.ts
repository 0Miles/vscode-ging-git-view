/* What every desktop protocol under desktop/ checks its messages with: the
 * compile-time guard that keeps its commands apart from the graph's
 * (ADR-0031), and the runtime shape checks. Imported by the host as well as
 * the page, so it touches nothing but its arguments. */

/** True when `A` and `B` share no command name. */
export type NoCommandShared<A extends string, B extends string> = [Extract<A, B>] extends [never]
  ? true
  : false;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === "string");
