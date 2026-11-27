/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { initEnglish } from '../../../__fixtures__/i18n';
import MessageQuotes from '../MessageQuotes';

beforeAll(initEnglish);

describe('MessageQuotes', () => {
  it('renders nothing when quotes is undefined', () => {
    const { container } = render(<MessageQuotes />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when quotes is empty', () => {
    const { container } = render(<MessageQuotes quotes={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders one reference block per quote, preserving text', () => {
    render(<MessageQuotes quotes={['first excerpt', 'second excerpt']} />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('first excerpt');
    expect(items[1]).toHaveTextContent('second excerpt');
  });

  it('localizes the list aria-label', () => {
    render(<MessageQuotes quotes={['excerpt']} />);
    expect(screen.getByRole('list')).toHaveAttribute('aria-label', 'Referenced quotes');
  });

  it('renders duplicate quote strings as separate blocks', () => {
    render(<MessageQuotes quotes={['same', 'same']} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });
});
