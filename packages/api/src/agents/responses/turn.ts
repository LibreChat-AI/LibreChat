import type { ResponseStageInput, ResponsePersistenceDependencies } from './foreground';
import type { ResponseExecutionRuntime } from './runtime';
import {
  createResponseTerminal,
  createResponsePersistence,
  stageResponseResult,
} from './foreground';

type TurnSaved = Awaited<ReturnType<ReturnType<typeof createResponsePersistence>['saveOutput']>>;
type TurnExecution = Parameters<ResponseExecutionRuntime['completeTurn']>[0]['execution'];
type TurnTerminal = ReturnType<typeof createResponseTerminal<TurnSaved, TurnExecution>>;

export interface ResponseTurn {
  hooks: Omit<
    ResponseExecutionRuntime['hooks'],
    'beforeSettle' | 'afterSettle' | 'onSettlementError'
  > &
    Pick<TurnTerminal, 'beforeSettle' | 'afterSettle' | 'onSettlementError'>;
  beforeSettle: TurnTerminal['beforeSettle'];
  stage(
    input: Omit<Parameters<typeof stageResponseTurn>[0], 'runtime' | 'terminal'>,
    deps: ResponsePersistenceDependencies,
  ): Promise<void>;
}

/** Bind persistence, pause and terminal ownership once so callers cannot drop the runtime owner. */
export function createResponseTurn({
  runtime,
  ...options
}: Omit<Parameters<typeof createResponseTerminal>[0], 'completion'> & {
  runtime: ResponseExecutionRuntime;
}): ResponseTurn {
  const terminal = createResponseTerminal<TurnSaved, TurnExecution>({
    ...options,
    completion: runtime.completion,
  });
  return {
    hooks: {
      ...runtime.hooks,
      beforeSettle: terminal.beforeSettle,
      afterSettle: terminal.afterSettle,
      onSettlementError: terminal.onSettlementError,
    },
    beforeSettle: terminal.beforeSettle,
    stage(
      input: Omit<Parameters<typeof stageResponseTurn>[0], 'runtime' | 'terminal'>,
      deps: ResponsePersistenceDependencies,
    ) {
      return stageResponseTurn({ ...input, runtime, terminal }, deps);
    },
  };
}

/** One composition point for ordinary completion, durable pause and resumed output. */
export async function stageResponseTurn(
  {
    runtime,
    run,
    execution,
    agents,
    ...input
  }: ResponseStageInput & {
    runtime: ResponseExecutionRuntime;
    run: Parameters<ResponseExecutionRuntime['completeTurn']>[0]['run'];
    execution: Parameters<ResponseExecutionRuntime['completeTurn']>[0]['execution'];
    agents: Parameters<ResponseExecutionRuntime['completeTurn']>[0]['agents'];
  },
  deps: ResponsePersistenceDependencies,
): Promise<void> {
  const visibleOutputTokens = input.visibleOutputTokens ?? input.response.usage?.output_tokens ?? 0;
  const persistence = createResponsePersistence(
    { ...input, visibleOutputTokens: runtime.visibleOutputTokens(visibleOutputTokens) },
    deps,
  );
  await runtime.completeTurn(
    {
      run,
      execution,
      agents,
      buildPartial: () => input.response,
      visibleOutputTokens,
      persistence: {
        saveConversation: persistence.saveConversation,
        saveInput: persistence.saveInput,
        saveOutput: async (partial) => {
          await persistence.saveOutput(partial);
        },
      },
    },
    async () => {
      stageResponseResult(
        { ...input, response: runtime.composeResponse(input.response) },
        persistence,
      );
    },
  );
}
