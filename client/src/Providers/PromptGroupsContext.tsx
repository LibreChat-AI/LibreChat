import React, { createContext, useContext, ReactNode, useCallback, useMemo, useState } from 'react';
import { PermissionTypes, Permissions } from 'librechat-data-provider';
import type { TPromptGroup } from 'librechat-data-provider';
import type { PromptOption } from '~/common';
import { usePromptGroupsNav, useHasAccess, useCatalogReady, activateCatalog } from '~/hooks';
import { useGetAllPromptGroups } from '~/data-provider';
import { CategoryIcon } from '~/components/Prompts';
import { mapPromptGroups } from '~/utils';

type AllPromptGroupsData =
  | {
      promptsMap: Record<string, TPromptGroup>;
      promptGroups: PromptOption[];
    }
  | undefined;

type PromptGroupsContextType =
  | (ReturnType<typeof usePromptGroupsNav> & {
      allPromptGroups: {
        data: AllPromptGroupsData;
        isLoading: boolean;
      };
      hasAccess: boolean;
      /** Opts the full prompt list query in; it stays idle until first requested. */
      requestAllPromptGroups: () => void;
    })
  | null;

const PromptGroupsContext = createContext<PromptGroupsContextType>(null);

export const PromptGroupsProvider = ({ children }: { children: ReactNode }) => {
  const hasAccess = useHasAccess({
    permissionType: PermissionTypes.PROMPTS,
    permission: Permissions.USE,
  });
  /** Prompt groups are a background-warmed catalog: the queries stay off the
   * startup path until warmup releases them (or a prompts UI activates them). */
  const promptsReady = useCatalogReady('prompts');
  const promptsEnabled = hasAccess && promptsReady;

  const promptGroupsNav = usePromptGroupsNav(promptsEnabled);

  /**
   * The full prompt list only serves the `/` command popover, so its query stays
   * idle until requested instead of racing the paginated sidebar query on startup.
   * Requesting it also releases the catalog, for a popover opened before warmup.
   */
  const [allPromptsActive, setAllPromptsActive] = useState(false);
  const requestAllPromptGroups = useCallback(() => {
    activateCatalog('prompts');
    setAllPromptsActive(true);
  }, []);

  const { data: allGroupsData, isLoading: isLoadingAll } = useGetAllPromptGroups(undefined, {
    enabled: promptsEnabled && allPromptsActive,
    select: (data) => {
      const mappedArray: PromptOption[] = data.map((group) => ({
        id: group._id ?? '',
        type: 'prompt',
        value: group.command ?? group.name,
        label: `${group.command != null && group.command ? `/${group.command} - ` : ''}${
          group.name
        }: ${
          (group.oneliner?.length ?? 0) > 0
            ? group.oneliner
            : (group.productionPrompt?.prompt ?? '')
        }`,
        icon: <CategoryIcon category={group.category ?? ''} className="h-5 w-5" />,
      }));

      const promptsMap = mapPromptGroups(data);

      return {
        promptsMap,
        promptGroups: mappedArray,
      };
    },
  });

  const contextValue = useMemo(
    () => ({
      ...promptGroupsNav,
      allPromptGroups: {
        data: hasAccess ? allGroupsData : undefined,
        /** A never-fetched disabled query reports `isLoading` in React Query v4 */
        isLoading: promptsEnabled && allPromptsActive ? isLoadingAll : false,
      },
      hasAccess,
      requestAllPromptGroups,
    }),
    [
      promptGroupsNav,
      allGroupsData,
      isLoadingAll,
      hasAccess,
      promptsEnabled,
      allPromptsActive,
      requestAllPromptGroups,
    ],
  );

  return (
    <PromptGroupsContext.Provider value={contextValue}>{children}</PromptGroupsContext.Provider>
  );
};

export const usePromptGroupsContext = () => {
  return useContext(PromptGroupsContext);
};
