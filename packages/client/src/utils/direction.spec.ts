import { isRtl, resolveSide, resolveArrowKey } from './direction';

function mount(dir: 'ltr' | 'rtl'): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('dir', dir);
  el.style.direction = dir;
  document.body.appendChild(el);
  return el;
}

describe('direction helpers', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('reads the direction from the element, not the document', () => {
    expect(isRtl(mount('rtl'))).toBe(true);
    expect(isRtl(mount('ltr'))).toBe(false);
    expect(isRtl(null)).toBe(false);
  });

  it('lets a CSS direction override win over an ancestor dir attribute', () => {
    const island = document.createElement('div');
    island.style.direction = 'rtl';
    mount('ltr').appendChild(island);
    expect(isRtl(island)).toBe(true);
  });

  it('swaps left and right placements for an RTL anchor only', () => {
    const rtl = mount('rtl');
    const ltr = mount('ltr');
    expect(resolveSide('right', rtl)).toBe('left');
    expect(resolveSide('left-start', rtl)).toBe('right-start');
    expect(resolveSide('top-end', rtl)).toBe('top-end');
    expect(resolveSide('bottom', rtl)).toBe('bottom');
    expect(resolveSide('right', ltr)).toBe('right');
    expect(resolveSide('left-end', undefined)).toBe('left-end');
  });

  it('swaps horizontal arrow keys for an RTL element only', () => {
    const rtl = mount('rtl');
    const ltr = mount('ltr');
    expect(resolveArrowKey('ArrowRight', rtl)).toBe('ArrowLeft');
    expect(resolveArrowKey('ArrowLeft', rtl)).toBe('ArrowRight');
    expect(resolveArrowKey('ArrowUp', rtl)).toBe('ArrowUp');
    expect(resolveArrowKey('ArrowRight', ltr)).toBe('ArrowRight');
  });
});
