import { request } from 'librechat-data-provider';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import type { TNearAIAttestationResponse } from 'librechat-data-provider';
import { viewerUrl } from 'test/fixtures/nearai';

export function reportRequests() {
  return jest.mocked(request.get).mock.calls.filter(([url]) => String(url).includes('reports=1'));
}

export function deferReports(parameter = 'reports=1') {
  const result = Promise.withResolvers<TNearAIAttestationResponse>();
  const original = jest.mocked(request.get).getMockImplementation()!;
  jest
    .mocked(request.get)
    .mockImplementation((url, ...args) =>
      String(url).includes(parameter) ? result.promise : original(url, ...args),
    );
  return result;
}

export function receive(iframe: HTMLIFrameElement, type: string, requestId = 'request-1') {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: new URL(viewerUrl).origin,
        source: iframe.contentWindow,
        data: { type, version: 1, requestId },
      }),
    );
  });
}

export async function closeDialog() {
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
}
