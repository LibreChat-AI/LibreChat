import '@testing-library/jest-dom/extend-expect';
import { useForm, FormProvider } from 'react-hook-form';
import { render, screen } from '@testing-library/react';
import type { TPlugin } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { ToolItem } from '../../items/types';
import type { AgentForm } from '~/common';
import ToolSection from '../sections/ToolSection';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useGetAgentsConfig: () => ({ agentsConfig: undefined }),
  useAgentCapabilities: () => ({ backgroundToolsEnabled: true }),
}));
jest.mock('librechat-data-provider/react-query', () => ({
  useUpdateUserPluginsMutation: () => ({ mutate: jest.fn(), isLoading: false }),
}));
jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useToastContext: () => ({ showToast: jest.fn() }),
}));
jest.mock('~/components/Plugins/Store/PluginAuthForm', () => ({
  __esModule: true,
  default: () => <div />,
}));

function toolItem(id: string): ToolItem {
  return {
    kind: 'tool',
    id,
    name: id,
    description: 'A tool',
    iconKey: 'tool',
    plugin: { pluginKey: id, name: id, authConfig: [] } as unknown as TPlugin,
  };
}

function renderSection(item: ToolItem) {
  function Wrapper({ children }: { children: ReactNode }) {
    const methods = useForm<AgentForm>({ defaultValues: {} as AgentForm });
    return <FormProvider {...methods}>{children}</FormProvider>;
  }

  return render(<ToolSection item={item} />, { wrapper: Wrapper });
}

describe('ToolSection background switch', () => {
  test('renders the switch for a background-eligible plugin tool', () => {
    renderSection(toolItem('wolfram'));
    expect(screen.getByTestId('tool-background')).toBeInTheDocument();
  });

  test('does not render the switch for image generation tools', () => {
    renderSection(toolItem('dalle'));
    expect(screen.queryByTestId('tool-background')).toBeNull();

    renderSection(toolItem('image_gen_oai'));
    expect(screen.queryByTestId('tool-background')).toBeNull();
  });
});
