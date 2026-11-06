/** Supply layout and observer events for tests that wait for a card to become visible. */
export function mockVisibility() {
  let visible = true;
  const observers = new Map<IntersectionObserver, IntersectionObserverCallback>();
  const rectSpy = jest
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(() => {
      const top = visible ? 100 : window.innerHeight + 200;
      return {
        x: 0,
        y: top,
        top,
        bottom: top + 200,
        left: 0,
        right: 300,
        width: 300,
        height: 200,
        toJSON: () => ({}),
      };
    });
  const observerSpy = jest
    .spyOn(window, 'IntersectionObserver')
    .mockImplementation((callback: IntersectionObserverCallback) => {
      const targets = new Set<Element>();
      // Unannotated so the extra `scrollMargin` is accepted by DOM libs that predate it.
      const observer = {
        root: null,
        rootMargin: '0px',
        scrollMargin: '0px',
        thresholds: [0],
        observe: (target: Element) => {
          targets.add(target);
          observers.set(observer, callback);
        },
        unobserve: (target: Element) => {
          targets.delete(target);
          if (targets.size === 0) {
            observers.delete(observer);
          }
        },
        disconnect: () => {
          targets.clear();
          observers.delete(observer);
        },
        takeRecords: () => [],
      };
      return observer;
    });

  return {
    setVisible(value: boolean) {
      visible = value;
    },
    notify() {
      // Arrival focus reads the target's rectangle when the observer reports a change.
      observers.forEach((callback, observer) => callback([], observer));
    },
    restore() {
      observers.clear();
      observerSpy.mockRestore();
      rectSpy.mockRestore();
    },
  };
}
