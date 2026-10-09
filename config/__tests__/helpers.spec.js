const { PassThrough } = require('stream');
const { askSilentQuestion } = require('../helpers');

describe('askSilentQuestion', () => {
  it('shows the prompt without echoing the answer', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let written = '';

    input.isTTY = true;
    output.isTTY = true;
    output.columns = 80;
    output.on('data', (chunk) => {
      written += chunk.toString();
    });

    const answerPromise = askSilentQuestion('Enter new password: ', input, output);
    input.write('visible-secret\n');

    await expect(answerPromise).resolves.toBe('visible-secret');
    expect(written).toBe('Enter new password: \n');
  });
});
