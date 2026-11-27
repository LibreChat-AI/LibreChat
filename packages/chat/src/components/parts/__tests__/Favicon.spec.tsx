/** @jest-environment jsdom */
import { render } from '@testing-library/react';
import type { ValidSource } from 'librechat-data-provider';
import { StackedFavicons } from '../Favicon';

const sources = ['a', 'b', 'c', 'd', 'e'].map(
  (name) => ({ link: `https://www.${name}.example.com/page`, title: name }) as ValidSource,
);

const domains = (container: HTMLElement) =>
  [...container.querySelectorAll('img')].map((img) => img.getAttribute('alt'));

describe('StackedFavicons', () => {
  it('shows the first three sources by default, each by its domain, overlapping after the first', () => {
    const { container } = render(<StackedFavicons sources={sources} />);
    expect(domains(container)).toEqual(['a.example.com', 'b.example.com', 'c.example.com']);
    const images = [...container.querySelectorAll('img')];
    expect(images[0].className).not.toContain('ms-[-0.375rem]');
    expect(images[1].className).toContain('ms-[-0.375rem]');
  });

  it('takes the last sources for a negative start, and a given range otherwise', () => {
    const last = render(<StackedFavicons sources={sources} start={-2} />);
    expect(domains(last.container)).toEqual(['d.example.com', 'e.example.com']);
    last.unmount();

    const range = render(<StackedFavicons sources={sources} start={1} end={2} />);
    expect(domains(range.container)).toEqual(['b.example.com']);
  });
});
