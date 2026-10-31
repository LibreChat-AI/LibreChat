import { getLangfuseTraceMessageFields } from './destinations';
import { withoutTraceRefs } from './trace';

describe('withoutTraceRefs', () => {
  it('replaces a copied trace record with an explicit unsampled one', () => {
    const copy = withoutTraceRefs({
      messageId: 'copy-1',
      text: 'Hi',
      langfuseSampled: true,
      langfuseDestinationIds: ['destination-a'],
      langfuseRunId: 'run-a',
    });

    expect(copy).toEqual({ messageId: 'copy-1', text: 'Hi', langfuseSampled: false });
  });

  it('marks a row that never carried a record as unsampled, so feedback never recomputes sampling', () => {
    const row: { messageId: string; langfuseSampled?: boolean } = { messageId: 'copy-2' };

    expect(withoutTraceRefs(row)).toEqual({ messageId: 'copy-2', langfuseSampled: false });
  });
});

it('drops original central-export permission when copying a trace reference', () => {
  expect(
    withoutTraceRefs({
      langfuseSampled: true,
      langfuseCentralTraceExportEnabled: true,
      langfuseDestinationIds: ['project'],
    }),
  ).not.toHaveProperty('langfuseCentralTraceExportEnabled');
});

it('captures the original central export decision with source trace fields', async () => {
  expect(
    await getLangfuseTraceMessageFields(undefined, 'source-trace', {
      centralTraceExportEnabled: false,
    }),
  ).toMatchObject({ langfuseCentralTraceExportEnabled: false });
});
