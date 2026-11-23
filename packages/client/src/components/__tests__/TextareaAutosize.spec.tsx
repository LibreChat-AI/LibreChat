import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { TextareaAutosize } from '../TextareaAutosize';

describe('TextareaAutosize direction', () => {
  it('lets the text decide its direction when the caller does not', () => {
    render(<TextareaAutosize aria-label="draft" />);
    expect(screen.getByLabelText('draft')).toHaveAttribute('dir', 'auto');
  });

  it('keeps a direction the caller forces', () => {
    render(<TextareaAutosize aria-label="draft" dir="rtl" />);
    expect(screen.getByLabelText('draft')).toHaveAttribute('dir', 'rtl');
  });
});
