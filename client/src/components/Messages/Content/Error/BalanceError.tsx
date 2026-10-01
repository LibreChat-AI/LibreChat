import type { ErrorRendererProps, JsonValue } from './parts';
import {
  ErrorBody,
  ErrorDetails,
  formatCredits,
  formatNumber,
  readNumber,
  readString,
} from './parts';
import { useLocalize } from '~/hooks';

type GenerationRow = {
  model: string;
  promptTokens: string;
  completionTokens: string;
};

function readGeneration(generation: JsonValue): GenerationRow | null {
  if (typeof generation !== 'object' || generation === null || Array.isArray(generation)) {
    return null;
  }

  const model = readString(generation, 'model');
  const promptTokens = readNumber(generation, 'promptTokens');
  const completionTokens = readNumber(generation, 'completionTokens');

  if (model == null && promptTokens == null && completionTokens == null) {
    return null;
  }

  const availableTokens = [
    promptTokens != null ? formatNumber(promptTokens) : null,
    completionTokens != null ? formatNumber(completionTokens) : null,
  ].filter((token): token is string => token != null);

  return {
    model: model ?? availableTokens.join(', '),
    promptTokens: promptTokens != null ? formatNumber(promptTokens) : '—',
    completionTokens: completionTokens != null ? formatNumber(completionTokens) : '—',
  };
}

export default function BalanceError({ json }: ErrorRendererProps) {
  const localize = useLocalize();
  const balance = readNumber(json, 'balance');
  const tokenCost = readNumber(json, 'tokenCost');
  const promptTokens = readNumber(json, 'promptTokens');
  const generations = Array.isArray(json.generations)
    ? json.generations.map(readGeneration).filter((row): row is GenerationRow => row != null)
    : [];

  const summary =
    tokenCost != null && balance != null
      ? localize('com_error_token_balance', {
          0: formatCredits(tokenCost),
          1: formatCredits(balance),
        })
      : localize('com_error_limit_reached');

  return (
    <ErrorBody>
      <p>{summary}</p>
      {promptTokens != null ? (
        <p className="text-text-secondary">
          {localize('com_error_token_balance_prompt', { 0: formatNumber(promptTokens) })}
        </p>
      ) : null}
      {generations.length > 0 ? (
        <ErrorDetails label={localize('com_error_token_balance_generations')}>
          <ul className="list-none space-y-0.5">
            {generations.map((generation, index) => (
              <li key={index}>
                {localize('com_error_token_balance_generation', {
                  0: generation.model,
                  1: generation.promptTokens,
                  2: generation.completionTokens,
                })}
              </li>
            ))}
          </ul>
        </ErrorDetails>
      ) : null}
    </ErrorBody>
  );
}
