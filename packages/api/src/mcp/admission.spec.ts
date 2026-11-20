import { reuseMCPAdmission } from './admission';

describe('reuseMCPAdmission', () => {
  it('skips the check when the domain was already admitted', async () => {
    const check = jest.fn(async () => false);
    await expect(reuseMCPAdmission(true, check)).resolves.toBe(true);
    expect(check).not.toHaveBeenCalled();
  });

  it.each([undefined, false])(
    'runs the check and returns its verdict when admitted is %s',
    async (admitted) => {
      await expect(reuseMCPAdmission(admitted, async () => false)).resolves.toBe(false);
      await expect(reuseMCPAdmission(admitted, async () => true)).resolves.toBe(true);
    },
  );

  it('propagates a rejected check', async () => {
    await expect(
      reuseMCPAdmission(undefined, async () => {
        throw new Error('dns failure');
      }),
    ).rejects.toThrow('dns failure');
  });
});
