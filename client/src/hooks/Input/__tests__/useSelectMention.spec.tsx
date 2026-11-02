import React from 'react';
import { RecoilRoot } from 'recoil';
import { MemoryRouter } from 'react-router-dom';
import { renderHook } from '@testing-library/react';
import { EModelEndpoint } from 'librechat-data-provider';
import type { TConversation, TModelSpec } from 'librechat-data-provider';
import { useGetStartupConfig } from '~/data-provider';
import useSelectMention from '../useSelectMention';

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: jest.fn(),
}));

/** Stands in for useDefaultConvo: the stored conversation with the template applied over it. */
jest.mock('~/hooks', () => ({
  useDefaultConvo:
    () =>
    ({ conversation, preset }: { conversation: TConversation; preset: TConversation }) => ({
      ...conversation,
      ...preset,
    }),
}));

const mockUseGetStartupConfig = useGetStartupConfig as jest.Mock;

const conversation = {
  conversationId: 'convo-1',
  endpoint: EModelEndpoint.azureOpenAI,
  model: 'gpt-6-luna-dz',
  maxContextTokens: 950000,
} as TConversation;

const gpt54Spec: TModelSpec = {
  name: 'gpt-5.4-dz',
  label: 'GPT 5.4',
  preset: { endpoint: EModelEndpoint.azureOpenAI, model: 'gpt-5.4-dz' },
};

const lunaSpec: TModelSpec = {
  name: 'gpt-6-luna-dz',
  label: 'GPT 6 luna',
  preset: { endpoint: EModelEndpoint.azureOpenAI, model: 'gpt-6-luna-dz' },
};

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <RecoilRoot>
    <MemoryRouter>{children}</MemoryRouter>
  </RecoilRoot>
);

const renderHandlers = (resetMaxContextTokensOnModelSwitch?: boolean) => {
  mockUseGetStartupConfig.mockReturnValue({ data: { resetMaxContextTokensOnModelSwitch } });
  const newConversation = jest.fn();
  const { result } = renderHook(
    () =>
      useSelectMention({
        modelSpecs: [gpt54Spec, lunaSpec],
        returnHandlers: true,
        endpointsConfig: {},
        getConversation: () => conversation,
        newConversation,
      }),
    { wrapper },
  );
  const lastTemplate = () => {
    expect(newConversation).toHaveBeenCalledTimes(1);
    return newConversation.mock.calls[0][0].template as Partial<TConversation>;
  };
  return { handlers: result.current, lastTemplate };
};

describe('switching models mid-conversation resets Max Context Tokens', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('clears the saved value when a spec with another model is selected', () => {
    const { handlers, lastTemplate } = renderHandlers(true);
    handlers.onSelectSpec?.(gpt54Spec);
    expect(lastTemplate().maxContextTokens).toBeUndefined();
  });

  it('clears the saved value when another model is picked from the endpoint menu', () => {
    const { handlers, lastTemplate } = renderHandlers(true);
    handlers.onSelectEndpoint?.(EModelEndpoint.azureOpenAI, { model: 'gpt-5.4-dz' });
    expect(lastTemplate().maxContextTokens).toBeUndefined();
  });

  it('clears the saved value when the endpoint changes', () => {
    const { handlers, lastTemplate } = renderHandlers(true);
    handlers.onSelectEndpoint?.(EModelEndpoint.openAI, { model: 'gpt-5.4-dz' });
    expect(lastTemplate().maxContextTokens).toBeUndefined();
  });

  it('keeps the saved value when the same model is selected again', () => {
    const { handlers, lastTemplate } = renderHandlers(true);
    handlers.onSelectSpec?.(lunaSpec);
    expect(lastTemplate().maxContextTokens).toBe(950000);
  });

  it('keeps the saved value when the setting is off', () => {
    const { handlers, lastTemplate } = renderHandlers(false);
    handlers.onSelectSpec?.(gpt54Spec);
    expect(lastTemplate().maxContextTokens).toBe(950000);
  });

  it('keeps the saved value when the setting is absent', () => {
    const { handlers, lastTemplate } = renderHandlers();
    handlers.onSelectSpec?.(gpt54Spec);
    expect(lastTemplate().maxContextTokens).toBe(950000);
  });
});
