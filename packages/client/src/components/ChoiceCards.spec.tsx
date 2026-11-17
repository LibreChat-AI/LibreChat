import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import { ChoiceCards } from './ChoiceCards';

const OPTIONS = [
  { value: 'a', label: 'Alpha', icon: <svg data-testid="icon-a" /> },
  { value: 'b', label: 'Beta', icon: <svg data-testid="icon-b" /> },
];

describe('ChoiceCards', () => {
  it('exposes the cards as one labelled radio group and marks the chosen one', () => {
    render(
      <>
        <span id="lbl">Pick one</span>
        <ChoiceCards options={OPTIONS} value="b" onChange={jest.fn()} aria-labelledby="lbl" />
      </>,
    );

    expect(screen.getByRole('radiogroup', { name: 'Pick one' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Beta' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Alpha' })).not.toBeChecked();
    expect(screen.getByTestId('icon-a')).toBeInTheDocument();
  });

  it('names each card by its title and describes it with its explanation', () => {
    render(
      <ChoiceCards
        options={[{ ...OPTIONS[0], description: 'Does the first thing' }, OPTIONS[1]]}
        value="a"
        onChange={jest.fn()}
        aria-label="Choice"
      />,
    );

    const alpha = screen.getByRole('radio', { name: 'Alpha' });
    expect(alpha).toHaveAccessibleDescription('Does the first thing');
    expect(screen.getByRole('radio', { name: 'Beta' })).not.toHaveAccessibleDescription();
  });

  it('draws the mark on the chosen card only, and moves it with the choice', () => {
    const { container, rerender } = render(
      <ChoiceCards options={OPTIONS} value="a" onChange={jest.fn()} aria-label="Choice" />,
    );
    const marks = () => container.querySelectorAll('.choice-badge');

    expect(marks()).toHaveLength(1);
    expect(screen.getByRole('radio', { name: 'Alpha' }).closest('label')).toContainElement(
      marks()[0] as HTMLElement,
    );
    expect(marks()[0].querySelector('path')).toBeInTheDocument();

    rerender(<ChoiceCards options={OPTIONS} value="b" onChange={jest.fn()} aria-label="Choice" />);
    expect(marks()).toHaveLength(1);
    expect(screen.getByRole('radio', { name: 'Beta' }).closest('label')).toContainElement(
      marks()[0] as HTMLElement,
    );
  });

  it('reports a pick by click and by arrow key', async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    render(<ChoiceCards options={OPTIONS} value="a" onChange={onChange} aria-label="Choice" />);

    await user.click(screen.getByText('Beta'));
    expect(onChange).toHaveBeenLastCalledWith('b');

    screen.getByRole('radio', { name: 'Alpha' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenLastCalledWith('b');
  });

  it('does not report a pick while disabled', async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    render(
      <ChoiceCards options={OPTIONS} value="a" onChange={onChange} disabled aria-label="Choice" />,
    );

    await user.click(screen.getByText('Beta'));
    expect(onChange).not.toHaveBeenCalled();
  });
});
