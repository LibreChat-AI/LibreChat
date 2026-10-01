import { ErrorTypes, stripLangChainTroubleshootingUrl } from 'librechat-data-provider';
import type { ErrorPayload, ErrorRendererProps, UnclassifiedErrorProps } from './parts';
import {
  ErrorBody,
  ErrorDetails,
  ErrorWithDetail,
  readObject,
  readString,
  useErrorEndpoint,
} from './parts';
import { extractJson } from '~/utils/json';
import { useLocalize } from '~/hooks';

function withHeadline(
  headline: string,
  detail?: { label: string; value: string },
): JSX.Element | string {
  if (detail == null) {
    return headline;
  }

  return (
    <ErrorBody>
      <div>{headline}</div>
      <ErrorDetails label={detail.label}>{detail.value}</ErrorDetails>
    </ErrorBody>
  );
}

/**
 * A refusal's explanation. Anthropic reports one under `stop_details`, which the server persists
 * inside `info` with the rest of the stop metadata; a Bedrock content filter reports none. A plain
 * string `info` is read as the explanation too.
 */
function readRefusalExplanation(json: ErrorPayload): string | undefined {
  return (
    readString(json, 'info') ??
    readString(readObject(readObject(json, 'info'), 'stop_details'), 'explanation')
  );
}

/** A provider's own message, flat or nested under `error` the way OpenAI-style bodies carry it. */
function readProviderError(json: ErrorPayload | undefined): string | undefined {
  return readString(json, 'error') ?? readString(readObject(json, 'error'), 'message');
}

/** Renders provider-produced failures with identity-aware copy and readable provider details. */
export default function ProviderError({ json, message }: ErrorRendererProps) {
  const localize = useLocalize();
  const { provider, model } = useErrorEndpoint(message);
  const errorKey = readString(json, 'code') ?? readString(json, 'type');

  if (errorKey === ErrorTypes.REFUSAL) {
    const headline =
      model != null
        ? localize('com_error_refusal', { 0: model })
        : localize('com_error_refusal_unknown');
    const explanation = readRefusalExplanation(json);
    return explanation == null
      ? headline
      : withHeadline(headline, {
          label: localize('com_error_refusal_reason'),
          value: explanation,
        });
  }

  if (errorKey === ErrorTypes.GOOGLE_ERROR) {
    const headline = localize('com_error_google_error');
    const info = readString(json, 'info');
    return info == null
      ? headline
      : withHeadline(headline, {
          label: localize('com_error_details_provider'),
          value: info,
        });
  }

  if (errorKey === ErrorTypes.INVALID_REQUEST) {
    const headline =
      provider != null
        ? localize('com_error_invalid_request_error', { 0: provider })
        : localize('com_error_invalid_request_error_unknown');
    const detail =
      [readProviderError(json), readString(json, 'message'), readString(json, 'info')]
        .filter((value): value is string => value != null)
        .join('\n\n') || undefined;
    return detail == null
      ? headline
      : withHeadline(headline, {
          label: localize('com_error_details_provider'),
          value: detail,
        });
  }

  if (errorKey === ErrorTypes.NO_SYSTEM_MESSAGES) {
    return provider != null
      ? localize('com_error_no_system_messages', { 0: provider })
      : localize('com_error_no_system_messages_unknown');
  }

  return <UnclassifiedError json={json} text="" message={message} />;
}

/** Fallback for provider prose and payloads whose error code has no localized renderer. */
export function UnclassifiedError({ json, text, message }: UnclassifiedErrorProps) {
  const localize = useLocalize();
  const { provider } = useErrorEndpoint(message);
  const jsonString = extractJson(text);
  const payloadProse =
    readProviderError(json) ?? readString(json, 'message') ?? readString(json, 'info');
  /**
   * The payload is swapped for its own message rather than dropped: a failed run persists a
   * provider error as `<base message>: <status> <body>`, and the body is where the reason is.
   */
  const withoutPayload =
    jsonString !== '' ? text.replace(jsonString, () => payloadProse ?? '') : text;
  const prose = stripLangChainTroubleshootingUrl(withoutPayload).trim() || payloadProse;
  /** A payload that told us nothing usable is its own statement; otherwise name who failed. */
  const providerHeadline =
    provider != null
      ? localize('com_error_provider_failed', { 0: provider })
      : localize('com_error_upstream_model');
  const headline = prose == null && json != null ? localize('com_error_unknown') : providerHeadline;

  return (
    <ErrorWithDetail
      headline={headline}
      detail={prose}
      label={localize('com_error_details_provider')}
    />
  );
}
