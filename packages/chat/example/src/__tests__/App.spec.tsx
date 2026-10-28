/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ThemeProvider, clickHouseTheme } from '@librechat/client';
import { createMemoryTransport } from '../transport';
import { App } from '../App';
import '../i18n';

const type = (element: HTMLElement, value: string) =>
  fireEvent.change(element, { target: { value } });
const pressEnter = (element: HTMLElement) => fireEvent.keyDown(element, { key: 'Enter' });

const renderExample = () =>
  render(
    <ThemeProvider themeDefinition={clickHouseTheme} persistThemeDefinition={false}>
      <App transport={createMemoryTransport((text) => `Echo: ${text}`)} />
    </ThemeProvider>,
  );

describe('example consumer', () => {
  it('sends a turn through the substitute transport and renders both messages', async () => {
    renderExample();

    type(await screen.findByLabelText('Message'), 'Hello there');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    const reply = await screen.findByRole('listitem', { name: 'Assistant' });
    expect(within(reply).getByText('Echo: Hello there')).toBeInTheDocument();
    const turn = screen.getByRole('listitem', { name: 'You' });
    expect(within(turn).getByText('Hello there')).toBeInTheDocument();
    expect(screen.getByLabelText('Message')).toHaveValue('');
  });

  it('submits on Enter and keeps every turn in order', async () => {
    renderExample();

    const composer = await screen.findByLabelText('Message');
    type(composer, 'one');
    pressEnter(composer);
    await screen.findByText('Echo: one');
    type(composer, 'two');
    pressEnter(composer);
    await screen.findByText('Echo: two');

    const items = within(screen.getByRole('list', { name: 'Messages' })).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'Youone',
      'AssistantEcho: one',
      'Youtwo',
      'AssistantEcho: two',
    ]);
  });

  it('sends nothing for blank input or for Enter that confirms an IME composition', async () => {
    renderExample();

    const composer = await screen.findByLabelText('Message');
    type(composer, '   ');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    pressEnter(composer);
    type(composer, '日本');
    fireEvent.keyDown(composer, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(composer, { key: 'Enter', keyCode: 229 });

    expect(composer).toHaveValue('日本');
    expect(
      within(screen.getByRole('list', { name: 'Messages' })).queryAllByRole('listitem'),
    ).toEqual([]);
  });

  it('reports a failed turn and gives the text back to retry', async () => {
    const transport = createMemoryTransport();
    transport.sendMessages = () => Promise.reject(new Error('offline'));
    render(<App transport={transport} />);

    const composer = await screen.findByLabelText('Message');
    type(composer, 'Hello');
    pressEnter(composer);

    expect(await screen.findByRole('alert')).toHaveTextContent('offline');
    expect(composer).toHaveValue('Hello');
  });

  it('renders under the ClickHouse reference theme', async () => {
    renderExample();
    await screen.findByLabelText('Message');
    expect(document.documentElement.style.getPropertyValue('--theme-mono-font-family')).toContain(
      'Inconsolata',
    );
  });
});
