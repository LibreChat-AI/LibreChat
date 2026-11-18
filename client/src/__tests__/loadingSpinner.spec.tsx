import React from 'react';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { Spinner } from '@librechat/client';
import { render } from '@testing-library/react';

/** The shell paints before the bundle runs, so it copies the shared Spinner's markup instead of
 *  rendering it. This holds the copy to the component, so the two never drift apart. */
const shellSpinner = (() => {
  const html = readFileSync(join(__dirname, '..', '..', 'index.html'), 'utf8');
  const document = new DOMParser().parseFromString(html, 'text/html');
  const svg = document.querySelector('#loading-container svg');
  if (!svg) {
    throw new Error('index.html no longer carries the loading spinner');
  }
  return svg;
})();

const CIRCLE_ATTRIBUTES = [
  'cx',
  'cy',
  'r',
  'pathLength',
  'stroke-width',
  'fill',
  'stroke',
  'stroke-opacity',
  'stroke-dasharray',
  'stroke-linecap',
];

const describeSvg = (svg: Element) => ({
  viewBox: svg.getAttribute('viewBox'),
  width: svg.getAttribute('width'),
  height: svg.getAttribute('height'),
  spins: svg.classList.contains('spinner'),
  hidden: svg.getAttribute('aria-hidden'),
  circles: [...svg.querySelectorAll('circle')].map((circle) =>
    Object.fromEntries(CIRCLE_ATTRIBUTES.map((name) => [name, circle.getAttribute(name)])),
  ),
});

describe('loading shell spinner', () => {
  it('matches the shared Spinner at the size the shell uses', () => {
    const { container } = render(<Spinner size={32} />);
    const component = container.querySelector('svg');
    expect(component).not.toBeNull();

    expect(describeSvg(shellSpinner)).toEqual(describeSvg(component!));
  });
});
