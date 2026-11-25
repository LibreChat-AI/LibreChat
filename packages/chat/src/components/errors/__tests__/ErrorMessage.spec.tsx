/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { EModelEndpoint, ErrorTypes, ViolationTypes } from 'librechat-data-provider';
import type { Agent, TEndpointsConfig, TMessage } from 'librechat-data-provider';
import type { MessagePartsHost, SetKeyDialogProps } from '../../../react/host';
import type { ErrorEnvironment } from '../../../core/errors';
import { createMessagePartsHost } from '../../../__fixtures__/partsHost';
import ErrorMessage, { ERROR_CONNECTION_TEXT } from '../ErrorMessage';
import { MessagePartsHostProvider } from '../../../react/host';
import { initEnglish } from '../../../__fixtures__/i18n';
import ErrorText from '../ErrorText';

beforeAll(initEnglish);

const row = { messageId: 'reply-1', endpoint: 'openAI', model: 'gpt-x' } as TMessage;

const environment = (overrides: Partial<ErrorEnvironment> = {}): ErrorEnvironment => ({
  endpointsConfig: {
    openAI: { userProvide: true, userProvideURL: true },
    [EModelEndpoint.agents]: {},
  } as unknown as TEndpointsConfig,
  ...overrides,
});

function draw(node: React.ReactNode, host: Partial<MessagePartsHost> = {}) {
  return render(
    <MessagePartsHostProvider host={createMessagePartsHost(host)}>{node}</MessagePartsHostProvider>,
  );
}

const text = (payload: Record<string, unknown>) => JSON.stringify(payload);

describe('an error with no host members', () => {
  it('states a key failure in the generic sentence and offers no fix', () => {
    draw(<ErrorText text={text({ type: ErrorTypes.NO_USER_KEY })} message={row} />);

    expect(screen.getByText('An API key is required to send messages.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('never claims the reader can edit the agent', () => {
    const agent = { id: 'agent_1', provider: 'openAI', model: 'gpt-x', isEditable: true } as Agent;
    draw(
      <ErrorText
        text={text({ type: ErrorTypes.INVALID_AGENT_PROVIDER, info: 'openAI' })}
        message={{ endpoint: EModelEndpoint.agents, model: 'agent_1' }}
      />,
      {
        useErrorEnvironment: () =>
          environment({ agentsMap: { agent_1: agent }, savedAgents: { agent_1: agent } }),
      },
    );

    expect(
      screen.getByText('Ask an administrator to select an available provider for this agent.'),
    ).toBeInTheDocument();
  });

  it('shows a balance in credits', () => {
    draw(
      <ErrorText
        text={text({ type: ViolationTypes.TOKEN_BALANCE, balance: 1000, tokenCost: 2500 })}
      />,
    );

    expect(
      screen.getByText(
        'You do not have enough token credits for this request. It needs 2,500 credits and your balance is 1,000.',
      ),
    ).toBeInTheDocument();
  });

  it('draws the error alone in its alert', () => {
    draw(<ErrorMessage text={text({ type: ErrorTypes.MODERATION })} message={row} />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/./);
    expect(alert.querySelector('button')).toBeNull();
  });
});

describe('an error with the host members', () => {
  it('names the provider and opens the host key dialog with the endpoint’s fields', () => {
    const dialogs: SetKeyDialogProps[] = [];
    draw(<ErrorText text={text({ type: ErrorTypes.NO_USER_KEY })} message={row} />, {
      useErrorEnvironment: () => environment(),
      renderSetKeyDialog: (props) => {
        dialogs.push(props);
        return <div role="dialog">key dialog</div>;
      },
    });

    expect(screen.getByText('Add your own OpenAI API key to send messages.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button'));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(dialogs[dialogs.length - 1]).toMatchObject({
      open: true,
      endpoint: 'openAI',
      userProvideURL: true,
    });
  });

  it('offers no key button where the host draws no key dialog', () => {
    draw(<ErrorText text={text({ type: ErrorTypes.NO_USER_KEY })} message={row} />, {
      useErrorEnvironment: () => environment(),
    });

    expect(screen.getByText('Add your own OpenAI API key to send messages.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('sends the reader to the agent builder when the host says they may open it', () => {
    const agent = { id: 'agent_1', provider: 'openAI', model: 'gpt-x', isEditable: true } as Agent;
    draw(
      <ErrorText
        text={text({ type: ErrorTypes.INVALID_AGENT_PROVIDER, info: 'openAI' })}
        message={{ endpoint: EModelEndpoint.agents, model: 'agent_1' }}
      />,
      {
        useErrorEnvironment: () =>
          environment({ agentsMap: { agent_1: agent }, savedAgents: { agent_1: agent } }),
        useAgentBuilderAccess: () => ({ canUseBuilder: true, isAdmin: false }),
      },
    );

    expect(
      screen.getByText('Open the agent builder and select an available provider.'),
    ).toBeInTheDocument();
  });

  it('shows a balance in the host’s currency', () => {
    draw(
      <ErrorText
        text={text({
          type: ViolationTypes.TOKEN_BALANCE,
          balance: 1_000_000,
          tokenCost: 2_500_000,
        })}
      />,
      { useBalanceDisplay: () => ({ display: 'currency' }) },
    );

    expect(
      screen.getByText(
        'You do not have enough balance for this request. It costs $2.50 and your balance is $1.00.',
      ),
    ).toBeInTheDocument();
  });

  it('draws the host’s actions inside the alert, for the failed text and message', () => {
    const failure = text({ type: ErrorTypes.MODERATION });
    const renderErrorActions = jest.fn(() => <button type="button">Retry without files</button>);
    draw(<ErrorMessage text={failure} message={row} />, { renderErrorActions });

    expect(screen.getByRole('alert')).toContainElement(screen.getByRole('button'));
    expect(renderErrorActions).toHaveBeenCalledWith({ text: failure, messageId: 'reply-1' });
  });
});

describe('error text', () => {
  it('treats a payload typed with an inherited name as unexplained, not as a card', () => {
    draw(<ErrorText text={text({ type: 'constructor' })} />);

    expect(
      screen.getByText('This response failed and the provider did not report a reason.'),
    ).toBeInTheDocument();
  });

  it('opens a long provider detail on request', () => {
    const detail = 'line one\nline two of the provider body';
    draw(<ErrorText text={text({ type: ErrorTypes.GOOGLE_ERROR, info: detail })} />);

    const disclosure = screen.getByRole('button', { name: 'Provider response' });
    const panel = document.getElementById(disclosure.getAttribute('aria-controls') ?? '');
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    expect(panel).toHaveAttribute('data-expanded', 'false');
    expect(panel).toHaveClass('part-expand');

    fireEvent.click(disclosure);

    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    expect(panel).toHaveAttribute('data-expanded', 'true');
  });
});

describe('a turn that never reached the server', () => {
  it.each([
    [true, 'Error connecting to server, try refreshing the page.'],
    [false, "You're offline. Check your connection and try again."],
  ])('says so in the copy color, naming an offline browser (online: %s)', (online, copy) => {
    const onLine = jest.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(online);
    draw(<ErrorMessage text={ERROR_CONNECTION_TEXT} message={row} />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(copy);
    expect(alert).toHaveClass('text-text-secondary');
    expect(alert).not.toHaveClass('text-status-error');
    onLine.mockRestore();
  });
});
