import { createContext, useMemo } from 'react';
import type { ProjectListResponse } from 'librechat-data-provider';
import type { InfiniteData } from '@tanstack/react-query';
import type { ReactNode } from 'react';

export const ProjectNamesContext = createContext<{
  names: ReadonlyMap<string, string>;
  isPending: boolean;
} | null>(null);

export default function ProjectNamesProvider({
  data,
  isPending,
  children,
}: {
  data?: InfiniteData<ProjectListResponse>;
  isPending: boolean;
  children: ReactNode;
}) {
  const names = useMemo(() => {
    const result = new Map<string, string>();
    for (const page of data?.pages ?? []) {
      for (const project of page.projects) {
        result.set(project._id, project.name);
      }
    }
    return result;
  }, [data]);
  const value = useMemo(() => ({ names, isPending }), [names, isPending]);
  return <ProjectNamesContext.Provider value={value}>{children}</ProjectNamesContext.Provider>;
}
