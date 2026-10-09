import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { TextareaAutosize } from './TextareaAutosize';
import { SecretInput } from './SecretInput';
import { floatingLabel } from './floating';
import { fieldInvalid } from './Field';
import { Textarea } from './Textarea';
import { Input } from './Input';
import { cn } from '~/utils';

const FLUSH = ['border-0', 'focus-visible:ring-0', 'theme-field-fill:bg-transparent'];
const EMBEDDED = [
  'bg-surface-tertiary-alt',
  'h-auto',
  'w-full',
  'border-0',
  'p-2',
  'rounded-none',
  'text-sm',
  'text-text-primary',
  'theme-field-fill:bg-surface-tertiary-alt',
];
const FRAMED = [
  'lc-own-focus',
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
    ['border', 'focus-visible:ring-2'].forEach((name) => expect(input).not.toHaveClass(name));
  });

  it('Input embedded merges to the same classes as the call site it replaces', () => {
    render(<Input aria-label="name" variant="embedded" />);
    const input = screen.getByLabelText('name');
    expect(input).toHaveClass(...EMBEDDED);
    ['rounded-lg', 'border', 'px-3', 'bg-transparent'].forEach((name) =>
      expect(input).not.toHaveClass(name),
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
    expect(field.className).toBe(cn(fieldInvalid, 'resize-none'));
  });

  it('TextareaAutosize field takes the control outline and focus ring of a form field', () => {
    render(<TextareaAutosize aria-label="draft" variant="field" className="resize-none" />);
    expect(screen.getByLabelText('draft')).toHaveClass(
      'lc-field',
      'border-border-control',
      'focus-visible:ring-focus-control',
      'bg-transparent',
      'resize-none',
    );
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

  it('flush and embedded variants drop the base field fill in every control that carries it', () => {
    render(
      <div>
        <Input aria-label="if" variant="flush" />
        <Input aria-label="ie" variant="embedded" />
        <Textarea aria-label="tf" variant="flush" />
        <Textarea aria-label="te" variant="embedded" />
        <Textarea aria-label="tt" variant="transparent" />
        <Textarea aria-label="td" variant="document" />
      </div>,
    );
    for (const label of ['if', 'ie', 'tf', 'te', 'tt', 'td']) {
      expect(screen.getByLabelText(label).className).not.toContain('bg-field-fill');
    }
  });

  it('TextareaAutosize flush and framed keep the global textarea outline off', () => {
    render(
      <div>
        <TextareaAutosize aria-label="f" variant="flush" />
        <TextareaAutosize aria-label="r" variant="framed" />
      </div>,
    );
    expect(screen.getByLabelText('f')).toHaveClass('lc-own-focus');
    expect(screen.getByLabelText('r')).toHaveClass('lc-own-focus');
  });
});
