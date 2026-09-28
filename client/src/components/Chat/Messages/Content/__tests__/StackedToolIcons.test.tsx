import { Constants } from 'librechat-data-provider';
import { render, screen } from '@testing-library/react';
import StackedToolIcons from '../ToolOutput/StackedToolIcons';

jest.mock('~/hooks/MCP', () => ({
  useMCPServerNames: () => ['weather'],
}));

describe('shared header glyphs', () => {
  it('keeps MCP identity alongside a subagent and owned search sites', () => {
    const { container } = render(
      <StackedToolIcons
        toolNames={[
          `forecast${Constants.mcp_delimiter}weather`,
          `conditions${Constants.mcp_delimiter}weather`,
          String(Constants.SUBAGENT),
          'web_search',
        ]}
        mcpIconMap={new Map([['weather', 'https://example.com/weather.svg']])}
        sourceDomains={['source.example']}
        maxIcons={4}
      />,
    );
    const images = Array.from(container.querySelectorAll('img'));
    expect(images).toHaveLength(2);
    expect(images[0]).toHaveAttribute('src', 'https://example.com/weather.svg');
    expect(images[1]).toHaveAttribute('alt', 'source.example');
    expect(container.querySelector('.lucide-users')).not.toBeNull();
    expect(container.querySelector('.lucide-globe')).toBeNull();
  });

  it.each(['failed', 'cancelled'] as const)(
    'lets %s replace identity without animating',
    (status) => {
      const { container } = render(
        <StackedToolIcons
          toolNames={['web_search']}
          sourceDomains={['source.example']}
          status={status}
          isAnimating
        />,
      );
      expect(container.querySelector('img')).toBeNull();
      expect(container.querySelector('.animate-pulse')).toBeNull();
      expect(
        container.querySelector(status === 'failed' ? '.lucide-triangle-alert' : '.lucide-x'),
      ).not.toBeNull();
    },
  );

  it('retains a bounded stack and overflow count', () => {
    const { container } = render(
      <StackedToolIcons
        toolNames={['web_search', 'read_file']}
        sourceDomains={['one.example', 'two.example']}
        maxIcons={2}
      />,
    );
    expect(container.querySelectorAll('img')).toHaveLength(2);
    expect(screen.getByText('+1')).toBeInTheDocument();
  });
});
