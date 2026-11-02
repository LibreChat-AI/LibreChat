/**
 * @jest-environment jsdom
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import MentionItem from '../MentionItem';

describe('MentionItem', () => {
  it('renders the name and description and reports clicks', () => {
    const onClick = jest.fn();
    render(
      <MentionItem
        name="Writer"
        description="Drafts prose"
        index={2}
        type="skill"
        onClick={onClick}
      />,
    );

    const button = screen.getByRole('button', { name: /Writer/ });
    expect(button).toHaveAttribute('id', 'skill-item-2');
    expect(button).toHaveTextContent('Drafts prose');

    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('highlights the active row with the active surface role', () => {
    const { rerender } = render(<MentionItem name="Writer" index={0} onClick={jest.fn()} />);
    const row = () => screen.getByRole('button').firstElementChild;
    expect(row()).toHaveClass('bg-transparent');

    rerender(<MentionItem name="Writer" index={0} isActive onClick={jest.fn()} />);
    expect(row()).toHaveClass('bg-surface-active');
  });
});
