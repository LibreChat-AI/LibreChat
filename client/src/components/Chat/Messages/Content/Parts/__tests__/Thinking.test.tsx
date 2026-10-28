import React from 'react';
import { render, screen } from '@testing-library/react';
import { ThinkingButton, ThinkingLabel } from '../Thinking';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useExpandCollapse: () => ({ style: {}, ref: { current: null } }),
}));

jest.mock('~/store/fontSize', () => ({
  fontSizeAtom: { toString: () => 'fontSizeAtom' },
}));

jest.mock('jotai', () => ({
  ...jest.requireActual('jotai'),
  useAtomValue: () => 'text-xl',
}));

jest.mock('~/components/Messages/Content/CopyButton', () => ({
  __esModule: true,
  default: () => <button type="button" data-testid="copy-thoughts" />,
}));

/** Every activity row — a tool call, a grouped thought, a phase summary — is
 *  set at `tool-status-text`. A reasoning header sized to the reader's body
 *  text instead was the one row that grew with that setting, so the same
 *  thought read at two sizes depending on which surface held it. */
describe('reasoning header rows', () => {
  it('sets the thinking disclosure at the shared row scale, not the body size', () => {
    render(
      <ThinkingButton
        isExpanded={false}
        onClick={() => {}}
        label="Reframing the analysis"
        contentId="thoughts"
      />,
    );
    const button = screen.getByRole('button', { name: 'Reframing the analysis' });
    expect(button).toHaveClass('tool-status-text');
    expect(button).not.toHaveClass('text-xl');
    expect(screen.getByText('Reframing the analysis')).toHaveClass('font-medium');
  });

  it('sets the non-interactive marker the same way', () => {
    render(<ThinkingLabel label="Thoughts" />);
    const label = screen.getByText('Thoughts');
    expect(label.parentElement).toHaveClass('tool-status-text');
    expect(label.parentElement).not.toHaveClass('text-xl');
    expect(label).toHaveClass('font-medium');
  });
});
