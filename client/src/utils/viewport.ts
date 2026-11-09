/** Whether any part of `el` is inside the viewport and every clipping ancestor. */
export function isRectVisible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  let top = Math.max(rect.top, 0);
  let bottom = Math.min(rect.bottom, window.innerHeight);
  for (let node = el.parentElement; node != null && top < bottom; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === 'visible') {
      continue;
    }
    const clip = node.getBoundingClientRect();
    top = Math.max(top, clip.top);
    bottom = Math.min(bottom, clip.bottom);
  }
  return top < bottom;
}
