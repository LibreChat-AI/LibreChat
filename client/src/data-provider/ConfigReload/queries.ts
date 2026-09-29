import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  dataService,
  QueryKeys,
  DEFAULT_CONFIG_RELOAD_CLIENT_POLL_MS,
} from 'librechat-data-provider';

/** A cheap revision probe runs only while an authenticated chat is visible. */
export function useModelCatalogRefresh(authenticated: boolean, userId?: string): void {
  const client = useQueryClient();
  const [target, setTarget] = useState<number | null>(null);
  const applied = useRef(0);
  const revision = useQuery(
    [QueryKeys.configRevision, userId],
    ({ signal }) => dataService.getConfigRevision(signal),
    {
      enabled: authenticated && !!userId,
      retry: false,
      refetchInterval: (data) =>
        data == null || data.distributed
          ? (data?.pollIntervalMs ?? DEFAULT_CONFIG_RELOAD_CLIENT_POLL_MS)
          : false,
    },
  );

  useEffect(() => {
    applied.current = 0;
    setTarget(null);
  }, [userId]);

  useEffect(() => {
    const next = revision.data?.generation;
    if (authenticated && next != null && next > 0) {
      setTarget((current) => Math.max(current ?? 0, next));
    }
  }, [authenticated, revision.data?.generation]);

  const models = useQuery(
    [QueryKeys.configRevision, userId, 'models', target],
    ({ signal }) => dataService.getModelsAtRevision(target!, signal),
    {
      enabled: authenticated && !!userId && target != null && target > applied.current,
      retry: false,
      refetchInterval: (data) =>
        data ? false : (revision.data?.pollIntervalMs ?? DEFAULT_CONFIG_RELOAD_CLIENT_POLL_MS),
    },
  );

  useEffect(() => {
    if (!authenticated || !userId || target == null || !models.data || target <= applied.current) {
      return;
    }
    applied.current = target;
    void client.cancelQueries([QueryKeys.models]).then(() => {
      if (applied.current === target) client.setQueryData([QueryKeys.models], models.data);
    });
  }, [authenticated, userId, target, models.data, client]);
}
