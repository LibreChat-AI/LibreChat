import { render, screen } from '@testing-library/react';
import RestrictedInstructionsPrompt from '../RestrictedInstructionsPrompt';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

describe('RestrictedInstructionsPrompt', () => {
  it('renders a read-only notice with no group name or content', () => {
    render(<RestrictedInstructionsPrompt />);

    expect(screen.getByText('com_agents_instructions_prompt_restricted_title')).toBeInTheDocument();
    expect(
      screen.getByText('com_agents_instructions_prompt_restricted_description'),
    ).toBeInTheDocument();
    expect(screen.getByRole('note')).toBeInTheDocument();
  });
});
