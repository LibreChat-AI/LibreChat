import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { TextareaAutosize } from './TextareaAutosize';
import { SecretInput } from './SecretInput';
import { floatingLabel } from './floating';
import { Textarea } from './Textarea';
import { Input } from './Input';
import { cn } from '~/utils';

const FLUSH = ['border-0', 'focus-visible:ring-0'];
const EMBEDDED = ['bg-surface-tertiary-alt', 'border-0', 'p-2', 'rounded-none', 'text-sm'];
const FRAMED = [
  'rounded-xl',
  'border',
  'border-border-medium',
  'bg-transparent',
  'text-text-primary',
  'placeholder:text-text-secondary',
  'focus-visible:ring-2',
  'focus-visible:ring-focus-control',
];

describe('field variants', () => {
  it('Input keeps its bordered default and draws the destructive border when invalid', () => {
    render(<Input aria-label="name" />);
    const input = screen.getByLabelText('name');
    expect(input).toHaveClass(
      'border',
      'border-border-control',
      'aria-invalid:border-border-destructive',
    );
    expect(input).not.toHaveClass('border-0');
  });

  it('Input flush drops the border and the focus ring', () => {
    render(<Input aria-label="name" variant="flush" />);
    const input = screen.getByLabelText('name');
    expect(input).toHaveClass(...FLUSH);
    expect(input).not.toHaveClass('border', 'focus-visible:ring-2');
  });

  it('Input embedded merges to the same classes as the call site it replaces', () => {
    render(<Input aria-label="name" variant="embedded" />);
    const input = screen.getByLabelText('name');
    expect(input).toHaveClass(...EMBEDDED);
    expect(input).not.toHaveClass(
      'rounded-lg',
      'border',
      'px-3',
      'bg-transparent',
      'text-sm text-field-text',
    );
  });

  it('Textarea flush is transparent with no border or ring, and embedded fills the row', () => {
    render(
      <>
        <Textarea aria-label="flush" variant="flush" />
        <Textarea aria-label="embedded" variant="embedded" />
      </>,
    );
    expect(screen.getByLabelText('flush')).toHaveClass('bg-transparent', ...FLUSH);
    expect(screen.getByLabelText('flush')).not.toHaveClass('bg-surface-secondary');
    expect(screen.getByLabelText('embedded')).toHaveClass(...EMBEDDED);
  });

  it('Textarea default keeps the secondary fill and draws the destructive border when invalid', () => {
    render(<Textarea aria-label="notes" />);
    expect(screen.getByLabelText('notes')).toHaveClass(
      'bg-surface-secondary',
      'border',
      'aria-invalid:border-border-destructive',
    );
  });

  it('TextareaAutosize adds nothing by default', () => {
    render(<TextareaAutosize aria-label="draft" className="resize-none" />);
    const field = screen.getByLabelText('draft');
    expect(field.className).toBe(cn('aria-invalid:border-border-destructive', 'resize-none'));
  });

  it('TextareaAutosize framed carries the bordered editor box exactly', () => {
    render(<TextareaAutosize aria-label="draft" variant="framed" className="min-h-20" />);
    const field = screen.getByLabelText('draft');
    expect(field).toHaveClass(...FRAMED, 'min-h-20');
  });

  it('TextareaAutosize framed lets a caller override a role', () => {
    render(
      <TextareaAutosize aria-label="draft" variant="framed" className="border-border-light" />,
    );
    const field = screen.getByLabelText('draft');
    expect(field).toHaveClass('border-border-light');
    expect(field).not.toHaveClass('border-border-medium');
  });

  it('TextareaAutosize flush and embedded match their Input counterparts', () => {
    render(
      <>
        <TextareaAutosize aria-label="flush" variant="flush" />
        <TextareaAutosize aria-label="embedded" variant="embedded" />
      </>,
    );
    expect(screen.getByLabelText('flush')).toHaveClass(...FLUSH);
    expect(screen.getByLabelText('embedded')).toHaveClass(...EMBEDDED);
  });

  it('SecretInput follows the Input variants', () => {
    render(<SecretInput aria-label="key" variant="flush" />);
    expect(screen.getByLabelText('key')).toHaveClass(...FLUSH);
  });

  it('paints the floating label chip in the field fill when the theme fills fields', () => {
    expect(floatingLabel).toContain('bg-surface-primary');
    expect(floatingLabel).toContain('theme-field-fill:bg-field-fill');
  });
});
