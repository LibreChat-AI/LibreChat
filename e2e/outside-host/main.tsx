import { createRoot } from 'react-dom/client';
import { OutsideConversation, OutsideProviders } from './host';
import { FIXTURES } from './fixtures';
import '@librechat/chat/standalone.css';

/** `?fixture=<name>` draws one of the recorded conversations; the page marks itself ready after. */
const name = new URLSearchParams(window.location.search).get('fixture') ?? 'prose';
const fixture = FIXTURES[name];
const root = document.getElementById('root') as HTMLElement;

createRoot(root).render(
  <OutsideProviders>
    {fixture == null ? (
      <p>Unknown fixture {name}</p>
    ) : (
      <OutsideConversation
        conversation={fixture.conversation}
        messages={fixture.messages as never}
      />
    )}
  </OutsideProviders>,
);
requestAnimationFrame(() => document.body.setAttribute('data-host-ready', ''));
