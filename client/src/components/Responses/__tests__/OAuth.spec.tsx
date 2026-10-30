import React from 'react';
import { request } from 'librechat-data-provider';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ResponseReviewView } from 'librechat-data-provider';
import OAuth from '../OAuth';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));

function prompt(kind = 'mcp', id = 'staging'): ResponseReviewView['oauth'][number] {
  const callback = `${window.location.origin}/api/${kind}/${id}/oauth/callback`;
  return {
    actionId: 'oauth-action',
    toolName: 'staging',
    expiresAt: Date.now() + 60_000,
    authURL: `https://provider.example/authorize?redirect_uri=${encodeURIComponent(callback)}`,
  };
}
const button = () => screen.getByRole('button', { name: 'com_ui_response_review_authorize' });
let post: jest.SpyInstance;
let click: jest.SpyInstance;
beforeEach(() => {
  post = jest.spyOn(request, 'post').mockResolvedValue({ success: true });
  click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

it.each([
  ['mcp', 'staging', '/api/mcp/staging/oauth/bind'],
  ['actions', 'action-id', '/api/actions/action-id/oauth/bind'],
])(
  'binds the trusted %s callback before enabling and opening the exact URL',
  async (kind, id, endpoint) => {
    const value = prompt(kind, id);
    render(<OAuth prompt={value} />);
    expect(button()).toBeDisabled();
    expect(button()).toHaveAttribute('aria-busy', 'true');
    expect(click).not.toHaveBeenCalled();
    await waitFor(() => expect(button()).toBeEnabled());
    expect(post).toHaveBeenCalledWith(endpoint);
    await act(async () => {
      fireEvent.click(button());
    });
    expect(click).toHaveBeenCalledTimes(1);
    const link: HTMLAnchorElement = click.mock.instances[0];
    expect(link.href).toBe(value.authURL);
    expect(link.rel).toBe('noopener noreferrer');
    expect(link.target).toBe('_blank');
    expect(post).toHaveBeenCalledTimes(2);
  },
);

it('cannot open before the asynchronous binding finishes', async () => {
  let finish: (value: { success: boolean }) => void = () => {};
  post.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<OAuth prompt={prompt()} />);
  fireEvent.click(button());
  expect(click).not.toHaveBeenCalled();
  await act(async () => finish({ success: true }));
  expect(button()).toBeEnabled();
});

it('retries a failed binding without opening the URL or exposing diagnostics', async () => {
  post.mockRejectedValueOnce(new Error('private provider token'));
  render(<OAuth prompt={prompt()} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('com_ui_response_review_oauth_error');
  expect(document.body.textContent).not.toContain('private provider token');
  fireEvent.click(button());
  expect(click).not.toHaveBeenCalled();
  await waitFor(() => expect(button()).toBeEnabled());
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  await act(async () => {
    fireEvent.click(button());
  });
  expect(click).toHaveBeenCalledTimes(1);
});

it('fails closed when a bind acknowledgement does not confirm success', async () => {
  post.mockResolvedValue({ success: false });
  render(<OAuth prompt={prompt()} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('com_ui_response_review_oauth_error');
  await act(async () => {
    fireEvent.click(button());
  });
  expect(click).not.toHaveBeenCalled();
});

it.each([
  'https://provider.example/authorize',
  `https://provider.example/authorize?redirect_uri=${encodeURIComponent('https://untrusted.example/api/mcp/staging/oauth/callback')}`,
  `https://provider.example/authorize?redirect_uri=${encodeURIComponent(`${window.location.origin}/api/unknown/staging/oauth/callback`)}`,
  `javascript:alert(1)?redirect_uri=${encodeURIComponent(`${window.location.origin}/api/mcp/staging/oauth/callback`)}`,
])('does not bind or expose an unrecognized authorization callback', (authURL) => {
  render(<OAuth prompt={{ ...prompt(), authURL }} />);
  expect(screen.getByRole('alert')).toHaveTextContent('com_ui_response_review_oauth_unavailable');
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(post).not.toHaveBeenCalled();
  expect(click).not.toHaveBeenCalled();
});

it('removes authorization at expiry without relying on the next owner poll', async () => {
  jest.useFakeTimers();
  try {
    render(<OAuth prompt={{ ...prompt(), expiresAt: Date.now() + 1000 }} />);
    await act(async () => {});
    expect(button()).toBeEnabled();
    act(() => jest.advanceTimersByTime(1001));
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('com_ui_response_review_oauth_expired');
    expect(click).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});

it('rebinds after scope changes and ignores the previous owner completion', async () => {
  let finishOld: (value: { success: boolean }) => void = () => {};
  let finishNew: (value: { success: boolean }) => void = () => {};
  post
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishNew = resolve;
        }),
    );
  const value = prompt();
  const view = render(<OAuth key="owner-a:tenant-a:action" prompt={value} />);
  view.rerender(<OAuth key="owner-b:tenant-b:action" prompt={value} />);
  await act(async () => finishOld({ success: true }));
  expect(button()).toBeDisabled();
  await act(async () => finishNew({ success: true }));
  expect(button()).toBeEnabled();
  expect(post).toHaveBeenCalledTimes(2);
});
