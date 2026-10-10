import { render } from '@testing-library/react';
import FileIcon from './FileIcon';

const Paths = () => <path d="M0 0h1v1z" />;

const tile = (container: HTMLElement) => container.querySelector('rect');

describe('FileIcon', () => {
  it('paints the tile with a theme role through fillClassName', () => {
    const { container } = render(
      <FileIcon fileType={{ paths: Paths, fillClassName: 'fill-file-document', title: 'Doc' }} />,
    );
    expect(tile(container)?.getAttribute('class')).toBe('fill-file-document');
    expect(tile(container)?.hasAttribute('fill')).toBe(false);
  });

  it('keeps a colour passed as fill, as callers did before the roles', () => {
    const { container } = render(
      <FileIcon fileType={{ paths: Paths, fill: '#FF5588', title: 'Doc' }} />,
    );
    expect(tile(container)?.getAttribute('fill')).toBe('#FF5588');
    expect(tile(container)?.hasAttribute('class')).toBe(false);
  });
});
