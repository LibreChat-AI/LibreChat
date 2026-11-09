import type { NavLink } from '~/common';
import { resolveActivePanel } from '~/Providers/ActivePanelContext';
import { getRoutePanelLinks } from '../routePanels';

const links = [{ id: 'conversations' }, { id: 'memories' }, { id: 'prompts' }] as NavLink[];
const ids = (pathname: string) => getRoutePanelLinks(pathname, links).map((link) => link.id);

describe('getRoutePanelLinks', () => {
  it.each(['/agents', '/agents/', '/agents/finance'])('drops memories on %s', (pathname) => {
    expect(ids(pathname)).toEqual(['conversations', 'prompts']);
  });

  it.each(['/c/new', '/c/agents', '/agentsfoo', '/projects'])(
    'keeps memories on %s',
    (pathname) => {
      expect(getRoutePanelLinks(pathname, links)).toBe(links);
    },
  );

  it('falls back to chat history when memories was the selected panel', () => {
    expect(resolveActivePanel('memories', getRoutePanelLinks('/agents', links))).toBe(
      'conversations',
    );
  });
});
