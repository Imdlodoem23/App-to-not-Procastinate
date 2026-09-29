/**
 * Coach test helpers (owner: COACH): a scripted `CoachModel` and a scan of every table for text
 * that must never be stored.
 */
import { sql } from 'drizzle-orm';
import type {
  CoachModel,
  CoachModelAttempt,
  CoachModelRequest,
  CoachModelResult,
} from '../../src/coach/model';
import type { Db } from '../../src/db/client';

export type Script = (
  request: CoachModelRequest<unknown>,
) => CoachModelResult<unknown> | Promise<CoachModelResult<unknown>>;

export interface FakeCoachModel extends CoachModel {
  calls: Array<CoachModelRequest<unknown>>;
  script: Script;
}

export const attempt = (overrides: Partial<CoachModelAttempt> = {}): CoachModelAttempt => ({
  model: 'claude-opus-5',
  inputTokens: 1200,
  outputTokens: 400,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...overrides,
});

export const ok = (output: unknown, attempts = [attempt()]): CoachModelResult<unknown> => ({
  kind: 'ok',
  output,
  attempts,
});

/** A model that answers with `script` (replaceable per test) and records every request. */
export function fakeCoachModel(script: Script = () => ({ kind: 'incomplete', attempts: [] })) {
  const fake: FakeCoachModel = {
    calls: [],
    script,
    async run<T>(request: CoachModelRequest<T>): Promise<CoachModelResult<T>> {
      fake.calls.push(request as CoachModelRequest<unknown>);
      const result = await fake.script(request as CoachModelRequest<unknown>);
      // The fixture must match what structured outputs would allow.
      if (result.kind === 'ok') request.schema.parse(result.output);
      return result as CoachModelResult<T>;
    },
  };
  return fake;
}

/** Every row of every table in the public schema, as one JSON string. */
export async function dumpAllTables(db: Db): Promise<string> {
  const tables = await db.execute<{ table_name: string }>(
    sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
  );
  const rowsOf = (result: unknown): unknown[] =>
    Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
  const out: string[] = [];
  for (const t of rowsOf(tables) as Array<{ table_name: string }>) {
    const rows = await db.execute(sql.raw(`SELECT row_to_json(t) AS r FROM "${t.table_name}" t`));
    out.push(`${t.table_name}: ${JSON.stringify(rowsOf(rows))}`);
  }
  return out.join('\n');
}
