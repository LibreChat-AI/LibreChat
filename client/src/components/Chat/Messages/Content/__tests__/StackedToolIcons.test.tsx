import { render } from '@testing-library/react';
import { Constants } from 'librechat-data-provider';
import StackedToolIcons from '../ToolOutput/StackedToolIcons';

jest.mock('~/hooks/MCP', () => ({
  useMCPServerNames: () => ['weather_station'],
}));

describe('the app’s stacked tool icons', () => {
  it('resolves an MCP tool’s server from the names the app has configured', () => {
    /** The tool key alone does not say where the server name starts: it has an underscore too. */
    const { container } = render(
      <StackedToolIcons
        toolNames={[`get_forecast${Constants.mcp_delimiter}weather_station`]}
        mcpIconMap={new Map([['weather_station', 'https://example.com/weather.svg']])}
      />,
    );
    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      'https://example.com/weather.svg',
    );
  });
});
