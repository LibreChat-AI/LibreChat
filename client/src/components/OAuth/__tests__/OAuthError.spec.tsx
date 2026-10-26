import React from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import OAuthError from '../OAuthError';

const mockAnnounce = jest.fn();

jest.mock('~/data-provider', () => ({
  announceOAuthSettled: (settlement: unknown) => mockAnnounce(settlement),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <OAuthError />
    </MemoryRouter>,
  );

describe('OAuthError', () => {
  beforeEach(() => mockAnnounce.mockReset());

  it('announces the failed sign-in with the flow it names', () => {
    renderAt('/oauth/error?error=callback_failed&flow=flow-a');
    expect(mockAnnounce).toHaveBeenCalledTimes(1);
    expect(mockAnnounce).toHaveBeenCalledWith({ outcome: 'failed', flowId: 'flow-a' });
  });

  it('announces a failure without a flow when the redirect names none', () => {
    renderAt('/oauth/error?error=invalid_state');
    expect(mockAnnounce).toHaveBeenCalledWith({ outcome: 'failed', flowId: undefined });
  });
});
