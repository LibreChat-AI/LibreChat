import React from 'react';
import { render, screen } from '@testing-library/react';
import type { TMessage } from 'librechat-data-provider';
import PromptCacheResetNotice from '../PromptCacheResetNotice';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) =>
    key === 'com_ui_context_reloaded'
      ? 'Earlier context was reloaded; the next reply may be slower.'
      : key,
}));

const reply = (metadata?: Record<string, unknown>) =>
  ({ messageId: 'response-1', metadata }) as TMessage;

describe('PromptCacheResetNotice', () => {
  it('says earlier context was reloaded when the server reported a reset', () => {
    render(<PromptCacheResetNotice message={reply({ promptCacheReset: ['model'] })} />);

    expect(
      screen.getByText('Earlier context was reloaded; the next reply may be slower.'),
    ).toBeInTheDocument();
  });

  it.each([[{ usage: {} }], [{ promptCacheReset: [] }], [undefined]])(
    'renders nothing for a reply without a reset (%j)',
    (metadata) => {
      const { container } = render(<PromptCacheResetNotice message={reply(metadata)} />);

      expect(container).toBeEmptyDOMElement();
    },
  );
});
