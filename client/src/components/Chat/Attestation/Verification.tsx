import { useMemo, useState } from 'react';
import { Dropdown } from '@librechat/client';
import { dataService } from 'librechat-data-provider';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { TNearAIReceipt, TNearAIVerificationReport } from 'librechat-data-provider';
import { combineReplyReports, hardwareVerifiedAt, replyReport, replyEnvironment } from './reports';
import { useGetStartupConfig } from '~/data-provider/Endpoints/queries';
import { reportQueryOptions } from './queries';
import { useLocalize } from '~/hooks';
import Viewer from './Viewer';

export default function Verification({
  endpoint,
  receipts,
  onClose,
}: {
  endpoint?: string | null;
  receipts: TNearAIReceipt[];
  onClose: () => void;
}) {
  const localize = useLocalize();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState(receipts[0].completionId);
  const receipt = receipts.find((item) => item.completionId === selected) ?? receipts[0];
  const reply = replyReport(receipt);
  const model = reply?.model ?? receipt.model;
  const { data: config } = useGetStartupConfig();
  const params = config?.nearaiEndpoints?.includes(endpoint ?? '')
    ? replyEnvironment(endpoint, receipt)
    : undefined;
  const options = reportQueryOptions(queryClient, params ?? { endpoint: endpoint ?? '', model });
  const query = useQuery({
    ...options,
    enabled: !!params,
  });
  const failureMessage = localize('com_ui_nearai_environment_unavailable');
  const environment = params ? query : undefined;
  const hardware =
    environment?.data?.enabled && !environment.isError ? environment.data.reports : undefined;
  let unavailableAt: number | undefined;
  if (environment?.isError) unavailableAt = environment.errorUpdatedAt;
  else if (environment?.data && !hardware?.length) unavailableAt = environment.dataUpdatedAt;
  const reports = useMemo<TNearAIVerificationReport[] | undefined>(() => {
    if (!reply) return;
    if (hardware?.length) return combineReplyReports(reply, hardware);
    if (unavailableAt == null) return [reply];
    return [
      reply,
      {
        schemaVersion: 1,
        kind: 'model',
        model,
        scope: 'unknown',
        status: 'unverifiable',
        verifiedAt: new Date(unavailableAt).toISOString(),
        error: { code: 'nearai_environment_unavailable', message: failureMessage },
      },
    ];
  }, [reply, hardware, unavailableAt, model, failureMessage]);
  return (
    <Viewer
      model={model}
      reports={reports}
      hardwareVerifiedAt={hardwareVerifiedAt(hardware)}
      receipt={receipt}
      onClose={onClose}
      pending={environment?.isLoading || environment?.isFetching}
      onVerify={
        environment && environment.data?.enabled !== false
          ? () => {
              if (!params) return;
              void queryClient
                .fetchQuery({
                  ...options,
                  staleTime: 0,
                  queryFn: ({ signal }) =>
                    dataService.getNearAIAttestation(
                      { ...params, reports: true, force: true },
                      signal,
                    ),
                })
                .catch(() => undefined);
            }
          : undefined
      }
      descriptionKey={
        environment ? 'com_ui_nearai_verification_response' : 'com_ui_nearai_verification_snapshot'
      }
    >
      {receipts.length > 1 && (
        <Dropdown
          label={localize('com_ui_nearai_signature_completion')}
          value={receipt.completionId}
          onChange={setSelected}
          options={receipts.map((item) => item.completionId)}
        />
      )}
    </Viewer>
  );
}
