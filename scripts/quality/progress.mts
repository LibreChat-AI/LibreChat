import { dirname, resolve } from 'node:path';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { commonTokens, declareClassPlugin, PluginKind, tokens } from '@stryker-mutator/api/plugin';

import type { MutationTestingPlanReadyEvent, Reporter } from '@stryker-mutator/api/report';
import type { MutantResult, StrykerOptions } from '@stryker-mutator/api/core';

import type { mutationSelection } from './risk.mts';

type Target = ReturnType<typeof mutationSelection>[number];
type FunctionProgress = Target['functions'][number] & { file: string; ids: string[] };

const duration = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};
const compare = (a: { line: number; column: number }, b: typeof a) =>
  a.line - b.line || a.column - b.column;
const label = (fn: FunctionProgress) =>
  JSON.stringify(`${fn.file}:${fn.line}:${fn.column} ${fn.function}`);

/** Show completed work without guessing which of the pending mutants is running. */
export class FunctionProgressReporter implements Reporter {
  static inject = tokens(commonTokens.options);

  private readonly output: string;
  private readonly staticMutants: boolean;
  private readonly functions: FunctionProgress[];
  private readonly planned = new Map<string, { owner: FunctionProgress; static: boolean }>();
  private readonly results = new Map<string, Readonly<MutantResult>>();
  private readonly started = Date.now();
  private readonly timer: ReturnType<typeof setInterval>;
  private lastResult?: number;
  private phase = 'Preparing mutants and running baseline tests';
  private planReady = false;
  private complete = false;

  constructor(
    options: Pick<StrykerOptions, 'jsonReporter'> & Partial<Pick<StrykerOptions, 'ignoreStatic'>>,
  ) {
    this.staticMutants = !options.ignoreStatic;
    this.output = dirname(options.jsonReporter.fileName);
    const targets: Target[] = JSON.parse(readFileSync(`${this.output}/functions.json`, 'utf8'));
    this.functions = targets.flatMap(({ file, functions }) =>
      functions.map((fn) => ({ ...fn, file, ids: [] })),
    );
    writeFileSync(`${this.output}/progress.jsonl`, '');
    this.render();
    this.timer = setInterval(() => this.render(), 30000);
    this.timer.unref();
  }

  onDryRunCompleted() {
    this.phase = 'Baseline passed; preparing mutation test plan';
    this.render();
  }

  onMutationTestingPlanReady({ mutantPlans }: MutationTestingPlanReadyEvent) {
    for (const { mutant } of mutantPlans) {
      // Stryker plans use zero-based positions; completed results use one-based positions.
      const start = {
        line: mutant.location.start.line + 1,
        column: mutant.location.start.column + 1,
      };
      const end = { line: mutant.location.end.line + 1, column: mutant.location.end.column + 1 };
      const owner = this.functions
        .filter(
          (fn) =>
            resolve(fn.file) === resolve(mutant.fileName) &&
            compare(fn.location.start, start) <= 0 &&
            compare(end, fn.location.end) <= 0,
        )
        .sort(
          (a, b) =>
            compare(b.location.start, a.location.start) || compare(a.location.end, b.location.end),
        )[0];
      if (!owner) throw new Error(`No selected function owns mutant ${mutant.id}`);
      owner.ids.push(mutant.id);
      this.planned.set(mutant.id, { owner, static: mutant.static === true });
    }
    this.planReady = true;
    this.phase = 'Testing mutations';
    for (const fn of this.functions) {
      this.log(
        `PLAN ${label(fn)} | mutants=${fn.ids.length} static=${this.staticIds(fn.ids).length}`,
      );
    }
    this.render();
  }

  onMutantTested(result: Readonly<MutantResult>) {
    if (this.results.has(result.id)) return;
    const plan = this.planned.get(result.id);
    if (!plan) throw new Error(`No mutation plan for result ${result.id}`);
    const finished = Date.now();
    appendFileSync(
      `${this.output}/progress.jsonl`,
      `${JSON.stringify({ elapsedMs: finished - this.started, ...result })}\n`,
    );
    this.results.set(result.id, result);
    this.lastResult = finished;
    if (plan.owner.ids.every((id) => this.results.has(id))) {
      this.log(`DONE ${label(plan.owner)} | ${this.counts(plan.owner.ids)}`);
    }
  }

  onMutationTestReportReady() {
    this.complete = this.planReady && this.results.size === this.planned.size;
    this.phase = this.complete ? 'Complete' : 'Incomplete report';
    clearInterval(this.timer);
    this.render();
  }

  wrapUp() {
    clearInterval(this.timer);
    if (!this.complete) {
      this.phase = 'Stopped before completion';
      this.render();
    }
  }

  private staticIds(ids: string[]) {
    return ids.filter((id) => this.planned.get(id)?.static);
  }

  private counts(ids: string[]) {
    const statuses = new Map<string, number>();
    for (const id of ids) {
      const status = this.results.get(id)?.status;
      if (status) statuses.set(status, (statuses.get(status) ?? 0) + 1);
    }
    return [...statuses].map(([status, count]) => `${status}=${count}`).join(' ');
  }

  private log(message: string) {
    console.log(
      `[mutation ${duration(Date.now() - this.started)} static=${this.staticMutants ? 'on' : 'off'}] ${message}`,
    );
  }

  private render() {
    const ids = [...this.planned.keys()];
    const staticIds = this.staticIds(ids);
    const completed = (list: string[]) => list.filter((id) => this.results.has(id)).length;
    const functions = this.functions.map((fn) => ({
      file: fn.file,
      function: fn.function,
      line: fn.line,
      column: fn.column,
      completed: completed(fn.ids),
      total: fn.ids.length,
      staticCompleted: completed(this.staticIds(fn.ids)),
      staticTotal: this.staticIds(fn.ids).length,
    }));
    const snapshot = {
      phase: this.phase,
      staticMutants: this.staticMutants,
      complete: this.complete,
      elapsedMs: Date.now() - this.started,
      lastResultAgeMs: this.lastResult === undefined ? null : Date.now() - this.lastResult,
      completed: this.results.size,
      total: ids.length,
      staticCompleted: completed(staticIds),
      staticTotal: staticIds.length,
      functions,
    };
    writeFileSync(`${this.output}/progress.json`, JSON.stringify(snapshot, null, 2));
    if (!this.planReady) {
      this.log(this.phase);
      return;
    }
    const last =
      snapshot.lastResultAgeMs === null ? 'none yet' : `${duration(snapshot.lastResultAgeMs)} ago`;
    this.log(
      `${this.phase} | completed=${snapshot.completed}/${snapshot.total} ` +
        `static=${snapshot.staticCompleted}/${snapshot.staticTotal} ` +
        `other=${snapshot.completed - snapshot.staticCompleted}/${snapshot.total - snapshot.staticTotal} ` +
        `last result=${last}`,
    );
    if (this.phase === 'Testing mutations' || this.phase === 'Stopped before completion') {
      for (const [index, fn] of functions.entries()) {
        if (fn.completed < fn.total) {
          this.log(
            `PENDING ${label(this.functions[index])} | completed=${fn.completed}/${fn.total} ` +
              `static=${fn.staticCompleted}/${fn.staticTotal}`,
          );
        }
      }
    }
  }
}

export const strykerPlugins = [
  declareClassPlugin(PluginKind.Reporter, 'function-progress', FunctionProgressReporter),
];
