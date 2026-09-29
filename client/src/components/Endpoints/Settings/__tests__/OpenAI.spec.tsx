import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EModelEndpoint, ReasoningEffort, QueryKeys } from 'librechat-data-provider';
import type { TSetOption } from 'librechat-data-provider';
import type { TModelSelectProps } from '~/common';
import {
  pruneAgentModelParameters,
  resolveAgentParameterSettings,
} from '~/components/SidePanel/Agents/parameters';
import { render, screen, fireEvent, waitFor } from 'test/layout-test-utils';
import { ChatContext } from '~/Providers';
import OpenAISettings from '../OpenAI';

const context = { preset: null } as React.ContextType<typeof ChatContext>;
describe.each([EModelEndpoint.openAI, EModelEndpoint.azureOpenAI])(
  '%s Sol/Luna settings',
  (endpoint) => {
    it.each(['gpt-6-sol', 'gpt-6-luna'])(
      'preserves stored effort when switching to %s and back',
      async (model) => {
        const commit = jest.fn();
        const setOption: TSetOption = jest.fn(() => commit);
        const saved = {
          endpoint,
          model: 'gpt-5.6',
          reasoning_effort: ReasoningEffort.minimal,
          temperature: 0.7,
        } as TModelSelectProps['conversation'];
        const queryClient = new QueryClient();
        queryClient.setQueryData([QueryKeys.endpoints], {});
        const view = (model: string) => (
          <QueryClientProvider client={queryClient}>
            <ChatContext.Provider value={context}>
              <OpenAISettings
                conversation={{ ...saved, model } as TModelSelectProps['conversation']}
                setOption={setOption}
                models={['gpt-5.6', model]}
              />
            </ChatContext.Provider>
          </QueryClientProvider>
        );
        const { rerender } = render(view('gpt-5.6'));
        const slider = () => screen.getByRole('slider', { name: 'Reasoning Effort' });
        expect(slider()).toHaveAttribute('aria-valuemax', '7');
        rerender(view(model));
        expect(slider()).toHaveAttribute('aria-valuemax', '6');
        expect(saved?.reasoning_effort).toBe(ReasoningEffort.minimal);
        fireEvent.keyDown(slider(), { key: 'End' });
        await waitFor(() => expect(commit).toHaveBeenLastCalledWith(ReasoningEffort.max));
        expect(setOption).toHaveBeenCalledWith('reasoning_effort');
        rerender(view('gpt-5.6'));
        expect(slider()).toHaveAttribute('aria-valuemax', '7');
        expect(saved?.temperature).toBe(0.7);
      },
    );
    it.each(['gpt-6-sol', 'gpt-6-luna'])(
      'shows effective Responses routing for unset %s while preserving explicit false',
      (model) => {
        const setOption: TSetOption = jest.fn(() => jest.fn());
        const queryClient = new QueryClient();
        queryClient.setQueryData([QueryKeys.endpoints], {
          [endpoint]: { responsesApiRouting: { [model]: { default: true, on: true, off: false } } },
        });
        const view = (useResponsesApi?: boolean) => (
          <QueryClientProvider client={queryClient}>
            <ChatContext.Provider value={context}>
              <OpenAISettings
                conversation={
                  { endpoint, model, useResponsesApi } as TModelSelectProps['conversation']
                }
                setOption={setOption}
                models={[model]}
              />
            </ChatContext.Provider>
          </QueryClientProvider>
        );
        const { rerender } = render(view());
        expect(screen.getByRole('switch', { name: 'Use Responses API' })).toBeChecked();
        rerender(view(false));
        expect(screen.getByRole('switch', { name: 'Use Responses API' })).not.toBeChecked();
      },
    );

    it.each([false, true])(
      'displays an admin-forced route %s without replacing a saved opposite toggle',
      (effective) => {
        const queryClient = new QueryClient();
        const model = 'gpt-6-sol';
        queryClient.setQueryData([QueryKeys.endpoints], {
          [endpoint]: {
            responsesApiRouting: {
              [model]: { default: effective, on: effective, off: effective },
            },
          },
        });
        const setOption: TSetOption = jest.fn(() => jest.fn());
        const conversation = {
          endpoint,
          model,
          useResponsesApi: !effective,
        } as TModelSelectProps['conversation'];
        render(
          <QueryClientProvider client={queryClient}>
            <ChatContext.Provider value={context}>
              <OpenAISettings conversation={conversation} setOption={setOption} models={[model]} />
            </ChatContext.Provider>
          </QueryClientProvider>,
        );
        const toggle = screen.getByRole('switch', { name: 'Use Responses API' });
        expect(toggle).toHaveAttribute('aria-checked', String(effective));
        expect(toggle).toBeDisabled();
        expect(conversation?.useResponsesApi).toBe(!effective);
        expect(setOption).not.toHaveBeenCalled();
      },
    );

    it('keeps unsupported saved effort through the agent pruning boundary', () => {
      const settings = resolveAgentParameterSettings({
        provider: endpoint,
        model: 'gpt-6-sol',
        webSearchAllowed: true,
      });
      const saved = {
        temperature: 0.7,
        maxContextTokens: null,
        max_context_tokens: null,
        max_output_tokens: null,
        top_p: null,
        frequency_penalty: null,
        presence_penalty: null,
        reasoning_effort: ReasoningEffort.minimal,
      };
      expect(pruneAgentModelParameters(saved, settings)).toBe(saved);
      expect(
        settings.visibleParameters.find(({ key }) => key === 'reasoning_effort')?.options,
      ).not.toContain(ReasoningEffort.minimal);
    });
  },
);
