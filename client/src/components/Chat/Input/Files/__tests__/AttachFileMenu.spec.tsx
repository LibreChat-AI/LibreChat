import React from 'react';
import { RecoilRoot } from 'recoil';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EModelEndpoint, EToolResources, Providers } from 'librechat-data-provider';
import AttachFileMenu from '../AttachFileMenu';

jest.mock('~/hooks', () => ({
  useAgentToolPermissions: jest.fn(),
  useAgentCapabilities: jest.fn(),
  useGetAgentsConfig: jest.fn(),
  useFileHandlingNoChatContext: jest.fn(),
  useLocalize: jest.fn(),
}));

jest.mock('~/hooks/Files/useSharePointFileHandling', () => ({
  __esModule: true,
  default: jest.fn(),
  useSharePointFileHandlingNoChatContext: jest.fn(),
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: jest.fn(),
}));

jest.mock('~/components/SharePoint', () => ({
  SharePointPickerDialog: () => null,
}));

jest.mock('@librechat/client', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react');
  return {
    FileUpload: R.forwardRef((props, ref) =>
      R.createElement(
        'div',
        { 'data-testid': 'file-upload' },
        props.children,
        R.createElement('input', {
          ref,
          multiple: true,
          type: 'file',
          'data-testid': 'file-input',
          onChange: props.handleFileChange,
        }),
      ),
    ),
    TooltipAnchor: (props) => props.render,
    /* Mirrors the real primitive closely enough for these assertions: it applies
     * `label` as the accessible name, which is how the trigger is queried. */
    IconButton: R.forwardRef((props, ref) => {
      const { label, size: _size, shape: _shape, variant: _variant, children, ...rest } = props;
      return R.createElement('button', { ref, 'aria-label': label, ...rest }, children);
    }),
    DropdownPopup: (props) =>
      R.createElement(
        'div',
        {
          'data-testid': 'dropdown-popup',
          'data-modal': props.modal,
          'data-portal': props.portal,
        },
        R.createElement('div', { onClick: () => props.setIsOpen(!props.isOpen) }, props.trigger),
        props.isOpen &&
          R.createElement(
            'div',
            { 'data-testid': 'dropdown-menu' },
            props.items.map((item, idx) =>
              R.createElement(
                'button',
                { key: idx, onClick: item.onClick, 'data-testid': `menu-item-${idx}` },
                item.label,
              ),
            ),
          ),
      ),
    AttachmentIcon: () => R.createElement('span', { 'data-testid': 'attachment-icon' }),
    SharePointIcon: () => R.createElement('span', { 'data-testid': 'sharepoint-icon' }),
    useToastContext: () => ({ showToast: jest.fn() }),
  };
});

jest.mock('@ariakit/react', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react');
  return {
    MenuButton: (props) => R.createElement('button', props, props.children),
  };
});

const mockUseAgentToolPermissions = jest.requireMock('~/hooks').useAgentToolPermissions;
const mockUseAgentCapabilities = jest.requireMock('~/hooks').useAgentCapabilities;
const mockUseGetAgentsConfig = jest.requireMock('~/hooks').useGetAgentsConfig;
const mockUseFileHandlingNoChatContext = jest.requireMock('~/hooks').useFileHandlingNoChatContext;
const mockUseLocalize = jest.requireMock('~/hooks').useLocalize;
const mockUseSharePointFileHandling = jest.requireMock(
  '~/hooks/Files/useSharePointFileHandling',
).default;
const mockUseSharePointFileHandlingNoChatContext = jest.requireMock(
  '~/hooks/Files/useSharePointFileHandling',
).useSharePointFileHandlingNoChatContext;
const mockUseGetStartupConfig = jest.requireMock('~/data-provider').useGetStartupConfig;

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function setupMocks(overrides: { provider?: string } = {}) {
  const translations: Record<string, string> = {
    com_files_upload_local_machine: 'From Local Computer',
    com_files_upload_sharepoint: 'Upload from SharePoint',
    com_sidepanel_attach_files: 'Attach Files',
    com_ui_upload_code_environment: 'Upload to Code Environment',
    com_ui_upload_file_search: 'Upload for File Search',
    com_ui_upload_image_input: 'Upload Image',
    com_ui_upload_ocr_text: 'Upload as Text',
    com_ui_upload_provider: 'Upload to Provider',
  };
  mockUseLocalize.mockReturnValue((key: string) => translations[key] || key);
  mockUseAgentCapabilities.mockReturnValue({
    contextEnabled: false,
    fileSearchEnabled: false,
    codeEnabled: false,
  });
  mockUseGetAgentsConfig.mockReturnValue({ agentsConfig: {} });
  mockUseFileHandlingNoChatContext.mockReturnValue({ handleFileChange: jest.fn() });
  const sharePointReturnValue = {
    handleSharePointFiles: jest.fn(),
    isProcessing: false,
    downloadProgress: 0,
    error: null,
  };
  mockUseSharePointFileHandling.mockReturnValue(sharePointReturnValue);
  mockUseSharePointFileHandlingNoChatContext.mockReturnValue(sharePointReturnValue);
  mockUseGetStartupConfig.mockReturnValue({ data: { sharePointFilePickerEnabled: false } });
  mockUseAgentToolPermissions.mockReturnValue({
    fileSearchAllowedByAgent: false,
    codeAllowedByAgent: false,
    provider: overrides.provider ?? undefined,
  });
}

function renderMenu(props: Record<string, unknown> = {}) {
  return render(
    <QueryClientProvider client={queryClient}>
      <RecoilRoot>
        <AttachFileMenu
          conversationId="test-convo"
          files={new Map()}
          setFiles={() => {}}
          setFilesLoading={() => {}}
          conversation={null}
          isUnifiedMode={false}
          {...props}
        />
      </RecoilRoot>
    </QueryClientProvider>,
  );
}

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: /attach file options/i }));
}

describe('AttachFileMenu', () => {
  beforeEach(jest.clearAllMocks);

  describe('unified mode upload sources', () => {
    it('uses a single upload button when SharePoint is disabled', () => {
      setupMocks();
      renderMenu({ isUnifiedMode: true });

      expect(screen.getByRole('button', { name: /attach files/i })).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /attach file options/i }),
      ).not.toBeInTheDocument();
    });

    it('offers SharePoint alongside local upload when SharePoint is enabled', () => {
      setupMocks();
      mockUseGetStartupConfig.mockReturnValue({ data: { sharePointFilePickerEnabled: true } });
      renderMenu({ isUnifiedMode: true });

      openMenu();

      expect(screen.getByText('From Local Computer')).toBeInTheDocument();
      expect(screen.getByText('Upload from SharePoint')).toBeInTheDocument();
    });

    it('does not offer a destination choice on either source', () => {
      setupMocks();
      mockUseAgentCapabilities.mockReturnValue({
        contextEnabled: true,
        fileSearchEnabled: true,
        codeEnabled: true,
      });
      mockUseAgentToolPermissions.mockReturnValue({
        fileSearchAllowedByAgent: true,
        codeAllowedByAgent: true,
        provider: undefined,
      });
      mockUseGetStartupConfig.mockReturnValue({ data: { sharePointFilePickerEnabled: true } });
      renderMenu({ isUnifiedMode: true });

      openMenu();

      expect(screen.queryByText('Upload to Code Environment')).not.toBeInTheDocument();
      expect(screen.queryByText('Upload for File Search')).not.toBeInTheDocument();
      expect(screen.queryByText('Upload as Text')).not.toBeInTheDocument();
    });
  });

  describe('Upload to Provider picker filter', () => {
    /** `accept` is reset right after `click()`, so capture it at click time. */
    const captureAcceptOnClick = () => {
      const seen: string[] = [];
      const spy = jest.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
        this: HTMLInputElement,
      ) {
        seen.push(this.accept);
      });
      return { seen, spy };
    };

    it('keeps images and PDFs only for a custom endpoint with the inherited default config', () => {
      const { seen, spy } = captureAcceptOnClick();
      setupMocks({ provider: 'MyGateway' });
      renderMenu({ endpointType: EModelEndpoint.custom, endpointFileConfig: {} });
      openMenu();
      fireEvent.click(screen.getByText('Upload to Provider'));
      expect(seen).toEqual(['image/*,.heif,.heic,.pdf,application/pdf']);
      spy.mockRestore();
    });

    it('adds video when a custom endpoint config explicitly allows it', () => {
      const { seen, spy } = captureAcceptOnClick();
      setupMocks({ provider: 'MyGateway' });
      renderMenu({
        endpointType: EModelEndpoint.custom,
        endpointFileConfig: {
          supportedMimeTypes: [/^image\/.*$/, /^application\/pdf$/, /^video\/.*$/],
        },
      });
      openMenu();
      fireEvent.click(screen.getByText('Upload to Provider'));
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain('video/*');
      expect(seen[0]).not.toContain('audio/*');
      spy.mockRestore();
    });
  });

  describe('Upload to Provider vs Upload Image', () => {
    it('shows "Upload to Provider" when endpointType is custom (resolved from agent provider)', () => {
      setupMocks({ provider: 'Moonshot' });
      renderMenu({ endpointType: EModelEndpoint.custom });
      openMenu();
      expect(screen.getByText('Upload to Provider')).toBeInTheDocument();
      expect(screen.queryByText('Upload Image')).not.toBeInTheDocument();
    });

    it('shows "Upload to Provider" when endpointType is openAI', () => {
      setupMocks({ provider: EModelEndpoint.openAI });
      renderMenu({ endpointType: EModelEndpoint.openAI });
      openMenu();
      expect(screen.getByText('Upload to Provider')).toBeInTheDocument();
    });

    it('shows "Upload to Provider" when endpointType is anthropic', () => {
      setupMocks({ provider: EModelEndpoint.anthropic });
      renderMenu({ endpointType: EModelEndpoint.anthropic });
      openMenu();
      expect(screen.getByText('Upload to Provider')).toBeInTheDocument();
    });

    it('shows "Upload to Provider" when endpointType is google', () => {
      setupMocks({ provider: Providers.GOOGLE });
      renderMenu({ endpointType: EModelEndpoint.google });
      openMenu();
      expect(screen.getByText('Upload to Provider')).toBeInTheDocument();
    });

    it('shows "Upload Image" when endpointType is agents (no provider resolution)', () => {
      setupMocks();
      renderMenu({ endpointType: EModelEndpoint.agents });
      openMenu();
      expect(screen.getByText('Upload Image')).toBeInTheDocument();
      expect(screen.queryByText('Upload to Provider')).not.toBeInTheDocument();
    });

    it('shows "Upload Image" when neither endpointType nor provider supports documents', () => {
      setupMocks({ provider: 'unknown-provider' });
      renderMenu({ endpointType: 'unknown-type' });
      openMenu();
      expect(screen.getByText('Upload Image')).toBeInTheDocument();
    });

    it('shows "Upload to Provider" for azureOpenAI with useResponsesApi', () => {
      setupMocks({ provider: EModelEndpoint.azureOpenAI });
      renderMenu({ endpointType: EModelEndpoint.azureOpenAI, useResponsesApi: true });
      openMenu();
      expect(screen.getByText('Upload to Provider')).toBeInTheDocument();
    });

    it('shows "Upload to Provider" for azureOpenAI endpointType with useResponsesApi', () => {
      setupMocks();
      renderMenu({
        endpoint: EModelEndpoint.agents,
        endpointType: EModelEndpoint.azureOpenAI,
        useResponsesApi: true,
      });
      openMenu();
      expect(screen.getByText('Upload to Provider')).toBeInTheDocument();
    });

    it('shows "Upload Image" for azureOpenAI without useResponsesApi', () => {
      setupMocks({ provider: EModelEndpoint.azureOpenAI });
      renderMenu({ endpointType: EModelEndpoint.azureOpenAI, useResponsesApi: false });
      openMenu();
      expect(screen.getByText('Upload Image')).toBeInTheDocument();
    });
  });

  describe('agent provider resolution scenario', () => {
    it('shows "Upload to Provider" when agents endpoint has custom endpointType from provider', () => {
      setupMocks({ provider: 'Moonshot' });
      renderMenu({
        endpoint: EModelEndpoint.agents,
        endpointType: EModelEndpoint.custom,
      });
      openMenu();
      expect(screen.getByText('Upload to Provider')).toBeInTheDocument();
    });

    it('shows "Upload Image" when agents endpoint has no resolved provider type', () => {
      setupMocks();
      renderMenu({
        endpoint: EModelEndpoint.agents,
        endpointType: EModelEndpoint.agents,
      });
      openMenu();
      expect(screen.getByText('Upload Image')).toBeInTheDocument();
    });
  });

  describe('Basic Rendering', () => {
    it('renders the attachment button', () => {
      setupMocks();
      renderMenu();
      expect(screen.getByRole('button', { name: /attach file options/i })).toBeInTheDocument();
    });

    it('is disabled when disabled prop is true', () => {
      setupMocks();
      renderMenu({ disabled: true });
      expect(screen.getByRole('button', { name: /attach file options/i })).toBeDisabled();
    });

    it('is not disabled when disabled prop is false', () => {
      setupMocks();
      renderMenu({ disabled: false });
      expect(screen.getByRole('button', { name: /attach file options/i })).not.toBeDisabled();
    });

    it('portals the menu without making the conversation tree inert', () => {
      setupMocks();
      renderMenu();
      expect(screen.getByTestId('dropdown-popup')).toHaveAttribute('data-modal', 'false');
      expect(screen.getByTestId('dropdown-popup')).toHaveAttribute('data-portal', 'true');
    });

    it('renders the unified upload button when legacyFileUploadUX is not true', () => {
      setupMocks();
      renderMenu({ isUnifiedMode: true });
      expect(screen.getByRole('button', { name: /attach files/i })).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /attach file options/i }),
      ).not.toBeInTheDocument();
    });
  });

  describe('Agent Capabilities', () => {
    it('shows OCR Text option when context is enabled', () => {
      setupMocks();
      mockUseAgentCapabilities.mockReturnValue({
        contextEnabled: true,
        fileSearchEnabled: false,
        codeEnabled: false,
      });
      renderMenu({ endpointType: EModelEndpoint.openAI });
      openMenu();
      expect(screen.getByText('Upload as Text')).toBeInTheDocument();
    });

    it('shows File Search option when enabled and allowed by agent', () => {
      setupMocks();
      mockUseAgentCapabilities.mockReturnValue({
        contextEnabled: false,
        fileSearchEnabled: true,
        codeEnabled: false,
      });
      mockUseAgentToolPermissions.mockReturnValue({
        fileSearchAllowedByAgent: true,
        codeAllowedByAgent: false,
        provider: undefined,
      });
      renderMenu({ endpointType: EModelEndpoint.openAI });
      openMenu();
      expect(screen.getByText('Upload for File Search')).toBeInTheDocument();
    });

    it('does NOT show File Search when enabled but not allowed by agent', () => {
      setupMocks();
      mockUseAgentCapabilities.mockReturnValue({
        contextEnabled: false,
        fileSearchEnabled: true,
        codeEnabled: false,
      });
      renderMenu({ endpointType: EModelEndpoint.openAI });
      openMenu();
      expect(screen.queryByText('Upload for File Search')).not.toBeInTheDocument();
    });

    it('shows Code Files option when enabled and allowed by agent', () => {
      setupMocks();
      mockUseAgentCapabilities.mockReturnValue({
        contextEnabled: false,
        fileSearchEnabled: false,
        codeEnabled: true,
      });
      mockUseAgentToolPermissions.mockReturnValue({
        fileSearchAllowedByAgent: false,
        codeAllowedByAgent: true,
        provider: undefined,
      });
      renderMenu({ endpointType: EModelEndpoint.openAI });
      openMenu();
      expect(screen.getByText('Upload to Code Environment')).toBeInTheDocument();
    });

    it('shows all options when all capabilities are enabled', () => {
      setupMocks();
      mockUseAgentCapabilities.mockReturnValue({
        contextEnabled: true,
        fileSearchEnabled: true,
        codeEnabled: true,
      });
      mockUseAgentToolPermissions.mockReturnValue({
        fileSearchAllowedByAgent: true,
        codeAllowedByAgent: true,
        provider: undefined,
      });
      renderMenu({ endpointType: EModelEndpoint.openAI });
      openMenu();
      expect(screen.getByText('Upload to Provider')).toBeInTheDocument();
      expect(screen.getByText('Upload as Text')).toBeInTheDocument();
      expect(screen.getByText('Upload for File Search')).toBeInTheDocument();
      expect(screen.getByText('Upload to Code Environment')).toBeInTheDocument();
    });

    it('passes File Search resource when the file input changes before React state commits', () => {
      setupMocks();
      const handleFileChange = jest.fn();
      mockUseFileHandlingNoChatContext.mockReturnValue({ handleFileChange });
      mockUseAgentCapabilities.mockReturnValue({
        contextEnabled: false,
        fileSearchEnabled: true,
        codeEnabled: false,
      });
      mockUseAgentToolPermissions.mockReturnValue({
        fileSearchAllowedByAgent: true,
        codeAllowedByAgent: false,
        provider: undefined,
      });
      const originalClick = HTMLInputElement.prototype.click;
      const file = new File(['data'], 'sheet.xlsx', {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });

      HTMLInputElement.prototype.click = function click() {
        Object.defineProperty(this, 'files', {
          configurable: true,
          value: [file],
        });
        fireEvent.change(this);
      };

      try {
        renderMenu({ endpointType: EModelEndpoint.openAI });
        openMenu();
        fireEvent.click(screen.getByText('Upload to Provider'));
        fireEvent.click(screen.getByText('Upload for File Search'));
      } finally {
        HTMLInputElement.prototype.click = originalClick;
      }

      expect(handleFileChange).toHaveBeenNthCalledWith(1, expect.any(Object), undefined);
      expect(handleFileChange).toHaveBeenNthCalledWith(
        2,
        expect.any(Object),
        EToolResources.file_search,
      );
    });
  });

  describe('SharePoint Integration', () => {
    it('shows SharePoint option when enabled', () => {
      setupMocks();
      mockUseGetStartupConfig.mockReturnValue({
        data: { sharePointFilePickerEnabled: true },
      });
      renderMenu({ endpointType: EModelEndpoint.openAI });
      openMenu();
      expect(screen.getByText('Upload from SharePoint')).toBeInTheDocument();
    });

    it('does NOT show SharePoint option when disabled', () => {
      setupMocks();
      renderMenu({ endpointType: EModelEndpoint.openAI });
      openMenu();
      expect(screen.queryByText('Upload from SharePoint')).not.toBeInTheDocument();
    });
  });

  describe('Edge Cases', () => {
    it('handles undefined endpoint and provider gracefully', () => {
      setupMocks();
      renderMenu({ endpoint: undefined, endpointType: undefined });
      const button = screen.getByRole('button', { name: /attach file options/i });
      expect(button).toBeInTheDocument();
      fireEvent.click(button);
      expect(screen.getByText('Upload Image')).toBeInTheDocument();
    });

    it('handles null endpoint and provider gracefully', () => {
      setupMocks();
      renderMenu({ endpoint: null, endpointType: null });
      expect(screen.getByRole('button', { name: /attach file options/i })).toBeInTheDocument();
    });

    it('handles missing agentId gracefully', () => {
      setupMocks();
      renderMenu({ agentId: undefined, endpointType: EModelEndpoint.openAI });
      expect(screen.getByRole('button', { name: /attach file options/i })).toBeInTheDocument();
    });

    it('handles empty string agentId', () => {
      setupMocks();
      renderMenu({ agentId: '', endpointType: EModelEndpoint.openAI });
      expect(screen.getByRole('button', { name: /attach file options/i })).toBeInTheDocument();
    });
  });
});
