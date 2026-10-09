import React from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import SkillMarkdownRenderer from '../SkillMarkdownRenderer';

function LocationProbe() {
  const location = useLocation();

  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function renderMarkdown(content: string, currentFilePath = 'SKILL.md') {
  return render(
    <MemoryRouter initialEntries={['/skills/skill-id']}>
      <SkillMarkdownRenderer
        content={content}
        skillId="skill-id"
        currentFilePath={currentFilePath}
      />
      <LocationProbe />
    </MemoryRouter>,
  );
}

describe('SkillMarkdownRenderer', () => {
  it('routes relative links from SKILL.md to the skill file viewer', () => {
    renderMarkdown('[source selection](references/source-selection.md)');

    const link = screen.getByRole('link', { name: 'source selection' });
    expect(link).toHaveAttribute('href', '/skills/skill-id?file=references%2Fsource-selection.md');

    fireEvent.click(link);

    expect(screen.getByTestId('location')).toHaveTextContent(
      '/skills/skill-id?file=references%2Fsource-selection.md',
    );
  });

  it('normalizes relative links from a nested markdown file', () => {
    renderMarkdown(
      [
        '[sibling](./source.md)',
        '[parent](../overview.md)',
        '[encoded](../source%20selection.md#details)',
      ].join('\n\n'),
      'references/guides/current.md',
    );

    expect(screen.getByRole('link', { name: 'sibling' })).toHaveAttribute(
      'href',
      '/skills/skill-id?file=references%2Fguides%2Fsource.md',
    );
    expect(screen.getByRole('link', { name: 'parent' })).toHaveAttribute(
      'href',
      '/skills/skill-id?file=references%2Foverview.md',
    );
    expect(screen.getByRole('link', { name: 'encoded' })).toHaveAttribute(
      'href',
      '/skills/skill-id?file=references%2Fsource%20selection.md#details',
    );
  });

  it.each([
    ['external URL', 'https://example.com/docs'],
    ['mailto link', 'mailto:person@example.com'],
    ['telephone link', 'tel:+1234567890'],
    ['page anchor', '#section'],
    ['absolute app path', '/settings'],
    ['protocol-relative URL', '//cdn.example.com/file.md'],
  ])('leaves %s unchanged', (label, href) => {
    renderMarkdown(`[${label}](${href})`);

    expect(screen.getByRole('link', { name: label })).toHaveAttribute('href', href);
  });

  it('continues to sanitize unsafe URL protocols', () => {
    renderMarkdown('[unsafe](javascript:alert(1))');

    expect(screen.getByRole('link', { name: 'unsafe' })).toHaveAttribute('href', '');
  });
});
