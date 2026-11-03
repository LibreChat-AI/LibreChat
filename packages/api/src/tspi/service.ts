import type { TspiReportFile } from './types';
import type { TspiBrainClient, TspiBrainMe } from './brainClient';
import {
  TspiReportError,
  isValidReportId,
  parsePlanRecord,
  parseViewer,
  reportFileName,
} from './report';
import { TspiBrainError } from './brainClient';
import { renderReportPdf } from './pdf';

export type TspiReportSource = Pick<TspiBrainClient, 'getReport' | 'getMe'>;

const toReportError = (error: unknown): TspiReportError => {
  if (error instanceof TspiReportError) {
    return error;
  }
  if (error instanceof TspiBrainError) {
    const code =
      error.code === 'not_found' || error.code === 'forbidden'
        ? error.code
        : error.code === 'invalid'
          ? 'invalid_id'
          : 'unavailable';
    return new TspiReportError(code, error.message);
  }
  return new TspiReportError('unavailable', 'TSPI Brain request failed');
};

/**
 * Builds the treatment-plan PDF for one report straight from the TSPI Brain REST API (M04), with
 * the signed-in user's aud=tspi-api token: no model and no MCP tool. The Brain authorizes the read,
 * so a report the user cannot open surfaces here as `forbidden` or `not_found`.
 */
export const createTspiReportPdf = async (
  reportId: string,
  brain: TspiReportSource,
): Promise<TspiReportFile> => {
  if (!isValidReportId(reportId)) {
    throw new TspiReportError('invalid_id', 'Invalid report id');
  }
  try {
    const [report, me] = await Promise.all([
      brain.getReport(reportId),
      brain.getMe().catch((): TspiBrainMe => ({})),
    ]);
    const plan = parsePlanRecord(JSON.stringify(report));
    const viewer = parseViewer(JSON.stringify(me));
    const buffer = await renderReportPdf(plan, viewer);
    return { filename: reportFileName(plan), buffer };
  } catch (error) {
    throw toReportError(error);
  }
};
