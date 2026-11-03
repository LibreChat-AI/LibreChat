import { useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useToastContext } from '@librechat/client';
import { dataService } from 'librechat-data-provider';
import type { UIActionResult } from '@mcp-ui/client';
import type { TspiConfirmationAction, TspiOpenPatientAction } from '~/utils/tspi';
import {
  saveBlob,
  isTspiIntent,
  getTspiPdfReportId,
  getTspiOpenPatient,
  getTspiConfirmation,
  getAttachmentFilename,
} from '~/utils/tspi';
import { useOptionalMessagesOperations } from '~/Providers';
import { getResponseStatus } from '~/utils/errors';
import useLocalize from '~/hooks/useLocalize';
import { handleUIAction } from '~/utils';

type ErrorKey = 'com_ui_tspi_pdf_not_found' | 'com_ui_tspi_pdf_forbidden' | 'com_ui_tspi_pdf_error';

type ActionErrorKey =
  | 'com_ui_tspi_action_expired'
  | 'com_ui_tspi_action_done_already'
  | 'com_ui_tspi_action_forbidden'
  | 'com_ui_tspi_action_error';

const errorKey = (error: unknown): ErrorKey => {
  const status = getResponseStatus(error);
  if (status === 404 || status === 400) {
    return 'com_ui_tspi_pdf_not_found';
  }
  if (status === 403) {
    return 'com_ui_tspi_pdf_forbidden';
  }
  return 'com_ui_tspi_pdf_error';
};

const problemCode = (error: unknown): string | undefined => {
  const data = (error as { response?: { data?: { error?: unknown } } })?.response?.data;
  return typeof data?.error === 'string' ? data.error : undefined;
};

const actionErrorKey = (error: unknown): ActionErrorKey => {
  const code = problemCode(error);
  if (code === 'CONFIRMATION_EXPIRED') {
    return 'com_ui_tspi_action_expired';
  }
  if (code === 'CONFIRMATION_INVALID') {
    return 'com_ui_tspi_action_done_already';
  }
  const status = getResponseStatus(error);
  if (status === 403 || status === 404) {
    return 'com_ui_tspi_action_forbidden';
  }
  return 'com_ui_tspi_action_error';
};

/**
 * Handles actions from embedded MCP UI resources. TSPI's Download PDF, Open (a patient) and
 * Confirm / Cancel (a pending change) go straight to TspiChat's server, which calls the TSPI Brain;
 * the model never sees those clicks and cannot make them. Every other action is sent to the model.
 */
export function useMCPUIAction() {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { ask } = useOptionalMessagesOperations();
  const { conversationId } = useParams();
  const pending = useRef(new Set<string>());

  const once = useCallback(async (key: string, run: () => Promise<void>) => {
    if (pending.current.has(key)) {
      return;
    }
    pending.current.add(key);
    try {
      await run();
    } finally {
      pending.current.delete(key);
    }
  }, []);

  const downloadReport = useCallback(
    (reportId: string) =>
      once(`pdf:${reportId}`, async () => {
        showToast({ message: localize('com_ui_tspi_pdf_preparing'), status: 'info' });
        try {
          const response = await dataService.getTspiReportPdf(reportId);
          const filename = getAttachmentFilename(
            response.headers['content-disposition'],
            `TSPI_${reportId}.pdf`,
          );
          saveBlob(response.data, filename);
          showToast({ message: localize('com_ui_tspi_pdf_ready'), status: 'success' });
        } catch (error) {
          showToast({ message: localize(errorKey(error)), status: 'error' });
        }
      }),
    [localize, once, showToast],
  );

  const decide = useCallback(
    (action: TspiConfirmationAction, convoId: string) =>
      once(`confirm:${action.confirmationId}`, async () => {
        try {
          const result = await dataService.decideTspiConfirmation(action.confirmationId, {
            conversationId: convoId,
            decision: action.decision,
            payloadSha256: action.payloadSha256,
          });
          const confirmed = result.status === 'confirmed';
          showToast({
            message: localize(
              confirmed ? 'com_ui_tspi_action_confirmed' : 'com_ui_tspi_action_cancelled',
            ),
            status: confirmed ? 'success' : 'info',
          });
          ask({
            text: localize(
              confirmed ? 'com_ui_tspi_message_confirmed' : 'com_ui_tspi_message_cancelled',
              { 0: result.summary },
            ),
          });
        } catch (error) {
          showToast({ message: localize(actionErrorKey(error)), status: 'error' });
        }
      }),
    [ask, localize, once, showToast],
  );

  const openPatient = useCallback(
    (action: TspiOpenPatientAction, convoId: string) =>
      once(`open:${action.patientId}`, async () => {
        try {
          const context = await dataService.openTspiPatient({
            conversationId: convoId,
            patientId: action.patientId,
          });
          const number = context.patient?.patient_number ?? action.patientNumber ?? '';
          showToast({
            message: localize('com_ui_tspi_patient_opened', { 0: number }),
            status: 'success',
          });
          ask({ text: localize('com_ui_tspi_message_opened', { 0: number }) });
        } catch (error) {
          showToast({ message: localize(actionErrorKey(error)), status: 'error' });
        }
      }),
    [ask, localize, once, showToast],
  );

  return useCallback(
    async (result: UIActionResult) => {
      const reportId = getTspiPdfReportId(result);
      if (reportId) {
        return downloadReport(reportId);
      }
      if (!isTspiIntent(result)) {
        return handleUIAction(result, ask);
      }
      const convoId = conversationId && conversationId !== 'new' ? conversationId : undefined;
      const confirmation = getTspiConfirmation(result);
      if (convoId && confirmation) {
        return decide(confirmation, convoId);
      }
      const open = getTspiOpenPatient(result);
      if (convoId && open) {
        return openPatient(open, convoId);
      }
      showToast({ message: localize('com_ui_tspi_action_error'), status: 'error' });
    },
    [ask, conversationId, decide, downloadReport, localize, openPatient, showToast],
  );
}
