import type { UIActionResult } from '@mcp-ui/client';
import {
  isTspiIntent,
  getTspiPdfReportId,
  getTspiOpenPatient,
  getTspiConfirmation,
  getAttachmentFilename,
} from './tspi';

const REPORT_ID = '0f34c5c43a2a499598bef3a73e7aeb54';

describe('getTspiPdfReportId', () => {
  it('reads the report id from the Download PDF prompt', () => {
    const result: UIActionResult = {
      type: 'prompt',
      payload: { prompt: `Create and give me the PDF for report ${REPORT_ID}.` },
    };
    expect(getTspiPdfReportId(result)).toBe(REPORT_ID);
  });

  it('reads the report id from intent and tool actions', () => {
    expect(
      getTspiPdfReportId({
        type: 'intent',
        payload: { intent: 'download_pdf', params: { report_id: REPORT_ID } },
      }),
    ).toBe(REPORT_ID);
    expect(
      getTspiPdfReportId({
        type: 'tool',
        payload: { toolName: 'tspi_download_pdf', params: { reportId: REPORT_ID } },
      }),
    ).toBe(REPORT_ID);
  });

  it('leaves every other button to the model', () => {
    expect(
      getTspiPdfReportId({
        type: 'prompt',
        payload: { prompt: 'Generate the TSPI report for case TSPI-261008-0214-01' },
      }),
    ).toBeUndefined();
    expect(
      getTspiPdfReportId({
        type: 'prompt',
        payload: { prompt: `Approve report ${REPORT_ID} (confirmed with the Approve button)` },
      }),
    ).toBeUndefined();
    expect(
      getTspiPdfReportId({
        type: 'intent',
        payload: { intent: 'download_pdf', params: { report_id: '../../etc' } },
      }),
    ).toBeUndefined();
  });
});

describe('getAttachmentFilename', () => {
  it('uses the server file name when present', () => {
    expect(getAttachmentFilename('attachment; filename="TSPI_A_B_DRAFT.pdf"', 'x.pdf')).toBe(
      'TSPI_A_B_DRAFT.pdf',
    );
    expect(getAttachmentFilename(undefined, 'x.pdf')).toBe('x.pdf');
  });
});

describe('M04 click intents', () => {
  const SHA = 'ab'.repeat(32);
  const confirmIntent = (params: Record<string, unknown>): UIActionResult => ({
    type: 'intent',
    payload: { intent: 'tspi.confirmation', params },
  });

  it('recognizes Confirm and Cancel', () => {
    expect(
      getTspiConfirmation(
        confirmIntent({ confirmation_id: 'c-1', payload_sha256: SHA, decision: 'confirm' }),
      ),
    ).toEqual({ confirmationId: 'c-1', decision: 'confirm', payloadSha256: SHA });
    expect(
      getTspiConfirmation(
        confirmIntent({ confirmation_id: 'c-1', payload_sha256: SHA, decision: 'cancel' }),
      )?.decision,
    ).toBe('cancel');
  });

  it('ignores malformed or foreign confirmations', () => {
    expect(
      getTspiConfirmation(
        confirmIntent({ confirmation_id: 'c-1', payload_sha256: 'short', decision: 'confirm' }),
      ),
    ).toBeUndefined();
    expect(
      getTspiConfirmation(
        confirmIntent({ confirmation_id: 'c-1', payload_sha256: SHA, decision: 'approve' }),
      ),
    ).toBeUndefined();
    expect(
      getTspiConfirmation({
        type: 'prompt',
        payload: { prompt: 'I confirmed with the Confirm button' },
      }),
    ).toBeUndefined();
  });

  it('recognizes Open and keeps every tspi.* intent away from the model', () => {
    const open: UIActionResult = {
      type: 'intent',
      payload: {
        intent: 'tspi.open_patient',
        params: { patient_id: 'p-1', patient_number: 'C-1' },
      },
    };
    expect(getTspiOpenPatient(open)).toEqual({ patientId: 'p-1', patientNumber: 'C-1' });
    expect(isTspiIntent(open)).toBe(true);
    expect(isTspiIntent(confirmIntent({}))).toBe(true);
    expect(isTspiIntent({ type: 'intent', payload: { intent: 'download_pdf', params: {} } })).toBe(
      false,
    );
  });
});
