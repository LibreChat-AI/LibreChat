/**
 * @jest-environment jsdom
 */
import { Constants } from 'librechat-data-provider';
import { fireEvent, render, screen } from '@testing-library/react';
import ChatStarters from '../starters';

describe('ChatStarters', () => {
  it('renders nothing without suggestions', () => {
    const { container } = render(<ChatStarters starters={[]} onSelect={jest.fn()} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('offers at most the configured number of suggestions, in order', () => {
    const starters = Array.from({ length: Constants.MAX_CONVO_STARTERS + 2 }, (_, i) => `s${i}`);
    render(<ChatStarters starters={starters} onSelect={jest.fn()} />);

    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(
      starters.slice(0, Constants.MAX_CONVO_STARTERS),
    );
  });

  it('sends the chosen suggestion as written', () => {
    const onSelect = jest.fn();
    render(<ChatStarters starters={['first', 'second']} onSelect={onSelect} />);

    fireEvent.click(screen.getByRole('button', { name: 'second' }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('second');
  });

  it('staggers the entrance by position', () => {
    render(<ChatStarters starters={['first', 'second']} onSelect={jest.fn()} />);

    expect(
      screen.getByRole('button', { name: 'second' }).style.getPropertyValue('--starter-delay'),
    ).toBe('75ms');
  });
});
