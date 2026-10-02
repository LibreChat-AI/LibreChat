import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  ErrorTypes,
  SystemRoles,
  ContentTypes,
  ViolationTypes,
  EModelEndpoint,
} from 'librechat-data-provider';
import type { Agent, TConversation, TMessage } from 'librechat-data-provider';
import type { ReactElement } from 'react';
import { AgentsMapContext } from '~/Providers/AgentsMapContext';
import { MessageContext } from '~/Providers/MessageContext';
import translation from '~/locales/en/translation.json';
import { ErrorSourceProvider } from '../Error/source';
import { ChatContext } from '~/Providers/ChatContext';
import { AuthContext } from '~/hooks/AuthContext';
import Error from '../Error';

let mockEndpointsData: Record<string, Record<string, unknown>> | undefined = {
  openAI: { userProvide: true },
};
let mockStartupData: { compactionEnabled: boolean; interface?: { contextUsage?: boolean } } = {
  compactionEnabled: false,
};
let mockAccess: Record<string, boolean> = {};

/** Keep this unit spec independent of query providers while exercising the real renderer hooks. */
jest.mock('~/hooks', () => ({
  useLocalize:
    () =>
    (key: string, values?: Record<string, unknown>): string => {
      const template =
        (jest.requireActual('~/locales/en/translation.json') as Record<string, string>)[key] ?? key;
      if (!values) {
        return template;
      }
      return template.replace(/\{\{(\w+)\}\}/g, (match, name) =>
        values[name] != null ? String(values[name]) : match,
      );
    },
  useHasAccess: ({ permission }: { permission: string }) => mockAccess[permission] === true,
  /** Mirrors the real hook's contract — a grid style plus a ref — without pulling `useMediaQuery`
   *  and its `matchMedia` dependency into a spec that asserts copy, not motion. */
  useExpandCollapse: (isExpanded: boolean) => ({
    style: {
      display: 'grid',
      gridTemplateRows: isExpanded ? '1fr' : '0fr',
      opacity: isExpanded ? 1 : 0,
    },
    ref: { current: null },
  }),
}));

jest.mock('~/data-provider', () => ({
  useGetEndpointsQuery: jest.fn(() => ({ data: mockEndpointsData })),
  useGetStartupConfig: jest.fn(() => ({ data: mockStartupData })),
}));

jest.mock('~/components/Input/SetKeyDialog', () => ({
  SetKeyDialog: () => null,
}));

const catalog = translation as Record<string, string>;
const providerMessage = {
  endpoint: 'openAI',
  model: 'gpt-4o',
  createdAt: new Date('2026-09-13T12:00:00.000Z'),
} as unknown as TMessage;

type RenderSurface = {
  /** The row identity an error content part inherits from `ErrorSourceProvider`. */
  source?: TMessage;
  /** The absolute content index `MessageContext` gives an error part rendered inside a row. */
  partIndex?: number;
  /** Mounts `ChatContext`, as the chat surface does, with this conversation. */
  conversation?: Partial<TConversation>;
  agents?: Record<string, Agent>;
  role?: SystemRoles;
};

function renderError(
  payload: Record<string, unknown> | string,
  message?: TMessage,
  surface: RenderSurface = {},
) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  let tree: ReactElement = <Error text={text} message={message} />;
  if (surface.partIndex != null) {
    tree = (
      <MessageContext.Provider
        value={{ messageId: 'response-1', isExpanded: true, partIndex: surface.partIndex }}
      >
        {tree}
      </MessageContext.Provider>
    );
  }
  if (surface.source != null) {
    tree = <ErrorSourceProvider message={surface.source}>{tree}</ErrorSourceProvider>;
  }
  if (surface.agents != null) {
    tree = <AgentsMapContext.Provider value={surface.agents}>{tree}</AgentsMapContext.Provider>;
  }
  if (surface.conversation != null) {
    const chat = { conversation: surface.conversation } as unknown as React.ContextType<
      typeof ChatContext
    >;
    tree = <ChatContext.Provider value={chat}>{tree}</ChatContext.Provider>;
  }
  if (surface.role != null) {
    const auth = { user: { role: surface.role } } as unknown as React.ContextType<
      typeof AuthContext
    >;
    tree = <AuthContext.Provider value={auth}>{tree}</AuthContext.Provider>;
  }
  return render(tree);
}

function expectReadable() {
  const output = document.body.textContent ?? '';
  expect(output).not.toMatch(/com_error_[A-Za-z0-9_]+/);
  expect(output).not.toContain(
    "Something went wrong. Here's the specific error message we encountered:",
  );
}
function localized(key: string, ...values: string[]) {
  return values.reduce((copy, value, index) => copy.replace(`{{${index}}}`, value), catalog[key]);
}

const numberFormat = new Intl.NumberFormat();

/** Mounts the chat surface, the only one whose composer can compact a conversation. */
const chatConversation: Partial<TConversation> = {
  endpoint: EModelEndpoint.openAI,
  model: 'gpt-4o',
};

/** A violation row, stamped by the server when it saved the failure (just now by default). */
const limitRow = (createdAt = Date.now()) =>
  ({
    endpoint: 'openAI',
    model: 'gpt-4o',
    createdAt: new Date(createdAt).toISOString(),
  }) as TMessage;
const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

beforeEach(() => {
  mockEndpointsData = { openAI: { userProvide: true } };
  mockStartupData = { compactionEnabled: false };
  mockAccess = {};
});

describe('Error — every client-facing error type', () => {
  /** The seeded gallery refuses to run while a member lacks a case; this is the renderer's half. */
  it.each([...Object.values(ErrorTypes), ...Object.values(ViolationTypes)])(
    'renders %s as authored copy rather than the unknown-failure fallback',
    (type) => {
      renderError({ type }, providerMessage);

      expect(screen.queryByText(catalog.com_error_unknown)).not.toBeInTheDocument();
      expect(document.body.textContent).not.toContain('{');
      expectReadable();
    },
  );
});

describe('Error — reader-facing provider and fallback copy', () => {
  it.each([
    [ErrorTypes.INVALID_REQUEST, 'com_error_invalid_request_error', 'OpenAI'],
    [ErrorTypes.NO_SYSTEM_MESSAGES, 'com_error_no_system_messages', 'OpenAI'],
    [ErrorTypes.INVALID_ACTION, 'com_error_invalid_action_error', undefined],
  ])('resolves %s to a sentence rather than an unresolved key', (type, key, provider) => {
    renderError({ type }, provider ? providerMessage : undefined);

    expect(screen.getByText(localized(key, ...(provider ? [provider] : [])))).toBeInTheDocument();
    expectReadable();
  });

  it('renders the localized copy for a rejected Google video', () => {
    renderError({ type: ErrorTypes.GOOGLE_VIDEO_UNPROCESSABLE });

    expect(screen.getByText(catalog.com_error_google_video_unprocessable)).toBeInTheDocument();
    expectReadable();
  });

  it.each([
    ['MODEL_NOT_FOUND', 'com_error_model_not_found'],
    ['MODEL_RATE_LIMIT', 'com_error_model_rate_limit'],
  ])('replaces LangChain %s attribution with localized guidance', (code, key) => {
    const raw = `An error occurred while processing the request: 404 404 page not found Troubleshooting URL: https://docs.langchain.com/oss/javascript/langchain/errors/${code}/`;
    renderError(raw);

    expect(screen.getByText(catalog[key])).toBeInTheDocument();
    expect(screen.queryByText(/langchain\.com/i)).not.toBeInTheDocument();
    expectReadable();
  });

  it.each([
    [
      ErrorTypes.MODEL_STREAM_CLOSED,
      'com_error_model_stream_closed',
      'The model provider closed the connection before the response finished. Try again.',
    ],
    [
      ErrorTypes.MODEL_STREAM_STALLED,
      'com_error_model_stream_stalled',
      'The model provider stopped sending the response, and the request timed out. Try again.',
    ],
  ])(
    'localizes a %s error even when it carries older-client fallback prose',
    (type, key, prose) => {
      renderError(`${prose}\n${JSON.stringify({ type })}`, providerMessage);

      expect(screen.getByText(catalog[key])).toBeInTheDocument();
      expect(screen.queryByText(prose)).not.toBeInTheDocument();
      expect(screen.queryByText(/terminated/i)).not.toBeInTheDocument();
      expectReadable();
    },
  );

  it('keeps fallback prose when an older client cannot recognize the server error type', () => {
    const prose =
      'The model provider closed the connection before the response finished. Try again.';
    renderError(
      `${prose}\n${JSON.stringify({ type: 'newer_model_stream_failure' })}`,
      providerMessage,
    );

    expect(screen.getByText(prose)).toBeInTheDocument();
    expect(screen.queryByText(catalog.com_error_unknown)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('{');
    expectReadable();
  });

  it('keeps provider text for a LangChain code without localized copy, minus the URL', () => {
    const raw =
      'An error occurred while processing the request: could not parse output\n\nTroubleshooting URL: https://docs.langchain.com/oss/javascript/langchain/errors/OUTPUT_PARSING_FAILURE/\n';
    renderError(raw);

    expect(screen.getByText(/could not parse output/)).toBeInTheDocument();
    expect(screen.queryByText(/langchain\.com/i)).not.toBeInTheDocument();
    expectReadable();
  });

  it('shows an unmapped payload message without exposing its JSON representation', () => {
    const message = 'The provider returned a code the client does not classify.';
    renderError({ code: 'im_a_teapot', message }, providerMessage);

    expect(screen.getByText(message)).toBeInTheDocument();
    const output = document.body.textContent ?? '';
    expect(output).not.toContain('{');
    expect(output).not.toContain('"code"');
    expectReadable();
  });

  it('reads a provider message nested under `error`, as OpenAI-style bodies carry it', () => {
    const providerText = 'Rate limit reached for gpt-4o in organization org-123 on tokens per min.';
    renderError(
      { error: { message: providerText, type: 'tokens', code: 'rate_limit_exceeded' } },
      providerMessage,
    );

    expect(screen.getByText(localized('com_error_provider_failed', 'OpenAI'))).toBeInTheDocument();
    expect(screen.getByText(providerText)).toBeInTheDocument();
    expect(screen.queryByText(catalog.com_error_unknown)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('{');
    expectReadable();
  });

  it('dispatches a provider code nested under `error` to its renderer', () => {
    renderError(
      {
        error: {
          code: 'invalid_api_key',
          type: 'invalid_request_error',
          message: 'Incorrect API key provided: sk-****.',
        },
      },
      providerMessage,
    );

    expect(screen.getByText(localized('com_error_invalid_api_key', 'OpenAI'))).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: catalog.com_error_user_key_update }),
    ).toBeInTheDocument();
    expectReadable();
  });

  it('dispatches a nested invalid-request type and keeps its message as the detail', () => {
    const detail = "Invalid value for 'temperature': must be between 0 and 2.";
    renderError({ error: { type: 'invalid_request_error', message: detail } }, providerMessage);

    expect(
      screen.getByText(localized('com_error_invalid_request_error', 'OpenAI')),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: catalog.com_error_details_provider }));
    expect(screen.getByText(detail)).toBeInTheDocument();
  });

  /** A top-level `type` names the body, even Anthropic's generic `"error"`, so it is not unwrapped. */
  it('does not unwrap a body whose top level already names a type', () => {
    renderError(
      { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long' } },
      { endpoint: EModelEndpoint.anthropic, model: 'claude-sonnet-4-5' } as TMessage,
    );

    expect(
      screen.getByText(localized('com_error_provider_failed', 'Anthropic')),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(localized('com_error_invalid_request_error', 'Anthropic')),
    ).not.toBeInTheDocument();
    expect(screen.getByText('prompt is too long')).toBeInTheDocument();
  });

  /** `getUserFacingRequestError` prefixes the SDK's message, which for Anthropic embeds the body. */
  it('keeps the reason from a provider body embedded in the persisted text', () => {
    const reason = 'prompt is too long: 250000 tokens > 200000 maximum';
    const body = JSON.stringify({
      type: 'error',
      error: { type: 'invalid_request_error', message: reason },
      request_id: 'req_011',
    });
    renderError(`An error occurred while processing the request: 400 ${body}`, {
      endpoint: EModelEndpoint.anthropic,
      model: 'claude-sonnet-4-5',
    } as TMessage);

    expect(
      screen.getByText(localized('com_error_provider_failed', 'Anthropic')),
    ).toBeInTheDocument();
    expect(
      screen.getByText(`An error occurred while processing the request: 400 ${reason}`),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('{');
    expectReadable();
  });

  it('shows the complete long provider message after its disclosure is opened', () => {
    const providerText =
      `The upstream gateway rejected the request. ${'Retry advice and a stack frame repeated to exceed the client truncation cap. '.repeat(8)}`.trim();
    renderError(providerText, providerMessage);

    expect(screen.queryByText(/Something went wrong/)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('...');
    fireEvent.click(screen.getByRole('button', { name: catalog.com_error_details_provider }));
    expect(document.body.textContent).toContain(providerText);
    expectReadable();
  });
});

describe('Error — provider and model identity', () => {
  it('names the selected model for a refusal without stale Claude copy', () => {
    renderError(
      { type: ErrorTypes.REFUSAL, info: "I can't help with that request." },
      providerMessage,
    );

    expect(screen.getByText(localized('com_error_refusal', 'gpt-4o'))).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Claude|Sonnet/i);
    expectReadable();
  });

  /** `ModelEndHandler` persists the refusal metadata object itself as `info`. */
  it('offers the explanation Anthropic reports under stop_details', () => {
    const explanation = 'The request could enable malware development.';
    renderError(
      {
        type: ErrorTypes.REFUSAL,
        info: {
          stop_reason: 'refusal',
          stop_sequence: null,
          stop_details: { type: 'refusal', category: 'cyber', explanation },
        },
      },
      providerMessage,
    );

    const disclosure = screen.getByRole('button', { name: catalog.com_error_refusal_reason });
    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(explanation)).toBeInTheDocument();
    expectReadable();
  });

  it('renders a content-filter refusal without an empty explanation or its raw metadata', () => {
    renderError(
      { type: ErrorTypes.REFUSAL, info: { stop_reason: 'content_filtered' } },
      providerMessage,
    );

    expect(screen.getByText(localized('com_error_refusal', 'gpt-4o'))).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: catalog.com_error_refusal_reason }),
    ).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/content_filtered|\[object Object\]/);
  });

  it('names the provider from endpoint_models_not_loaded payload info', () => {
    renderError(
      { type: ErrorTypes.ENDPOINT_MODELS_NOT_LOADED, info: 'anthropic' },
      providerMessage,
    );

    expect(
      screen.getByText(localized('com_error_endpoint_models_not_loaded', 'Anthropic')),
    ).toBeInTheDocument();
    expectReadable();
  });

  /** The server persists this sentence as the failure's own text, so the copy stays provider-neutral. */
  it('renders the provider-neutral upstream copy with and without a status', () => {
    const { unmount } = renderError({ type: ErrorTypes.UPSTREAM_MODEL_ERROR }, providerMessage);
    expect(screen.getByText(catalog.com_error_upstream_model)).toBeInTheDocument();
    unmount();

    renderError({ type: ErrorTypes.UPSTREAM_MODEL_ERROR, status: 529 }, providerMessage);
    expect(
      screen.getByText(localized('com_error_upstream_model_status', '529')),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('OpenAI');
  });

  it.each([
    'Unexpected token } in JSON',
    'gateway rejected {request',
    'invalid "quoted }" value',
    'path \\ {',
  ])('renders provider punctuation: %s', (explanation) => {
    renderError(
      'The model provider could not complete this request.\n' +
        JSON.stringify({
          type: ErrorTypes.UPSTREAM_MODEL_ERROR,
          status: 400,
          message: explanation,
        }),
      providerMessage,
    );
    expect(
      screen.getByText(localized('com_error_upstream_model_status', '400')),
    ).toBeInTheDocument();
    expect(screen.getByText(explanation)).toBeInTheDocument();
    expectReadable();
  });

  /** What a gateway or privacy proxy rejects a request with is only stated in its own message. */
  it('reads the provider explanation an upstream failure carries', () => {
    const explanation = 'Request rejected: this prompt cannot be masked safely';
    const { unmount } = renderError(
      { type: ErrorTypes.UPSTREAM_MODEL_ERROR, status: 400, message: explanation },
      providerMessage,
    );

    expect(
      screen.getByText(localized('com_error_upstream_model_status', '400')),
    ).toBeInTheDocument();
    expect(screen.getByText(explanation)).toBeInTheDocument();
    expectReadable();
    unmount();

    const body = `Upstream rejection\n${JSON.stringify({ reason: 'masking_unavailable' })}`.padEnd(
      400,
      '.',
    );
    renderError(
      { type: ErrorTypes.UPSTREAM_MODEL_ERROR, status: 400, message: body },
      providerMessage,
    );

    const disclosure = screen.getByRole('button', { name: catalog.com_error_details_provider });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    expect(document.body.textContent).toContain(body);
  });

  it.each([
    ['required', 'com_error_code_workspace_required'],
    ['invalid', 'com_error_code_workspace_invalid'],
    ['worker_unavailable', 'com_error_code_workspace_worker_unavailable'],
    ['unsupported', 'com_error_code_workspace_unsupported'],
    ['missing', 'com_error_code_workspace_missing'],
    ['locked', 'com_error_code_workspace_locked'],
  ])('localizes a workspace rejection with reason %s', (reason, key) => {
    renderError({ code: ErrorTypes.CODE_WORKSPACE_UNAVAILABLE, reason });

    expect(screen.getByText(catalog[key])).toBeInTheDocument();
    expectReadable();
  });

  it.each([{ reason: 'future_reason' }, {}])(
    'uses safe workspace fallback copy for an unknown or legacy payload',
    (payload) => {
      renderError({ code: ErrorTypes.CODE_WORKSPACE_UNAVAILABLE, ...payload });

      expect(screen.getByText(catalog.com_error_code_workspace_unavailable)).toBeInTheDocument();
      expectReadable();
    },
  );
});

describe('Error — user key and limits', () => {
  it('offers the add-key action when the endpoint accepts user credentials', () => {
    renderError({ type: ErrorTypes.NO_USER_KEY }, providerMessage);

    expect(screen.getByText(localized('com_error_no_user_key', 'OpenAI'))).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: catalog.com_error_user_key_add }),
    ).toBeInTheDocument();
  });

  it('shows administrator guidance and no action for deployment-managed credentials', () => {
    mockEndpointsData = { openAI: { userProvide: false } };
    renderError({ type: ErrorTypes.NO_USER_KEY }, providerMessage);

    expect(
      screen.getByText(localized('com_error_no_user_key_admin', 'OpenAI')),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: catalog.com_error_user_key_add }),
    ).not.toBeInTheDocument();
  });

  /** A shared link's viewer has no endpoint configuration, so who owns the key is unknown. */
  it('keeps key copy generic where the endpoint configuration is unavailable', () => {
    mockEndpointsData = undefined;
    renderError({ type: ErrorTypes.NO_USER_KEY }, providerMessage);

    expect(screen.getByText(catalog.com_error_no_user_key_generic)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('administrator');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('offers the key dialog when a saved user key cannot be read', () => {
    renderError({ type: ErrorTypes.INVALID_USER_KEY }, providerMessage);

    expect(
      screen.getByText(localized('com_error_invalid_user_key_provider', 'OpenAI')),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: catalog.com_error_user_key_update }),
    ).toBeInTheDocument();
  });

  describe('an endpoint whose base URL the reader provides', () => {
    const customRow = { endpoint: 'OpenRouter', model: 'openrouter/auto' } as TMessage;

    beforeEach(() => {
      mockEndpointsData = { OpenRouter: { type: 'custom', userProvideURL: true } };
    });

    /** The server reads the key from the reader's own record whenever the URL is theirs. */
    it('offers the key dialog for a missing key even with a deployment key configured', () => {
      renderError({ type: ErrorTypes.NO_USER_KEY }, customRow);

      expect(
        screen.getByText(localized('com_error_no_user_key', 'OpenRouter')),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: catalog.com_error_user_key_add }),
      ).toBeInTheDocument();
    });

    it('names a missing URL and offers to add it', () => {
      renderError({ type: ErrorTypes.NO_BASE_URL }, customRow);

      expect(
        screen.getByText(localized('com_error_no_base_url_provider', 'OpenRouter')),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: catalog.com_error_user_url_add }),
      ).toBeInTheDocument();
    });

    it('offers to update a URL the server refused', () => {
      renderError(
        {
          type: ErrorTypes.INVALID_BASE_URL,
          message: 'Base URL for OpenRouter targets a restricted address.',
        },
        customRow,
      );

      expect(
        screen.getByText(localized('com_error_invalid_base_url_provider', 'OpenRouter')),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: catalog.com_error_user_url_update }),
      ).toBeInTheDocument();
    });

    it("keeps the generic URL copy and no action where the record is not the reader's", () => {
      mockEndpointsData = { OpenRouter: { type: 'custom' } };
      renderError({ type: ErrorTypes.NO_BASE_URL }, customRow);

      expect(screen.getByText(catalog.com_error_no_base_url)).toBeInTheDocument();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });
  });

  it('formats an expired user-key date for readers', () => {
    const expiredAt = '2026-08-01T09:30:00.000Z';
    const formatted = dateTimeFormat.format(new Date(expiredAt));
    renderError(
      { type: ErrorTypes.EXPIRED_USER_KEY, expiredAt, endpoint: 'openAI' },
      providerMessage,
    );

    expect(
      screen.getByText(localized('com_error_expired_user_key', 'OpenAI', formatted)),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(expiredAt);
  });

  /** A server in a day-first locale wrote August 1 as `01/08/2026`, which parses as January 8. */
  it('shows an expiry persisted in a server locale as written instead of reparsing it', () => {
    const expiredAt = '01/08/2026, 09:30:00';
    renderError(
      { type: ErrorTypes.EXPIRED_USER_KEY, expiredAt, endpoint: 'openAI' },
      providerMessage,
    );

    expect(
      screen.getByText(localized('com_error_expired_user_key', 'OpenAI', expiredAt)),
    ).toBeInTheDocument();
  });

  it('renders a message-limit countdown from a future reset time', () => {
    renderError(
      {
        type: ViolationTypes.MESSAGE_LIMIT,
        max: 40,
        windowInMinutes: 60,
        resetAt: Date.now() + 2 * 60 * 1000,
      },
      limitRow(),
    );

    expect(screen.getByText(/You can send another message in \d+:\d{2}\./)).toBeInTheDocument();
  });

  it('counts down to a reset more than a day out when the limiter window is that long', () => {
    renderError(
      {
        type: ViolationTypes.MESSAGE_LIMIT,
        max: 40,
        windowInMinutes: 3 * 24 * 60,
        resetAt: Date.now() + 2 * 24 * 60 * 60 * 1000,
      },
      limitRow(),
    );

    expect(
      screen.getByText(/You can send another message in (47:59:59|48:00:00)\./),
    ).toBeInTheDocument();
  });

  /** The server stamps both the row and its reset, so the window runs from the row, not this device. */
  it('keeps a valid countdown when this device clock runs behind the server', () => {
    const serverNow = Date.now() + 10 * 60 * 1000;
    renderError(
      {
        type: ViolationTypes.MESSAGE_LIMIT,
        max: 40,
        windowInMinutes: 60,
        resetAt: serverNow + 55 * 60 * 1000,
      },
      limitRow(serverNow),
    );

    expect(screen.getByText(/You can send another message in 1:0[45]:\d{2}\./)).toBeInTheDocument();
  });

  it('drops a reset further out than the limiter window allows', () => {
    renderError(
      {
        type: ViolationTypes.MESSAGE_LIMIT,
        max: 40,
        windowInMinutes: 60,
        resetAt: Date.now() + 3 * 60 * 60 * 1000,
      },
      limitRow(),
    );

    expect(
      screen.getByText(localized('com_error_message_limit', '40', '60 minutes')),
    ).toBeInTheDocument();
    expect(screen.queryByText(/You can send another message/)).not.toBeInTheDocument();
  });

  /** The error box is `role="alert"`, so a ticking line inside it would be announced every second. */
  it('keeps the ticking countdown out of the alert and states the reset moment instead', () => {
    const resetAt = Date.now() + 2 * 60 * 1000;
    renderError(
      { type: ViolationTypes.MESSAGE_LIMIT, max: 40, windowInMinutes: 60, resetAt },
      limitRow(),
    );

    expect(screen.getByText(/You can send another message in \d+:\d{2}\./)).toHaveAttribute(
      'aria-hidden',
      'true',
    );
    expect(
      screen.getByText(localized('com_error_retry_at', dateTimeFormat.format(new Date(resetAt)))),
    ).toHaveClass('sr-only');
  });

  /** The row a live violation renders is stamped by this device as it arrives. */
  it('counts a live countdown from the relative retry, not a server reset this device misreads', () => {
    renderError(
      {
        type: ViolationTypes.MESSAGE_LIMIT,
        max: 1,
        windowInMinutes: 1,
        retryAfterSeconds: 60,
        resetAt: Date.now() - 4 * 60 * 1000,
      },
      limitRow(),
    );

    expect(screen.getByText(/You can send another message in (0:59|1:00)\./)).toBeInTheDocument();
    expect(screen.queryByText(catalog.com_error_retry_available)).not.toBeInTheDocument();
  });

  it('renders retry-available copy when a message limit has expired', () => {
    renderError(
      {
        type: ViolationTypes.MESSAGE_LIMIT,
        max: 40,
        windowInMinutes: 60,
        resetAt: Date.now() - 1000,
      },
      limitRow(),
    );

    expect(screen.getByText(catalog.com_error_retry_available)).toBeInTheDocument();
  });
});

describe('Error — token balance and context budget', () => {
  it('formats token credits and keeps generation rows behind a disclosure', () => {
    renderError({
      type: ViolationTypes.TOKEN_BALANCE,
      balance: 1250,
      tokenCost: 8400,
      promptTokens: 6300,
      generations: [
        { model: 'gpt-4o', promptTokens: 6300, completionTokens: 2100 },
        { model: 'gpt-4o-mini', promptTokens: 820, completionTokens: 240 },
      ],
    });

    expect(
      screen.getByText(
        localized('com_error_token_balance', numberFormat.format(8400), numberFormat.format(1250)),
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(localized('com_error_token_balance_prompt', numberFormat.format(6300))),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('"model":');
    fireEvent.click(
      screen.getByRole('button', { name: catalog.com_error_token_balance_generations }),
    );
    expect(
      screen.getByText(
        localized(
          'com_error_token_balance_generation',
          'gpt-4o',
          numberFormat.format(6300),
          numberFormat.format(2100),
        ),
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        localized(
          'com_error_token_balance_generation',
          'gpt-4o-mini',
          numberFormat.format(820),
          numberFormat.format(240),
        ),
      ),
    ).toBeInTheDocument();
  });

  it('lists every generation charge rather than a truncated subset', () => {
    const generations = Array.from({ length: 25 }, (_, index) => ({
      model: `model-${index + 1}`,
      promptTokens: 100,
      completionTokens: 10,
    }));
    renderError({ type: ViolationTypes.TOKEN_BALANCE, balance: 10, tokenCost: 900, generations });

    fireEvent.click(
      screen.getByRole('button', { name: catalog.com_error_token_balance_generations }),
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(25);
    expect(screen.getByText(/^model-25 —/)).toBeInTheDocument();
  });

  it('formats input length and offers the standard context next steps', () => {
    renderError({ type: ErrorTypes.INPUT_LENGTH, info: '214500 / 128000' }, providerMessage);

    expect(
      screen.getByText(
        localized(
          'com_error_input_length',
          numberFormat.format(214500),
          numberFormat.format(128000),
        ),
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(catalog.com_error_context_next_steps)).toBeInTheDocument();
  });

  it('never suggests compaction for a message that alone exceeds the limit', () => {
    mockStartupData = { compactionEnabled: true };
    renderError({ type: ErrorTypes.INPUT_LENGTH, info: '214500 / 128000' }, providerMessage);

    expect(screen.getByText(catalog.com_error_context_next_steps)).toBeInTheDocument();
    expect(
      screen.queryByText(catalog.com_error_context_next_steps_compact),
    ).not.toBeInTheDocument();
  });

  it('formats final overflow numbers and uses compaction next steps when available', () => {
    mockStartupData = { compactionEnabled: true };
    renderError(
      {
        type: ErrorTypes.FINAL_CONTEXT_OVERFLOW,
        projectedMessageTokens: 214500,
        availableMessageTokens: 128000,
      },
      providerMessage,
      { conversation: chatConversation },
    );

    expect(
      screen.getByText(
        localized(
          'com_error_final_context_overflow',
          numberFormat.format(214500),
          numberFormat.format(128000),
        ),
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(catalog.com_error_context_next_steps_compact)).toBeInTheDocument();
  });

  /** The compact action lives in the context usage popover, which that setting removes. */
  /** Search results read a cached startup config, but only the chat composer can compact. */
  it('does not suggest compaction outside a chat', () => {
    mockStartupData = { compactionEnabled: true };
    renderError(
      {
        type: ErrorTypes.FINAL_CONTEXT_OVERFLOW,
        projectedMessageTokens: 214500,
        availableMessageTokens: 128000,
      },
      providerMessage,
    );

    expect(screen.getByText(catalog.com_error_context_next_steps)).toBeInTheDocument();
    expect(
      screen.queryByText(catalog.com_error_context_next_steps_compact),
    ).not.toBeInTheDocument();
  });

  it('does not suggest compaction where the context usage indicator is hidden', () => {
    mockStartupData = { compactionEnabled: true, interface: { contextUsage: false } };
    renderError(
      {
        type: ErrorTypes.FINAL_CONTEXT_OVERFLOW,
        projectedMessageTokens: 214500,
        availableMessageTokens: 128000,
      },
      providerMessage,
      { conversation: chatConversation },
    );

    expect(screen.getByText(catalog.com_error_context_next_steps)).toBeInTheDocument();
    expect(
      screen.queryByText(catalog.com_error_context_next_steps_compact),
    ).not.toBeInTheDocument();
  });

  it('renders empty-message context copy and formatted budget detail', () => {
    const info =
      'Message pruning removed all messages as none fit in the context window. ' +
      'Please increase the context window size or make your message shorter. ' +
      'Token budget: 128000 total, 127480 reserved for instructions and tools, 520 available.';
    renderError({ type: ErrorTypes.EMPTY_MESSAGES, info }, providerMessage);

    expect(screen.getByText(catalog.com_error_empty_messages)).toBeInTheDocument();
    expect(screen.getByText(catalog.com_error_context_next_steps)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: catalog.com_error_context_token_budget }));
    expect(
      screen.getByText(new RegExp(`Token budget: ${numberFormat.format(128000)} total`)),
    ).toBeInTheDocument();
    expect(
      screen.getByText(new RegExp(`${numberFormat.format(127480)} reserved`)),
    ).toBeInTheDocument();
  });
});

describe('Error — manual compaction', () => {
  it('renders the failed-compaction copy', () => {
    renderError({ type: ErrorTypes.COMPACTION_FAILED });

    expect(screen.getByText(catalog.com_error_compaction_failed)).toBeInTheDocument();
  });

  it.each([
    ['disabled', 'com_error_compaction_disabled'],
    ['instructions_exceed_budget', 'com_error_compaction_budget'],
    ['nothing_to_summarize', 'com_error_compaction_nothing'],
  ])('renders the copy for a compaction skipped because %s', (reason, key) => {
    renderError({ type: ErrorTypes.COMPACTION_SKIPPED, reason });

    expect(screen.getByText(catalog[key])).toBeInTheDocument();
  });

  it('falls back to the failed copy for an unknown skip reason', () => {
    renderError({ type: ErrorTypes.COMPACTION_SKIPPED, reason: 'exhausted' });

    expect(screen.getByText(catalog.com_error_compaction_failed)).toBeInTheDocument();
  });
});

describe('Error — identity of the row an error part belongs to', () => {
  const failedTurn = { endpoint: EModelEndpoint.anthropic, model: 'claude-sonnet-4-5' } as TMessage;

  it("names the model that failed rather than the conversation's current one", () => {
    renderError({ type: ErrorTypes.REFUSAL }, undefined, {
      source: failedTurn,
      conversation: { endpoint: EModelEndpoint.openAI, model: 'gpt-4o' },
    });

    expect(
      screen.getByText(localized('com_error_refusal', 'claude-sonnet-4-5')),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('gpt-4o');
  });

  /** A restored row without identity must not borrow whatever the conversation selected since. */
  it("keeps a row's missing identity unknown instead of borrowing the conversation's", () => {
    renderError({ type: ErrorTypes.NO_USER_KEY }, { text: 'restored' } as TMessage, {
      conversation: { endpoint: EModelEndpoint.openAI, model: 'gpt-4o' },
    });

    expect(screen.getByText(catalog.com_error_no_user_key_generic)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('OpenAI');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('reads the conversation only for an error rendered with no row at all', () => {
    renderError({ type: ErrorTypes.REFUSAL }, undefined, {
      conversation: { endpoint: EModelEndpoint.openAI, model: 'gpt-4o' },
    });

    expect(screen.getByText(localized('com_error_refusal', 'gpt-4o'))).toBeInTheDocument();
  });

  it('lets a row passed directly outrank the surrounding source', () => {
    renderError({ type: ErrorTypes.REFUSAL }, providerMessage, { source: failedTurn });

    expect(screen.getByText(localized('com_error_refusal', 'gpt-4o'))).toBeInTheDocument();
  });
});

describe('Error — saved agents', () => {
  /** A saved agent's row names the agents endpoint and stores the agent id as its model. */
  const agentRow = { endpoint: EModelEndpoint.agents, model: 'agent_research' } as TMessage;
  const researchAgent = {
    id: 'agent_research',
    name: 'Research',
    provider: EModelEndpoint.google,
    model: 'gemini-2.5-pro',
    isEditable: true,
  } satisfies Partial<Agent> as Agent;
  const agents = { [researchAgent.id]: researchAgent };

  beforeEach(() => {
    mockEndpointsData = { agents: {}, google: { userProvide: true } };
  });

  it("resolves a key failure against the agent's provider and offers that provider's key", () => {
    renderError({ type: ErrorTypes.NO_USER_KEY }, agentRow, { agents });

    expect(screen.getByText(localized('com_error_no_user_key', 'Google'))).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: catalog.com_error_user_key_add }),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('My Agents');
  });

  it("names the agent's model rather than the agent id stored on the row", () => {
    renderError({ type: ErrorTypes.REFUSAL }, agentRow, { agents });

    expect(screen.getByText(localized('com_error_refusal', 'gemini-2.5-pro'))).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('agent_research');
  });

  it('keeps generic copy when the agents map cannot resolve the agent', () => {
    renderError({ type: ErrorTypes.NO_USER_KEY }, agentRow);

    expect(screen.getByText(catalog.com_error_no_user_key_generic)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: catalog.com_error_user_key_add }),
    ).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('agent_research');
  });

  /** An ephemeral agent's row stores the model itself, since there is no agent id to store. */
  it("keeps an agents row's recorded model when no saved agent resolves", () => {
    renderError({ type: ErrorTypes.REFUSAL }, {
      endpoint: EModelEndpoint.agents,
      model: 'gpt-4o',
    } as TMessage);

    expect(screen.getByText(localized('com_error_refusal', 'gpt-4o'))).toBeInTheDocument();
  });

  /** The client's live placeholder for an agents turn stores the conversation's agent id as `model`. */
  it('resolves an ephemeral agent id to the endpoint and model it encodes', () => {
    mockEndpointsData = { agents: {}, openAI: { userProvide: true } };
    renderError({ type: ErrorTypes.NO_USER_KEY }, {
      endpoint: EModelEndpoint.agents,
      model: 'openAI__gpt-4o___GPT-4o',
    } as TMessage);

    expect(screen.getByText(localized('com_error_no_user_key', 'OpenAI'))).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: catalog.com_error_user_key_add }),
    ).toBeInTheDocument();
  });

  /** Switching the conversation to a saved agent later must not rewrite who produced an old failure. */
  it("keeps an ephemeral row's own model when the conversation now runs a saved agent", () => {
    renderError(
      { type: ErrorTypes.REFUSAL },
      { endpoint: EModelEndpoint.agents, model: 'gpt-4o' } as TMessage,
      {
        agents,
        conversation: { endpoint: EModelEndpoint.agents, agent_id: researchAgent.id },
      },
    );

    expect(screen.getByText(localized('com_error_refusal', 'gpt-4o'))).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('gemini-2.5-pro');
  });

  it('never names the ephemeral placeholder as a model', () => {
    renderError({ type: ErrorTypes.REFUSAL }, {
      endpoint: EModelEndpoint.agents,
      model: 'ephemeral',
    } as TMessage);

    expect(screen.getByText(catalog.com_error_refusal_unknown)).toBeInTheDocument();
  });

  it('lets an expired key name the endpoint its payload reports over the row', () => {
    const expiredAt = '2026-08-01T09:30:00.000Z';
    renderError(
      { type: ErrorTypes.EXPIRED_USER_KEY, expiredAt, endpoint: EModelEndpoint.google },
      providerMessage,
    );

    expect(
      screen.getByText(
        localized(
          'com_error_expired_user_key',
          'Google',
          dateTimeFormat.format(new Date(expiredAt)),
        ),
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: catalog.com_error_user_key_update }),
    ).toBeInTheDocument();
  });
});

describe('Error — agent provider guidance', () => {
  const agentRow = { endpoint: EModelEndpoint.agents, model: 'agent_ops' } as TMessage;
  const opsAgent = {
    id: 'agent_ops',
    name: 'Ops',
    provider: EModelEndpoint.bedrock,
    model: 'anthropic.claude-sonnet-4-5',
    isEditable: true,
  } satisfies Partial<Agent> as Agent;
  const payload = { type: ErrorTypes.INVALID_AGENT_PROVIDER, info: EModelEndpoint.bedrock };

  beforeEach(() => {
    mockEndpointsData = { agents: {} };
    mockAccess = { USE: true, CREATE: true };
  });

  it('sends a reader who can edit the agent to the builder', () => {
    renderError(payload, agentRow, { agents: { [opsAgent.id]: opsAgent } });

    expect(
      screen.getByText(localized('com_error_invalid_agent_provider', 'AWS Bedrock')),
    ).toBeInTheDocument();
    expect(screen.getByText(catalog.com_error_invalid_agent_provider_editable)).toBeInTheDocument();
  });

  it.each([
    ['the builder is disabled', { agents: { disableBuilder: true } }, { USE: true, CREATE: true }],
    ['the reader cannot create agents', { agents: {} }, { USE: true, CREATE: false }],
    ['the reader cannot use agents', { agents: {} }, { USE: false, CREATE: true }],
    ['agents are not configured', {}, { USE: true, CREATE: true }],
  ])('does not point to the builder when %s', (_label, endpoints, access) => {
    mockEndpointsData = endpoints;
    mockAccess = access;
    renderError(payload, agentRow, { agents: { [opsAgent.id]: opsAgent } });

    expect(screen.getByText(catalog.com_error_invalid_agent_provider_admin)).toBeInTheDocument();
    expect(
      screen.queryByText(catalog.com_error_invalid_agent_provider_editable),
    ).not.toBeInTheDocument();
  });

  it("sends an administrator to the builder for an agent outside the reader's grants", () => {
    renderError(payload, agentRow, {
      agents: { [opsAgent.id]: { ...opsAgent, isEditable: false } },
      role: SystemRoles.ADMIN,
    });

    expect(screen.getByText(catalog.com_error_invalid_agent_provider_editable)).toBeInTheDocument();
  });

  it('names the owner when the reader cannot edit the agent', () => {
    renderError(payload, agentRow, {
      agents: {
        [opsAgent.id]: { ...opsAgent, isEditable: false, owner_contact: { name: 'Dana' } },
      },
    });

    expect(
      screen.getByText(localized('com_error_invalid_agent_provider_owner', 'Dana')),
    ).toBeInTheDocument();
  });
});

describe('Error — agent handoffs within a row', () => {
  const rootAgent = {
    id: 'agent_root',
    name: 'Planner',
    provider: EModelEndpoint.google,
    model: 'gemini-2.5-pro',
  } satisfies Partial<Agent> as Agent;
  const writerAgent = {
    id: 'agent_writer',
    name: 'Writer',
    provider: EModelEndpoint.anthropic,
    model: 'claude-sonnet-4-5',
  } satisfies Partial<Agent> as Agent;
  /** Index 1 hands the run to the writer, and the run fails at index 2. */
  const handoffRow = {
    endpoint: EModelEndpoint.agents,
    model: rootAgent.id,
    content: [
      { type: ContentTypes.TEXT, text: 'Drafting the outline.' },
      { type: ContentTypes.AGENT_UPDATE, agent_update: { agentId: writerAgent.id, index: 1 } },
      { type: ContentTypes.ERROR, error: JSON.stringify({ type: ErrorTypes.NO_USER_KEY }) },
    ],
  } as unknown as TMessage;

  beforeEach(() => {
    mockEndpointsData = {
      agents: {},
      google: { userProvide: true },
      anthropic: { userProvide: true },
    };
  });

  it('resolves an error part after a handoff against the agent the run was handed to', () => {
    renderError({ type: ErrorTypes.NO_USER_KEY }, undefined, {
      source: handoffRow,
      partIndex: 2,
      agents: { [rootAgent.id]: rootAgent, [writerAgent.id]: writerAgent },
    });

    expect(screen.getByText(localized('com_error_no_user_key', 'Anthropic'))).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('Google');
  });

  it('keeps the agent that handed off for a part before the handoff', () => {
    renderError({ type: ErrorTypes.NO_USER_KEY }, undefined, {
      source: handoffRow,
      partIndex: 0,
      agents: { [rootAgent.id]: rootAgent, [writerAgent.id]: writerAgent },
    });

    expect(screen.getByText(localized('com_error_no_user_key', 'Google'))).toBeInTheDocument();
  });

  it('resolves a handoff to a parallel ephemeral agent through the id it encodes', () => {
    const parallelRow = {
      ...handoffRow,
      content: [
        { type: ContentTypes.TEXT, text: 'Drafting the outline.' },
        {
          type: ContentTypes.AGENT_UPDATE,
          agent_update: { agentId: 'anthropic__claude-sonnet-4-5___Claude____1', index: 1 },
        },
        { type: ContentTypes.ERROR, error: JSON.stringify({ type: ErrorTypes.NO_USER_KEY }) },
      ],
    } as unknown as TMessage;
    renderError({ type: ErrorTypes.NO_USER_KEY }, undefined, {
      source: parallelRow,
      partIndex: 2,
      agents: { [rootAgent.id]: rootAgent },
    });

    expect(screen.getByText(localized('com_error_no_user_key', 'Anthropic'))).toBeInTheDocument();
  });

  /** A parallel run stamps each part with its lane's agent, whatever handoff preceded it. */
  it("resolves a parallel lane's error part against the agent of its own lane", () => {
    const laneRow = {
      ...handoffRow,
      content: [
        { type: ContentTypes.AGENT_UPDATE, agent_update: { agentId: writerAgent.id, index: 0 } },
        { type: ContentTypes.TEXT, text: 'Drafting.', agentId: writerAgent.id, groupId: 1 },
        {
          type: ContentTypes.ERROR,
          error: JSON.stringify({ type: ErrorTypes.NO_USER_KEY }),
          agentId: rootAgent.id,
          groupId: 1,
        },
      ],
    } as unknown as TMessage;
    renderError({ type: ErrorTypes.NO_USER_KEY }, undefined, {
      source: laneRow,
      partIndex: 2,
      agents: { [rootAgent.id]: rootAgent, [writerAgent.id]: writerAgent },
    });

    expect(screen.getByText(localized('com_error_no_user_key', 'Google'))).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('Anthropic');
  });

  it('names no provider when the agent handed to cannot be resolved', () => {
    renderError({ type: ErrorTypes.NO_USER_KEY }, undefined, {
      source: handoffRow,
      partIndex: 2,
      agents: { [rootAgent.id]: rootAgent },
    });

    expect(screen.getByText(catalog.com_error_no_user_key_generic)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('Google');
  });
});
