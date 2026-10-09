import { reconcileMessageContentLayout } from '../messageLayout';

function setRect(element: HTMLElement, rect: Partial<DOMRect>): void {
  element.getBoundingClientRect = jest.fn(
    () =>
      ({
        x: rect.x ?? 0,
        y: rect.y ?? 0,
        top: rect.top ?? 0,
        left: rect.left ?? 0,
        right: rect.right ?? 0,
        bottom: rect.bottom ?? 0,
        width: rect.width ?? 0,
        height: rect.height ?? 0,
        toJSON: () => ({}),
      }) as DOMRect,
  );
}

describe('message layout reconciliation', () => {
  it('clamps to the rendered content bottom when the scroll container is still oversized', () => {
    const scrollable = document.createElement('div');
    const content = document.createElement('div');
    const target = document.createElement('button');

    scrollable.className = 'scrollbar-gutter-stable';
    content.append(target);
    scrollable.append(content);
    document.body.append(scrollable);

    Object.defineProperty(scrollable, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(scrollable, 'clientHeight', { value: 200, configurable: true });
    scrollable.scrollTop = 700;
    setRect(scrollable, { top: 0, bottom: 200, height: 200 });
    setRect(content, { top: -700, bottom: -200, height: 500 });

    expect(reconcileMessageContentLayout(target)).toBe(true);
    expect(scrollable.scrollTop).toBe(300);

    document.body.removeChild(scrollable);
  });
});
