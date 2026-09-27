import React from 'react';
import { render, screen } from '@testing-library/react';
import OutputRenderer, { isError } from '../OutputRenderer';

jest.mock('copy-to-clipboard', () => jest.fn());

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/components/Messages/Content/CopyButton', () => ({
  __esModule: true,
  default: () => <button type="button" data-testid="copy-output" />,
}));

describe('OutputRenderer', () => {
  it('vertically centers the copy control beside the output', () => {
    render(<OutputRenderer text={'First line\nSecond line'} />);

    const copyPositioner = screen.getByTestId('copy-output').parentElement;
    expect(copyPositioner).toHaveClass('absolute', 'right-0', 'top-1/2', '-translate-y-1/2');
    expect(copyPositioner?.parentElement).toHaveClass('relative', 'pr-10');
  });

  it('does not treat text between bracketed prefixes as a tool-call error', () => {
    expect(isError('Error: [agent] unexpected [search] tool call failed: unavailable')).toBe(false);
  });

  /** The server's `completedToolExecutionStatus` counts this shape as a
   *  failure while the run step stays `completed`; the card must agree with
   *  the label the server wrote for the same call. */
  it('treats schema-validation feedback as a failed call', () => {
    expect(
      isError(
        'Error: Tool "slow_echo" input failed schema validation. Missing required fields: text.' +
          "Use this tool's declared arguments.\n Please fix your mistakes.",
      ),
    ).toBe(true);
    expect(isError('Error: something went wrong, then it recovered')).toBe(false);
  });
});
