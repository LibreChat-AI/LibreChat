import type { NavigationPage, NavigationConfig } from 'librechat-data-provider';

export const pageRegistry = {
  agentBuilder: { navId: 'agents', path: '/agent-builder' },
  skills: { navId: 'skills', path: '/skills' },
  prompts: { navId: 'prompts', path: '/prompts' },
  schedules: { navId: 'schedules', path: '/schedules' },
  memories: { navId: 'memories', path: '/memories' },
  bookmarks: { navId: 'bookmarks', path: '/bookmarks' },
  parameters: { navId: 'parameters', path: '/parameters' },
  mcpSettings: { navId: 'mcp-builder', path: '/mcp-settings' },
} as const satisfies Record<NavigationPage, { navId: string; path: string }>;

export function getPageForNavId(id: string): NavigationPage | undefined {
  return (Object.keys(pageRegistry) as NavigationPage[]).find(
    (page) => pageRegistry[page].navId === id,
  );
}

export function getPageForPath(pathname: string): NavigationPage | undefined {
  return (Object.keys(pageRegistry) as NavigationPage[]).find(
    (page) => pathname === pageRegistry[page].path,
  );
}

export function getPageSettings(
  navigation: NavigationConfig | undefined,
  page: NavigationPage,
): { enabled: boolean; defaultView: 'page' | 'panel' } {
  return (
    navigation?.pages?.[page] ?? {
      enabled: page === 'skills' || page === 'prompts',
      defaultView: 'panel',
    }
  );
}

/** Only internal chat destinations may be restored, never an external history entry. */
export function getChatReturnUrl(url?: string): string {
  return url != null && /^\/c\/[\w-]+(?:\?[^#]*)?(?:#.*)?$/.test(url) ? url : '/c/new';
}
