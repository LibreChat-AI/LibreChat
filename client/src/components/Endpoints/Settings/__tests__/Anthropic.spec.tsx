import React from 'react';
import { EModelEndpoint } from 'librechat-data-provider';
import type { TSetOption } from 'librechat-data-provider';
import type { TModelSelectProps } from '~/common';
import { render, screen, fireEvent, waitFor } from 'test/layout-test-utils';
import AnthropicSettings from '../Anthropic';
import { ChatContext } from '~/Providers';
import BedrockSettings from '../Bedrock';

type ChatContextValue = React.ContextType<typeof ChatContext>;

const chatContextValue = { preset: null } as ChatContextValue;

describe.each([
  [EModelEndpoint.anthropic, AnthropicSettings, 'claude-opus-'],
  [EModelEndpoint.bedrock, BedrockSettings, 'global.anthropic.claude-opus-'],
] as const)('%s settings', (endpoint, Settings, prefix) => {
  it('hides unsupported controls on Opus 5.5 and restores them when switching back', async () => {
    const commit = jest.fn();
    const setOption: TSetOption = jest.fn(() => commit);
    const conversation = {
      endpoint,
      model: `${prefix}5`,
      thinking: false,
      temperature: 0.7,
    } as TModelSelectProps['conversation'];
    const view = (model: string) => (
      <ChatContext.Provider value={chatContextValue}>
        <Settings
          conversation={{ ...conversation, model } as TModelSelectProps['conversation']}
          setOption={setOption}
          models={[`${prefix}5`, `${prefix}5-5`]}
        />
      </ChatContext.Provider>
    );
    const { rerender } = render(view(`${prefix}5`));
    expect(screen.getByRole('switch', { name: 'Thinking' })).toBeInTheDocument();
    const unsupported = ['Thinking Budget', 'Temperature', 'Top P', 'Top K'];
    unsupported.forEach((name) => expect(screen.getAllByLabelText(name).length).toBeGreaterThan(0));

    rerender(view(`${prefix}5-5`));
    expect(screen.queryByRole('switch', { name: 'Thinking' })).not.toBeInTheDocument();
    unsupported.forEach((name) => expect(screen.queryAllByLabelText(name)).toHaveLength(0));
    expect(screen.getByText('Effort')).toBeInTheDocument();
    expect(screen.getByText('Thought Visibility')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Effort' }), { key: 'End' });
    await waitFor(() => expect(commit).toHaveBeenLastCalledWith('max'));
    expect(setOption).toHaveBeenCalledWith('effort');
    expect(conversation?.thinking).toBe(false);
    expect(conversation?.temperature).toBe(0.7);

    rerender(view(`${prefix}5`));
    expect(screen.getByRole('switch', { name: 'Thinking' })).not.toBeChecked();
  });
});
