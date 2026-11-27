import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { request } from 'librechat-data-provider';
import { useForm, FormProvider } from 'react-hook-form';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import type {
  TPrompt,
  TPromptGroup,
  TResolvedLangfusePrompt,
  TPromptRevisionChoicesResponse,
} from 'librechat-data-provider';
import type { UseFormReturn } from 'react-hook-form';
import type { AgentForm } from '~/common';
import InstructionsPromptFields from '../InstructionsPromptFields';

let mockLangfuseEnabled = false;

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
  useAuthContext: () => ({ user: { id: 'user-1', name: 'Ada' } }),
  usePromptContent: jest.requireActual('~/hooks/Prompts/usePromptContent').default,
}));

jest.mock('~/Providers/AgentPanelContext', () => ({
  useAgentPanelContext: () => ({
    agentsConfig: { linkedInstructions: { langfuse: { enabled: mockLangfuseEnabled } } },
  }),
}));

const previewLabel = 'com_agents_instructions_prompt_preview';

const nativeGroup: TPromptGroup = {
  _id: 'group1',
  name: 'Support triage',
  author: 'user-1',
  authorName: 'Ada',
  source: 'native',
  productionPrompt: { prompt: 'Production text for {{current_user}}' },
};

const langfuseGroup: TPromptGroup = {
  _id: 'group2',
  name: 'Langfuse triage',
  author: 'user-1',
  authorName: 'Ada',
  source: 'langfuse',
  productionPrompt: null,
};

const nativeRevisions: TPromptRevisionChoicesResponse = {
  source: 'native',
  groupId: 'group1',
  revisions: [
    { source: 'native', promptId: 'p2', version: 2, isProduction: true },
    { source: 'native', promptId: 'p1', version: 1, isProduction: false },
  ],
};

const langfuseRevisions: TPromptRevisionChoicesResponse = {
  source: 'langfuse',
  groupId: 'group2',
  revisions: [
    { source: 'langfuse', version: 5 },
    { source: 'langfuse', version: 4 },
  ],
};

const prompt = (_id: string, text: string): TPrompt => ({
  _id,
  groupId: 'group1',
  author: 'user-1',
  prompt: text,
  type: 'text',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const langfuseResolved = (version: number, text: string): TResolvedLangfusePrompt => ({
  source: 'langfuse',
  groupId: 'group2',
  prompt: text,
  type: 'text',
  version,
  labels: version === 5 ? ['production'] : [],
});

/** Routes each GET by URL, so a test can assert on the exact request a preview makes. */
let getSpy: jest.SpyInstance;

function routeRequests(groups: TPromptGroup[]) {
  getSpy = jest.spyOn(request, 'get').mockImplementation((url: string) => {
    if (url.endsWith('/api/prompts/all')) {
      return Promise.resolve(groups);
    }
    if (url.endsWith('/groups/group1/revisions')) {
      return Promise.resolve(nativeRevisions);
    }
    if (url.endsWith('/groups/group2/revisions')) {
      return Promise.resolve(langfuseRevisions);
    }
    if (url.includes('/api/prompts?groupId=group1')) {
      return Promise.resolve([
        prompt('p2', 'Production text for {{current_user}}'),
        prompt('p1', 'Version one for {{current_user}}'),
      ]);
    }
    if (url.endsWith('/groups/group2/resolve?version=4')) {
      return Promise.resolve(langfuseResolved(4, 'Langfuse v4 text'));
    }
    if (url.endsWith('/groups/group2/resolve')) {
      return Promise.resolve(langfuseResolved(5, 'Langfuse production text'));
    }
    return Promise.reject(new Error(`unexpected request ${url}`));
  });
}

const requestedUrls = () => getSpy.mock.calls.map(([url]) => url as string);

function Harness({
  defaultInstructionsPrompt,
  onMethods,
}: {
  defaultInstructionsPrompt: AgentForm['instructionsPrompt'];
  onMethods?: (methods: UseFormReturn<AgentForm>) => void;
}) {
  const methods = useForm<AgentForm>({
    defaultValues: {
      instructionsSource: 'prompt',
      instructionsPrompt: defaultInstructionsPrompt,
    } as Partial<AgentForm>,
  });
  onMethods?.(methods);
  return (
    <FormProvider {...methods}>
      <InstructionsPromptFields />
    </FormProvider>
  );
}

function renderFields(
  defaultInstructionsPrompt: AgentForm['instructionsPrompt'],
  onMethods?: (methods: UseFormReturn<AgentForm>) => void,
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Harness defaultInstructionsPrompt={defaultInstructionsPrompt} onMethods={onMethods} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function openPreview() {
  const button = await screen.findByRole('button', { name: previewLabel });
  await waitFor(() => expect(button).not.toHaveAttribute('aria-disabled'));
  fireEvent.click(button);
  return screen.findByRole('dialog');
}

beforeEach(() => {
  mockLangfuseEnabled = false;
});

afterEach(() => {
  getSpy.mockRestore();
});

describe('Instructions prompt preview', () => {
  it('requests no prompt content before the preview opens', async () => {
    routeRequests([nativeGroup]);
    renderFields({
      source: 'native',
      groupId: 'group1',
      selection: { type: 'exact', promptId: 'p1' },
    });

    const button = await screen.findByRole('button', { name: previewLabel });
    await waitFor(() => expect(button).not.toHaveAttribute('aria-disabled'));

    expect(requestedUrls().some((url) => url.includes('/api/prompts?groupId'))).toBe(false);
    expect(requestedUrls().some((url) => url.includes('/resolve'))).toBe(false);
  });

  it('shows the live unsaved selection as a raw template, read-only, with a link to the prompt', async () => {
    routeRequests([nativeGroup]);
    let methods: UseFormReturn<AgentForm> | undefined;
    renderFields(
      { source: 'native', groupId: 'group1', selection: { type: 'production' } },
      (m) => {
        methods = m;
      },
    );

    await screen.findByRole('button', { name: previewLabel });
    await act(async () => {
      methods!.setValue('instructionsPrompt', {
        source: 'native',
        groupId: 'group1',
        selection: { type: 'exact', promptId: 'p1' },
      });
    });

    const dialog = await openPreview();

    await waitFor(() => expect(dialog).toHaveTextContent('Version one for'));
    expect(dialog).toHaveTextContent('{{current_user}}');
    expect(dialog).not.toHaveTextContent('Ada');
    expect(dialog).toHaveTextContent('com_ui_version_var:{"0":"1"}');
    expect(screen.queryByRole('button', { name: 'com_ui_use_prompt' })).not.toBeInTheDocument();

    const link = screen.getByRole('link', { name: 'com_agents_instructions_prompt_open' });
    expect(link).toHaveAttribute('href', '/prompts/group1');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('reads native Production from the revision the version list marks, not the cached group', async () => {
    routeRequests([{ ...nativeGroup, productionPrompt: { prompt: 'Stale listing text' } }]);
    renderFields({ source: 'native', groupId: 'group1', selection: { type: 'production' } });

    const dialog = await openPreview();

    await waitFor(() => expect(dialog).toHaveTextContent('Production text for'));
    expect(dialog).not.toHaveTextContent('Stale listing text');
    expect(dialog).toHaveTextContent('com_agents_instructions_prompt_production_version:{"0":"2"}');
    expect(requestedUrls().some((url) => url.includes('/api/prompts?groupId=group1'))).toBe(true);
  });

  it('resolves a pinned Langfuse version by that version', async () => {
    mockLangfuseEnabled = true;
    routeRequests([langfuseGroup]);
    renderFields({
      source: 'langfuse',
      groupId: 'group2',
      selection: { type: 'exact', version: 4 },
    });

    const dialog = await openPreview();

    await waitFor(() => expect(dialog).toHaveTextContent('Langfuse v4 text'));
    expect(requestedUrls()).toContain('/api/prompts/groups/group2/resolve?version=4');
  });

  it('labels Langfuse Production with the version it resolved to', async () => {
    mockLangfuseEnabled = true;
    routeRequests([langfuseGroup]);
    renderFields({ source: 'langfuse', groupId: 'group2', selection: { type: 'production' } });

    const dialog = await openPreview();

    await waitFor(() => expect(dialog).toHaveTextContent('Langfuse production text'));
    expect(dialog).toHaveTextContent('com_agents_instructions_prompt_production_version:{"0":"5"}');
  });

  it('resolves Langfuse again on each open', async () => {
    mockLangfuseEnabled = true;
    routeRequests([langfuseGroup]);
    renderFields({ source: 'langfuse', groupId: 'group2', selection: { type: 'production' } });
    const resolveCount = () => requestedUrls().filter((url) => url.endsWith('/resolve')).length;

    let dialog = await openPreview();
    await waitFor(() => expect(dialog).toHaveTextContent('Langfuse production text'));
    expect(resolveCount()).toBe(1);

    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    dialog = await openPreview();
    await waitFor(() => expect(dialog).toHaveTextContent('Langfuse production text'));
    expect(resolveCount()).toBe(2);
  });

  it('returns focus to the preview button when the dialog closes', async () => {
    routeRequests([nativeGroup]);
    renderFields({ source: 'native', groupId: 'group1', selection: { type: 'production' } });

    const dialog = await openPreview();
    fireEvent.keyDown(dialog, { key: 'Escape' });

    await waitFor(() => expect(screen.getByRole('button', { name: previewLabel })).toHaveFocus());
  });
});
