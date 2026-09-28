import {
  ErrorTypes,
  ViolationTypes,
  isCodeWorkspaceSelectionErrorReason,
} from 'librechat-data-provider';
import type { ErrorRendererProps } from './parts';
import {
  ErrorWithDetail,
  getProviderName,
  readNumber,
  readString,
  useErrorEndpoint,
} from './parts';
import { codeWorkspaceErrorKeys } from '~/utils/errors';
import { useLocalize } from '~/hooks';

/**
 * Failures naming a provider, a model or a workspace selection. Each payload carries the identity
 * it is about (`info`, `reason`, `status`), so the only resolution done here is turning an
 * endpoint id into the name a reader recognizes.
 */
export default function ModelError({ json, message }: ErrorRendererProps) {
  const localize = useLocalize();
  const { provider: conversationProvider } = useErrorEndpoint(message);
  const errorKey = readString(json, 'code') ?? readString(json, 'type');
  const info = readString(json, 'info');
  /** `info` is an endpoint id on these payloads; the conversation's own provider is the fallback. */
  const provider = info != null ? getProviderName(info) : conversationProvider;

  if (errorKey === ErrorTypes.MISSING_MODEL) {
    return provider != null
      ? localize('com_error_missing_model', { 0: provider })
      : localize('com_error_models_not_loaded');
  }

  if (errorKey === ErrorTypes.ENDPOINT_MODELS_NOT_LOADED) {
    return provider != null
      ? localize('com_error_endpoint_models_not_loaded', { 0: provider })
      : localize('com_error_models_not_loaded');
  }

  if (errorKey === ViolationTypes.ILLEGAL_MODEL_REQUEST) {
    const [endpoint, model] = info?.split('|') ?? [];
    const requestedProvider =
      endpoint != null && endpoint !== '' ? getProviderName(endpoint) : conversationProvider;
    if (model == null || model === '' || requestedProvider == null) {
      return localize('com_error_model_not_found');
    }
    return localize('com_error_illegal_model_request', { 0: model, 1: requestedProvider });
  }

  if (errorKey === ErrorTypes.CODE_WORKSPACE_UNAVAILABLE) {
    const reason = readString(json, 'reason');
    return isCodeWorkspaceSelectionErrorReason(reason)
      ? localize(codeWorkspaceErrorKeys[reason])
      : localize('com_error_code_workspace_unavailable');
  }

  /**
   * Provider-neutral headline, matching the sentence the server persists as the failure's own
   * text. The provider's own message rides along in `message` when the deployment lets provider
   * text through: a gateway or proxy rejection explains itself there, and nothing generic can.
   */
  const status = readNumber(json, 'status');
  const headline =
    status != null
      ? localize('com_error_upstream_model_status', { 0: status })
      : localize('com_error_upstream_model');
  return (
    <ErrorWithDetail
      headline={headline}
      detail={readString(json, 'message')}
      label={localize('com_error_details_provider')}
    />
  );
}
