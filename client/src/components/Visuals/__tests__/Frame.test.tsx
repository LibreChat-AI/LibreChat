import React from 'react';
import { VisualBridgeMethod } from 'librechat-data-provider';
import { act, fireEvent, render, screen } from '@testing-library/react';
import VisualFrame from '../Frame';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

const READY = { jsonrpc: '2.0', method: VisualBridgeMethod.proxyReady };
const HTML = '<!doctype html><html><head></head><body><p>chart</p></body></html>';

function setup() {
  const view = render(<VisualFrame html={HTML} title="Revenue" />);
  const iframe = view.container.querySelector('iframe') as HTMLIFrameElement;
  const frameWindow = iframe.contentWindow as Window;
  const postMessage = jest.spyOn(frameWindow, 'postMessage').mockImplementation(() => undefined);
  const send = (data: unknown, source: MessageEventSource | null = frameWindow) =>
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data, source }));
    });
  return { ...view, iframe, postMessage, send };
}

describe('VisualFrame', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('loads the sandboxed shell without same-origin access', () => {
    const { iframe } = setup();
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
    expect(iframe.getAttribute('src')).toBe('/api/visuals/frame');
    expect(iframe.getAttribute('title')).toBe('Revenue');
    expect(screen.getByRole('status')).toHaveTextContent('com_ui_visual_loading');
  });

  it('answers the shell ready message once with the themed document', () => {
    const { postMessage, send } = setup();
    send(READY);
    send(READY);
    expect(postMessage).toHaveBeenCalledTimes(1);
    const [message, target] = postMessage.mock.calls[0] as [
      { method: string; params: { html: string } },
      string,
    ];
    expect(target).toBe('*');
    expect(message.method).toBe(VisualBridgeMethod.resourceReady);
    expect(message.params.html).toContain('librechat-visual-theme');
    expect(message.params.html).toContain('<p>chart</p>');
  });

  it('ignores messages from any other window', () => {
    const { postMessage, send } = setup();
    send(READY, window);
    send(READY, null);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('reveals the page at its reported height, clamped to the maximum', () => {
    const { iframe, send } = setup();
    send(READY);
    send({ jsonrpc: '2.0', method: VisualBridgeMethod.sizeChanged, params: { height: 412.2 } });
    expect(iframe.className).toContain('visible');
    expect(iframe.parentElement?.style.height).toBe('412px');
    expect(screen.queryByRole('status')).toBeNull();
    send({ jsonrpc: '2.0', method: VisualBridgeMethod.sizeChanged, params: { height: 99999 } });
    expect(iframe.parentElement?.style.height).toBe('2000px');
  });

  it('stops at its max height and still reports the full page height', () => {
    const onContentHeight = jest.fn();
    const view = render(
      <VisualFrame html={HTML} title="Revenue" maxHeight={640} onContentHeight={onContentHeight} />,
    );
    const iframe = view.container.querySelector('iframe') as HTMLIFrameElement;
    jest.spyOn(iframe.contentWindow as Window, 'postMessage').mockImplementation(() => undefined);
    act(() => {
      for (const data of [
        READY,
        { jsonrpc: '2.0', method: VisualBridgeMethod.sizeChanged, params: { height: 900 } },
      ]) {
        window.dispatchEvent(new MessageEvent('message', { data, source: iframe.contentWindow }));
      }
    });
    expect(iframe.parentElement?.style.height).toBe('640px');
    expect(onContentHeight).toHaveBeenCalledWith(900);
  });

  const setUserActivation = (isActive: boolean) =>
    Object.defineProperty(navigator, 'userActivation', {
      configurable: true,
      value: { isActive, hasBeenActive: isActive },
    });

  it('opens http(s) links the page asks for in a new tab after a user gesture', () => {
    setUserActivation(true);
    const open = jest.spyOn(window, 'open').mockImplementation(() => null);
    const { send } = setup();
    send({
      jsonrpc: '2.0',
      id: 'l1',
      method: VisualBridgeMethod.openLink,
      params: { url: 'https://example.com/' },
    });
    send({
      jsonrpc: '2.0',
      id: 'l2',
      method: VisualBridgeMethod.openLink,
      params: { url: 'javascript:x' },
    });
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('https://example.com/', '_blank', 'noopener,noreferrer');
    open.mockRestore();
  });

  it('ignores a link request the page sends without a user gesture', () => {
    setUserActivation(false);
    const open = jest.spyOn(window, 'open').mockImplementation(() => null);
    const { send } = setup();
    send({
      jsonrpc: '2.0',
      id: 'l1',
      method: VisualBridgeMethod.openLink,
      params: { url: 'https://example.com/' },
    });
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it('shows a retryable error when the shell loads without announcing itself', () => {
    const { iframe } = setup();
    fireEvent.load(iframe);
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(screen.getByRole('alert')).toHaveTextContent('com_ui_visual_load_error');
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('remounts the frame for an edited page of the same length', () => {
    const { iframe, rerender, container } = setup();
    const edited = HTML.replace('chart', 'graph');
    expect(edited).toHaveLength(HTML.length);
    rerender(<VisualFrame html={edited} title="Revenue" />);
    const next = container.querySelector('iframe') as HTMLIFrameElement;
    expect(next).not.toBe(iframe);
    const postMessage = jest
      .spyOn(next.contentWindow as Window, 'postMessage')
      .mockImplementation(() => undefined);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: READY,
          source: next.contentWindow,
        }),
      );
    });
    expect((postMessage.mock.calls[0][0] as { params: { html: string } }).params.html).toContain(
      '<p>graph</p>',
    );
  });

  it('writes the theme current at handshake time, not at mount', async () => {
    const { postMessage, send } = setup();
    await act(async () => {
      document.documentElement.classList.add('dark');
    });
    send(READY);
    const [message] = postMessage.mock.calls[0] as [{ params: { html: string } }];
    expect(message.params.html).toContain('color-scheme:dark');
    document.documentElement.classList.remove('dark');
  });

  it('reveals a page that never reports its size after a grace period', () => {
    const { iframe, send } = setup();
    send(READY);
    act(() => {
      jest.advanceTimersByTime(3000);
    });
    expect(iframe.className).toContain('visible');
  });
});
