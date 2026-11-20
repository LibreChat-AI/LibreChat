import userEvent from '@testing-library/user-event';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  TLangfusePromptListParams,
  TLangfusePromptListResponse,
  TLangfusePromptGetParams,
  TLangfusePromptGetResponse,
} from 'librechat-data-provider';
import type { ReactNode } from 'react';
import LangfusePromptsDialog from '../LangfusePromptsDialog';

/**
 * These tests mock `dataService` at the HTTP-service boundary (the only external call the
 * dialog makes) and drive the dialog through a real `QueryClient`, so the query key, the
 * `enabled` gating and the submitted-vs-live-input split are exercised the same way the
 * browser exercises them. Mocking `~/data-provider`'s hooks instead would hide exactly the
 * bug this file guards against: a stale query key that drops the shown result out from
 * under the user while they keep typing.
 */

const mockGetLangfusePrompts = jest.fn();
const mockGetLangfusePrompt = jest.fn();

jest.mock('librechat-data-provider', () => {
  const actual =
    jest.requireActual<typeof import('librechat-data-provider')>('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getLangfusePrompts: (...args: unknown[]) => mockGetLangfusePrompts(...args),
      getLangfusePrompt: (...args: unknown[]) => mockGetLangfusePrompt(...args),
    },
  };
});

// The mock interpolates `{{0}}`-style i18next options by appending their values, so a test can
// assert that a localized line actually carried the page, status or label values it was given.
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, options?: Record<string, unknown>) =>
    options ? `${key}:${Object.values(options).join(',')}` : key,
}));

/** An axios-style rejection the way the real backend sends one: an outer HTTP status plus a
 *  `{ code, status? }` body. `getPromptErrorMessage` (the dialog's error mapper) reads
 *  `error.response.data.code` for every code, and `error.response.data.status` only for the
 *  `upstream` code, where it holds the Langfuse HTTP status LibreChat forwarded. */
function axiosError(outerStatus: number, data: { code: string; status?: number }) {
  return { isAxiosError: true, response: { status: outerStatus, data } };
}

function listResponse(
  overrides: Partial<TLangfusePromptListResponse> = {},
): TLangfusePromptListResponse {
  return {
    items: [
      {
        name: 'greeting',
        type: 'text',
        versions: [1, 2, 3],
        labels: ['production'],
        tags: ['demo'],
        lastUpdatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        name: 'support-chat',
        type: 'chat',
        versions: [1],
        labels: ['production'],
        tags: [],
        lastUpdatedAt: '2026-01-02T00:00:00.000Z',
      },
    ],
    meta: { page: 1, limit: 10, totalItems: 25, totalPages: 3 },
    ...overrides,
  };
}

function getResponse(
  overrides: Partial<TLangfusePromptGetResponse> = {},
): TLangfusePromptGetResponse {
  return {
    name: 'greeting',
    version: 2,
    labels: ['production'],
    prompt: 'Hello {{name}}',
    ...overrides,
  };
}

function createClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function Wrapper({ children, queryClient }: { children: ReactNode; queryClient: QueryClient }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function renderDialog(queryClient: QueryClient = createClient()) {
  render(
    <Wrapper queryClient={queryClient}>
      <LangfusePromptsDialog open onOpenChange={jest.fn()} />
    </Wrapper>,
  );
  return queryClient;
}

function lastListParams(): TLangfusePromptListParams {
  const calls = mockGetLangfusePrompts.mock.calls;
  return calls[calls.length - 1][0] as TLangfusePromptListParams;
}

function lastGetParams(): TLangfusePromptGetParams {
  const calls = mockGetLangfusePrompt.mock.calls;
  return calls[calls.length - 1][0] as TLangfusePromptGetParams;
}

const listButton = () =>
  screen.getByRole('button', { name: 'com_ui_langfuse_prompts_list_button' });
const getButton = () => screen.getByRole('button', { name: 'com_ui_langfuse_prompts_get_button' });

/** The real `Spinner` renders an `aria-hidden` SVG with no accessible role, so the only way
 *  to assert its presence is the class the component itself owns. */
const hasSpinner = (button: HTMLElement) => button.querySelector('svg.spinner') != null;

beforeEach(() => {
  global.ResizeObserver = class MockedResizeObserver {
    observe = jest.fn();
    unobserve = jest.fn();
    disconnect = jest.fn();
  };
  mockGetLangfusePrompts.mockReset();
  mockGetLangfusePrompt.mockReset();
});

describe('LangfusePromptsDialog', () => {
  describe('list', () => {
    it('disables the submit button and shows a spinner while a valid request is in flight', async () => {
      let resolveRequest: ((value: TLangfusePromptListResponse) => void) | undefined;
      mockGetLangfusePrompts.mockImplementation(
        () =>
          new Promise<TLangfusePromptListResponse>((resolve) => {
            resolveRequest = resolve;
          }),
      );
      renderDialog();

      expect(listButton()).toBeEnabled();
      await userEvent.click(listButton());

      await waitFor(() => expect(listButton()).toBeDisabled());
      expect(hasSpinner(listButton())).toBe(true);

      await act(async () => {
        resolveRequest?.(listResponse());
      });

      await waitFor(() => expect(listButton()).toBeEnabled());
    });

    it('renders rows, a chat prompt type, and the page footer on success', async () => {
      mockGetLangfusePrompts.mockResolvedValue(listResponse());
      renderDialog();

      await userEvent.click(listButton());

      expect(await screen.findByText('greeting')).toBeInTheDocument();
      expect(screen.getByText('support-chat')).toBeInTheDocument();
      expect(screen.getByText('chat')).toBeInTheDocument();
      expect(screen.getByText('1, 2, 3')).toBeInTheDocument();
      expect(screen.getByText('com_ui_langfuse_prompts_list_footer:1,3,25')).toBeInTheDocument();
    });

    it('shows the empty-results state when the list comes back with no items', async () => {
      mockGetLangfusePrompts.mockResolvedValue(
        listResponse({ items: [], meta: { page: 1, limit: 10, totalItems: 0, totalPages: 0 } }),
      );
      renderDialog();

      await userEvent.click(listButton());

      expect(await screen.findByText('com_ui_langfuse_prompts_list_empty')).toBeInTheDocument();
    });

    it('maps a failure code to its localized copy and never retries', async () => {
      // No `retry: false` on this client: if the hook itself did not set `retry: false`,
      // the default client would retry a failed query several times before giving up.
      const queryClient = new QueryClient();
      mockGetLangfusePrompts.mockRejectedValue(axiosError(409, { code: 'not_configured' }));
      renderDialog(queryClient);

      await userEvent.click(listButton());

      expect(
        await screen.findByText('com_ui_langfuse_prompt_error_not_configured'),
      ).toBeInTheDocument();
      expect(mockGetLangfusePrompts).toHaveBeenCalledTimes(1);
    });

    it('includes the HTTP status for an upstream failure', async () => {
      mockGetLangfusePrompts.mockRejectedValue(axiosError(502, { code: 'upstream', status: 400 }));
      renderDialog();

      await userEvent.click(listButton());

      expect(
        await screen.findByText('com_ui_langfuse_prompt_error_upstream_status:400'),
      ).toBeInTheDocument();
    });

    it('omits empty filter fields and keeps the page and limit defaults', async () => {
      mockGetLangfusePrompts.mockResolvedValue(listResponse());
      renderDialog();

      await userEvent.click(listButton());

      await waitFor(() => expect(mockGetLangfusePrompts).toHaveBeenCalledTimes(1));
      expect(lastListParams()).toEqual({ page: 1, limit: 10 });
    });

    it('sends the typed filters and converts the date field to an exact ISO instant', async () => {
      mockGetLangfusePrompts.mockResolvedValue(listResponse());
      renderDialog();

      await userEvent.type(screen.getByLabelText('com_ui_langfuse_prompts_list_name'), 'greeting');
      await userEvent.type(screen.getByLabelText('com_ui_langfuse_prompts_list_label'), 'prod');
      await userEvent.type(screen.getByLabelText('com_ui_langfuse_prompts_list_tag'), 'demo');
      await userEvent.type(
        screen.getByLabelText('com_ui_langfuse_prompts_list_from'),
        '2026-01-01T00:00',
      );
      await userEvent.click(listButton());

      await waitFor(() => expect(mockGetLangfusePrompts).toHaveBeenCalledTimes(1));
      const params = lastListParams();
      expect(params).toMatchObject({
        name: 'greeting',
        label: 'prod',
        tag: 'demo',
        page: 1,
        limit: 10,
      });
      expect(params.fromUpdatedAt).toBe(new Date('2026-01-01T00:00').toISOString());
      expect(params).not.toHaveProperty('toUpdatedAt');
    });

    it('keeps the result visible while the user edits inputs after a submit', async () => {
      mockGetLangfusePrompts.mockResolvedValue(listResponse());
      renderDialog();

      await userEvent.click(listButton());
      expect(await screen.findByText('greeting')).toBeInTheDocument();

      await userEvent.type(
        screen.getByLabelText('com_ui_langfuse_prompts_list_name'),
        'still-typing',
      );

      expect(screen.getByText('greeting')).toBeInTheDocument();
      expect(mockGetLangfusePrompts).toHaveBeenCalledTimes(1);
    });

    it('issues a new request when resubmitted with identical inputs', async () => {
      mockGetLangfusePrompts.mockResolvedValue(listResponse());
      renderDialog();

      await userEvent.click(listButton());
      await waitFor(() => expect(mockGetLangfusePrompts).toHaveBeenCalledTimes(1));

      await userEvent.click(listButton());
      await waitFor(() => expect(mockGetLangfusePrompts).toHaveBeenCalledTimes(2));
    });

    it('cannot be submitted with a limit over 100', async () => {
      renderDialog();

      const limitInput = screen.getByLabelText('com_ui_langfuse_prompts_list_limit');
      await userEvent.clear(limitInput);
      await userEvent.type(limitInput, '101');

      expect(listButton()).toBeDisabled();
      await userEvent.click(listButton());
      expect(mockGetLangfusePrompts).not.toHaveBeenCalled();
    });
  });

  describe('get', () => {
    it('disables the submit button until a name is entered', async () => {
      renderDialog();

      expect(getButton()).toBeDisabled();
      await userEvent.type(screen.getByLabelText('com_ui_langfuse_prompts_get_name'), 'greeting');
      expect(getButton()).toBeEnabled();
    });

    it('disables the submit button and shows a spinner while a request is in flight', async () => {
      let resolveRequest: ((value: TLangfusePromptGetResponse) => void) | undefined;
      mockGetLangfusePrompt.mockImplementation(
        () =>
          new Promise<TLangfusePromptGetResponse>((resolve) => {
            resolveRequest = resolve;
          }),
      );
      renderDialog();

      await userEvent.type(screen.getByLabelText('com_ui_langfuse_prompts_get_name'), 'greeting');
      await userEvent.click(getButton());

      await waitFor(() => expect(getButton()).toBeDisabled());
      expect(hasSpinner(getButton())).toBe(true);

      await act(async () => {
        resolveRequest?.(getResponse());
      });

      await waitFor(() => expect(getButton()).toBeEnabled());
    });

    it('renders the version and prompt text on success', async () => {
      mockGetLangfusePrompt.mockResolvedValue(getResponse());
      renderDialog();

      await userEvent.type(screen.getByLabelText('com_ui_langfuse_prompts_get_name'), 'greeting');
      await userEvent.click(getButton());

      expect(
        await screen.findByText('com_ui_langfuse_prompts_get_result:2,production'),
      ).toBeInTheDocument();
      expect(screen.getByDisplayValue('Hello {{name}}')).toBeInTheDocument();
    });

    it('resolves Production without a version in the request', async () => {
      mockGetLangfusePrompt.mockResolvedValue(getResponse());
      renderDialog();

      await userEvent.type(screen.getByLabelText('com_ui_langfuse_prompts_get_name'), 'greeting');
      await userEvent.click(getButton());

      await waitFor(() => expect(mockGetLangfusePrompt).toHaveBeenCalledTimes(1));
      expect(lastGetParams()).toEqual({ name: 'greeting' });
    });

    it('resolves an exact version when Version is selected', async () => {
      mockGetLangfusePrompt.mockResolvedValue(getResponse());
      renderDialog();

      await userEvent.type(screen.getByLabelText('com_ui_langfuse_prompts_get_name'), 'greeting');
      await userEvent.click(
        screen.getByRole('radio', { name: 'com_ui_langfuse_prompts_get_version' }),
      );
      await userEvent.type(
        screen.getByRole('spinbutton', { name: 'com_ui_langfuse_prompts_get_version' }),
        '2',
      );
      await userEvent.click(getButton());

      await waitFor(() => expect(mockGetLangfusePrompt).toHaveBeenCalledTimes(1));
      expect(lastGetParams()).toEqual({ name: 'greeting', version: 2 });
    });

    it('cannot be submitted with a fractional version', async () => {
      renderDialog();

      await userEvent.type(screen.getByLabelText('com_ui_langfuse_prompts_get_name'), 'greeting');
      await userEvent.click(
        screen.getByRole('radio', { name: 'com_ui_langfuse_prompts_get_version' }),
      );
      await userEvent.type(
        screen.getByRole('spinbutton', { name: 'com_ui_langfuse_prompts_get_version' }),
        '1.5',
      );

      expect(getButton()).toBeDisabled();
      await userEvent.click(getButton());
      expect(mockGetLangfusePrompt).not.toHaveBeenCalled();
    });

    it('maps unsupported_type to its localized copy', async () => {
      mockGetLangfusePrompt.mockRejectedValue(axiosError(422, { code: 'unsupported_type' }));
      renderDialog();

      await userEvent.type(screen.getByLabelText('com_ui_langfuse_prompts_get_name'), 'greeting');
      await userEvent.click(getButton());

      expect(
        await screen.findByText('com_ui_langfuse_prompt_error_unsupported_type'),
      ).toBeInTheDocument();
    });

    it('maps not_found to its localized copy', async () => {
      mockGetLangfusePrompt.mockRejectedValue(axiosError(404, { code: 'not_found' }));
      renderDialog();

      await userEvent.type(screen.getByLabelText('com_ui_langfuse_prompts_get_name'), 'greeting');
      await userEvent.click(getButton());

      expect(await screen.findByText('com_ui_langfuse_prompt_error_not_found')).toBeInTheDocument();
    });

    it('falls back to the generic copy for an unmapped code', async () => {
      mockGetLangfusePrompt.mockRejectedValue(axiosError(500, { code: 'something_unexpected' }));
      renderDialog();

      await userEvent.type(screen.getByLabelText('com_ui_langfuse_prompts_get_name'), 'greeting');
      await userEvent.click(getButton());

      expect(await screen.findByText('com_ui_langfuse_prompt_error_fallback')).toBeInTheDocument();
    });
  });
});
