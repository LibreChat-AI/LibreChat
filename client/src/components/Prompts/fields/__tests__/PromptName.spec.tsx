import React from 'react';
import '@testing-library/jest-dom/extend-expect';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import PromptName from '../PromptName';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('@librechat/client', () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  TooltipAnchor: ({ render: content }: { render: React.ReactNode }) => content,
}));

describe('PromptName disabled', () => {
  it('keeps the name read-only: clicking it does not open a textbox', async () => {
    const user = userEvent.setup();
    const onSave = jest.fn();
    render(<PromptName name="Example" disabled onSave={onSave} />);

    expect(screen.getByText('Example')).toBeInTheDocument();
    expect(screen.queryByLabelText(/com_ui_edit/)).not.toBeInTheDocument();

    await user.click(screen.getByText('Example'));

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('clicking the name opens a textbox when not disabled', async () => {
    const user = userEvent.setup();
    const onSave = jest.fn();
    render(<PromptName name="Example" onSave={onSave} />);

    await user.click(screen.getByText('Example'));

    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });
});
