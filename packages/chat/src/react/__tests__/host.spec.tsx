/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import type { MessagePartsHost } from '../host';
import { MessagePartsHostProvider, setDefaultMessagePartsHost, useMessagePartsHost } from '../host';

const createHost = (fontSize: string): MessagePartsHost => ({
  useMessage: () => ({ messageId: 'm1' }),
  useFontSize: () => fontSize,
  useShowThinking: () => false,
  useAutoExpandTools: () => false,
  useUserTextPreferences: () => ({
    usernameDisplay: false,
    enableUserMsgMarkdown: false,
    collapseLongUserMessages: false,
  }),
  useUser: () => undefined,
  useFileMap: () => undefined,
  useToast: () => jest.fn(),
  useSandboxStarting: () => false,
  useToolArtifactClaim: () => [null, jest.fn()],
  useSteerEscalating: () => false,
  usePaneConversationId: () => null,
  useLiveAppliedSteer: () => [false, jest.fn()],
});

function FontSize() {
  const { useFontSize } = useMessagePartsHost();
  return <p>{useFontSize()}</p>;
}

describe('message parts host', () => {
  it('requires a host when no provider or default supplies one', () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<FontSize />)).toThrow(/MessagePartsHostProvider/);
  });

  it('reads the registered default outside a provider, and the provider inside one', () => {
    setDefaultMessagePartsHost(createHost('text-default'));
    render(
      <>
        <FontSize />
        <MessagePartsHostProvider host={createHost('text-provided')}>
          <FontSize />
        </MessagePartsHostProvider>
      </>,
    );
    expect(screen.getByText('text-default')).toBeTruthy();
    expect(screen.getByText('text-provided')).toBeTruthy();
  });
});
