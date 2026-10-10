import React from 'react';
import { render, screen } from '@testing-library/react';
import { Textarea } from '../Textarea';
import { Input } from '../Input';

describe('field type floor on touch devices', () => {
  it('keeps Input and Textarea at 16px under a coarse pointer', () => {
    render(
      <>
        <Input aria-label="plain" />
        <Textarea aria-label="area" />
      </>,
    );
    expect(screen.getByLabelText('plain')).toHaveClass('pointer-coarse:text-[16px]');
    expect(screen.getByLabelText('area')).toHaveClass('pointer-coarse:text-[16px]');
  });

  it('keeps the title variant at its heading size instead of the floor', () => {
    render(<Input aria-label="title" variant="title" />);
    const input = screen.getByLabelText('title');
    expect(input).toHaveClass('pointer-coarse:text-2xl');
    expect(input).not.toHaveClass('pointer-coarse:text-[16px]');
  });
});
