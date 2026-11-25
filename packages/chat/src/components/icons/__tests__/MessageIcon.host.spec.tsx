/** @jest-environment jsdom */
import { render, screen } from '@testing-library/react';
import { EModelEndpoint } from 'librechat-data-provider';
import type { TEndpointsConfig } from 'librechat-data-provider';
import type { MessageIconData, MessagesHost } from '../../../react/messages/host';
import type { MessagePartsHost, MessagePartsUser } from '../../../react/host';
import { MessageIconSlot, MessagesHostProvider } from '../../../react/messages/host';
import { createMessagePartsHost } from '../../../__fixtures__/partsHost';
import { createMessagesHost } from '../../../__fixtures__/messagesHost';
import { MessagePartsHostProvider } from '../../../react/host';
import { initEnglish } from '../../../__fixtures__/i18n';
import { renderMessageIcon } from '../MessageIcon';

beforeAll(initEnglish);

const reply: MessageIconData = {
  endpoint: EModelEndpoint.openAI,
  model: 'gpt-4o',
  modelLabel: 'GPT-4o',
  isCreatedByUser: false,
};

const prompt: MessageIconData = { ...reply, isCreatedByUser: true };

function draw(
  icon: React.ReactNode,
  messages: Partial<MessagesHost> = {},
  parts: Partial<MessagePartsHost> = {},
) {
  return render(
    <MessagesHostProvider host={createMessagesHost({ renderMessageIcon: undefined, ...messages })}>
      <MessagePartsHostProvider host={createMessagePartsHost(parts)}>
        {icon}
      </MessagePartsHostProvider>
    </MessagesHostProvider>,
  );
}

describe('MessageIconSlot', () => {
  it('draws the package’s icon when the host names none', () => {
    const { container } = draw(<MessageIconSlot iconData={reply} />);
    expect(container.firstElementChild).not.toBeNull();
    expect(container.querySelector('svg, img')).not.toBeNull();
  });

  it('draws the host’s icon when it names one', () => {
    draw(<MessageIconSlot iconData={reply} />, {
      renderMessageIcon: ({ iconData }) => <span data-testid="host-icon">{iconData?.model}</span>,
    });
    expect(screen.getByTestId('host-icon')).toHaveTextContent('gpt-4o');
  });

  it('is what renderMessageIcon draws', () => {
    const { container } = draw(renderMessageIcon({ iconData: reply }));
    expect(container.querySelector('svg, img')).not.toBeNull();
  });
});

describe('MessageIcon', () => {
  it('draws the image a deployment configured for the endpoint', () => {
    const config = {
      [EModelEndpoint.openAI]: { order: 0, iconURL: 'https://example.com/openai.png' },
    } as unknown as TEndpointsConfig;
    draw(<MessageIconSlot iconData={reply} />, { useEndpointsConfig: () => config });

    expect(screen.getByRole('img')).toHaveAttribute('src', 'https://example.com/openai.png');
  });

  it('draws the provider’s own icon without an endpoints config', () => {
    const { container } = draw(<MessageIconSlot iconData={reply} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('draws an image the message names by URL', () => {
    draw(<MessageIconSlot iconData={{ ...reply, iconURL: 'https://example.com/spec.png' }} />);
    expect(screen.getByRole('img')).toHaveAttribute('src', 'https://example.com/spec.png');
  });

  it('draws the agent’s avatar on an agent’s reply', () => {
    draw(
      <MessageIconSlot
        iconData={{ ...reply, endpoint: EModelEndpoint.agents }}
        agent={
          { id: 'agent_1', name: 'Researcher', avatar: { filepath: '/avatars/r.png' } } as never
        }
      />,
    );
    expect(screen.getByRole('img', { name: 'Researcher' })).toHaveAttribute(
      'src',
      '/avatars/r.png',
    );
  });

  describe('on a prompt', () => {
    const withUser = (user: MessagePartsUser) => ({ useUser: () => user });

    it('draws the signed-in user’s own avatar', () => {
      draw(
        <MessageIconSlot iconData={prompt} />,
        {},
        withUser({ id: 'u1', name: 'Dana', avatar: 'https://example.com/dana.png' }),
      );
      expect(screen.getByRole('img', { name: 'Avatar' })).toHaveAttribute(
        'src',
        'https://example.com/dana.png',
      );
      expect(screen.getByTitle('Dana')).toBeInTheDocument();
    });

    it('draws the user’s initials when they have no avatar of their own', () => {
      draw(<MessageIconSlot iconData={prompt} />, {}, withUser({ id: 'u2', name: 'Robin' }));
      expect(screen.getByRole('img', { name: 'Avatar' }).getAttribute('src')).toMatch(
        /^data:image\/svg\+xml/,
      );
    });

    it('draws a plain glyph where no one is signed in, as on a public share link', () => {
      const { container } = draw(<MessageIconSlot iconData={prompt} />, {}, withUser(undefined));
      expect(screen.queryByRole('img')).not.toBeInTheDocument();
      expect(container.querySelector('svg')).not.toBeNull();
    });
  });
});
