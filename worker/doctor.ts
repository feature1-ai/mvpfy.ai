import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Is this runner able to do its job? Each check is one question with
 * evidence for an answer, asked without building anything, so a person can
 * ask it from the Runners screen and have the answer in under a minute.
 *
 * The checks are handed in, so this file decides only how they are run and
 * reported: in order, each one bounded in time, every one asked even after
 * one fails — a runner signed out of GitHub may still have a working engine,
 * and the person fixing it wants the whole list at once.
 */

export interface DoctorCheck {
  name: string;
  /** Resolves with what was found when it holds. Throws, with why, when it does not. */
  run(): Promise<string>;
}

export interface DoctorResult {
  name: string;
  ok: boolean;
  detail: string;
}

const LIMIT_MS = 20_000;

export async function runDoctor(
  checks: DoctorCheck[],
  timeoutMs: number = LIMIT_MS
): Promise<DoctorResult[]> {
  const results: DoctorResult[] = [];
  for (const check of checks) {
    let timer: NodeJS.Timeout | undefined;
    try {
      const detail = await Promise.race([
        check.run(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`no answer in ${timeoutMs / 1000}s`)),
            timeoutMs
          );
        }),
      ]);
      results.push({ name: check.name, ok: true, detail });
    } catch (error) {
      results.push({ name: check.name, ok: false, detail: (error as Error).message });
    } finally {
      clearTimeout(timer);
    }
  }
  return results;
}

/** One line per check, for a person and for mvpfy cloud, which reads the `CHECK` lines. */
export function doctorLines(results: DoctorResult[]): string[] {
  return results.map((r) => `CHECK ${JSON.stringify(r)}`);
}

/** A check that a file left on the worker's volume is there. */
export function fileCheck(name: string, file: string, found: string, missing: string): DoctorCheck {
  return {
    name,
    run: async () => {
      if (!fs.existsSync(file)) throw new Error(missing);
      return found;
    },
  };
}

export function recipeFile(root: string, repositoryId: string): string {
  return path.join(root, 'recipes', repositoryId, 'mvpfy.yml');
}
