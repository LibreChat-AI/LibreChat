import { ErrorTypes } from 'librechat-data-provider';
import type { ErrorRendererProps } from './parts';
import type { TranslationKeys } from '~/hooks';
import {
  ErrorBody,
  ErrorDetails,
  formatNumber,
  readNumber,
  readString,
  useErrorEndpoint,
} from './parts';
import { useLocalize } from '~/hooks';

const emptyMessagesBoilerplate = [
  'Message pruning removed all messages as none fit in the context window.',
  'Please increase the context window size or make your message shorter.',
];

const compactionSkippedKeys: Record<string, TranslationKeys> = {
  disabled: 'com_error_compaction_disabled',
  instructions_exceed_budget: 'com_error_compaction_budget',
  nothing_to_summarize: 'com_error_compaction_nothing',
};

function parseInputLength(info: string | undefined): [number, number] | undefined {
  if (info == null) {
    return undefined;
  }

  const values = info.split('/').map((part) => part.trim());
  if (values.length !== 2 || values.some((value) => value === '')) {
    return undefined;
  }

  const numbers = values.map(Number);
  return numbers.every((value) => Number.isFinite(value) && Number.isInteger(value))
    ? (numbers as [number, number])
    : undefined;
}

function formatDetailNumbers(detail: string): string {
  return detail.replace(/\b\d+(?:\.\d+)?\b/g, (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? formatNumber(number) : value;
  });
}

function formatEmptyMessagesDetail(detail: string) {
  const entries = detail
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const isBudgetSentence =
    entries.length > 1 &&
    /^Token budget\s*:/i.test(entries[0]) &&
    entries.every((entry) => /\b\d+(?:\.\d+)?\b/.test(entry));

  if (!isBudgetSentence) {
    return formatDetailNumbers(detail);
  }

  return (
    <ul className="list-none space-y-0.5">
      {entries.map((entry, index) => (
        <li key={`${index}-${entry}`}>{formatDetailNumbers(entry)}</li>
      ))}
    </ul>
  );
}

function hasTextBeyondNumbers(
  info: string | undefined,
  projected: number | undefined,
  available: number | undefined,
): boolean {
  if (info == null || info.trim() === '') {
    return false;
  }
  if (projected == null || available == null) {
    return true;
  }

  const parsed = parseInputLength(info);
  return parsed == null || parsed[0] !== projected || parsed[1] !== available;
}

export default function ContextError({ json, message }: ErrorRendererProps) {
  const localize = useLocalize();
  const { compactionAvailable } = useErrorEndpoint(message);
  const errorType = readString(json, 'type');
  const nextSteps = localize(
    compactionAvailable ? 'com_error_context_next_steps_compact' : 'com_error_context_next_steps',
  );

  if (errorType === ErrorTypes.INPUT_LENGTH) {
    const info = readString(json, 'info');
    const parsed = parseInputLength(info);
    const headline =
      parsed == null
        ? localize('com_error_input_length_unknown')
        : localize('com_error_input_length', {
            0: formatNumber(parsed[0]),
            1: formatNumber(parsed[1]),
          });

    /** The latest message alone exceeds the limit; compacting earlier history cannot make it fit. */
    return (
      <ErrorBody>
        <p>{headline}</p>
        <p className="text-text-secondary">{localize('com_error_context_next_steps')}</p>
        {info != null && parsed == null && (
          <ErrorDetails label={localize('com_error_context_token_budget')}>{info}</ErrorDetails>
        )}
      </ErrorBody>
    );
  }

  if (errorType === ErrorTypes.FINAL_CONTEXT_OVERFLOW) {
    const projected = readNumber(json, 'projectedMessageTokens');
    const available = readNumber(json, 'availableMessageTokens');
    const info = readString(json, 'info');
    const headline =
      projected != null && available != null
        ? localize('com_error_final_context_overflow', {
            0: formatNumber(projected),
            1: formatNumber(available),
          })
        : localize('com_error_final_context_overflow_unknown');

    return (
      <ErrorBody>
        <p>{headline}</p>
        <p className="text-text-secondary">{nextSteps}</p>
        {hasTextBeyondNumbers(info, projected, available) && (
          <ErrorDetails label={localize('com_error_context_token_budget')}>{info}</ErrorDetails>
        )}
      </ErrorBody>
    );
  }

  if (errorType === ErrorTypes.EMPTY_MESSAGES) {
    const info = readString(json, 'info');
    const detail = emptyMessagesBoilerplate
      .reduce((remaining, sentence) => remaining.replace(sentence, ''), info ?? '')
      .trim();

    return (
      <ErrorBody>
        <p>{localize('com_error_empty_messages')}</p>
        <p className="text-text-secondary">{nextSteps}</p>
        {detail && (
          <ErrorDetails label={localize('com_error_context_token_budget')}>
            {formatEmptyMessagesDetail(detail)}
          </ErrorDetails>
        )}
      </ErrorBody>
    );
  }

  if (errorType === ErrorTypes.COMPACTION_SKIPPED) {
    const reason = readString(json, 'reason');
    return localize(compactionSkippedKeys[reason ?? ''] ?? 'com_error_compaction_failed');
  }

  return localize('com_error_unknown');
}
