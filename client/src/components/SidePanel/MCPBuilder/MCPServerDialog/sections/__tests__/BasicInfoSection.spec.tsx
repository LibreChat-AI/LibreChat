import { FormProvider, useForm } from 'react-hook-form';
import { MAX_MCP_ICON_PATH_LENGTH } from 'librechat-data-provider';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type * as ReactNS from 'react';
import type { MCPServerFormData } from '../../hooks/useMCPServerForm';
import BasicInfoSection from '../BasicInfoSection';

let mockMcpServerContactEnabled = true;

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({
    data: { interface: { mcpServerContact: mockMcpServerContactEnabled } },
  }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, unknown>) => {
    const translations: Record<string, string> = {
      com_ui_name: 'Name',
      com_ui_description: 'Description',
      com_ui_optional: 'Optional',
      com_ui_field_required: 'This field is required',
      com_ui_support_contact: 'Support Contact',
      com_ui_support_contact_name: 'Support name',
      com_ui_support_contact_name_placeholder: 'Support contact name',
      com_ui_support_contact_name_min_length: 'Name must be at least 3 characters',
      com_ui_support_contact_email: 'Support email',
      com_ui_support_contact_email_placeholder: 'support@example.com',
      com_ui_support_contact_email_invalid: 'Please enter a valid email address',
      com_ui_upload_icon: 'Upload icon image',
    };
    if (values) {
      return `${translations[key] ?? key}:${values[0]}`;
    }
    return translations[key] ?? key;
  },
}));

jest.mock('~/components/ui/CustomIcon', () => {
  const React = jest.requireActual<typeof ReactNS>('react');
  return {
    __esModule: true,
    default: ({ src }: { src: string }) =>
      React.createElement('img', { alt: '', 'data-testid': 'icon-preview', src }),
  };
});

jest.mock('@librechat/client', () => {
  const React = jest.requireActual<typeof ReactNS>('react');
  return {
    Button: ({ children, ...props }: { children: ReactNode }) =>
      React.createElement('button', { type: 'button', ...props }, children),
    Input: React.forwardRef<HTMLInputElement, Record<string, unknown>>((props, ref) =>
      React.createElement('input', { ...props, ref }),
    ),
    Label: ({ children, ...props }: { children: ReactNode }) =>
      React.createElement('label', props, children),
    Textarea: React.forwardRef<HTMLTextAreaElement, Record<string, unknown>>((props, ref) =>
      React.createElement('textarea', { ...props, ref }),
    ),
    SquirclePlusIcon: () => React.createElement('span'),
  };
});

const defaultValues: MCPServerFormData = {
  title: 'Existing',
  description: '',
  support_contact: { name: 'Platform Team', email: 'platform@example.com' },
  icon: 'data:image/png;base64,existing',
  url: 'https://example.com/mcp',
  type: 'streamable-http',
  auth: { auth_type: 'none' as MCPServerFormData['auth']['auth_type'] },
  trust: true,
};

function renderSection() {
  const onSubmit = jest.fn();
  function Wrapper() {
    const methods = useForm<MCPServerFormData>({
      defaultValues,
      mode: 'onChange',
    });
    return (
      <FormProvider {...methods}>
        <form onSubmit={methods.handleSubmit((data) => onSubmit(data))}>
          <BasicInfoSection />
          <button type="submit" aria-label="save" />
        </form>
      </FormProvider>
    );
  }

  const view = render(<Wrapper />);
  const input = view.container.querySelector<HTMLInputElement>('input[type="file"]');
  if (input == null) {
    throw new Error('icon file input not rendered');
  }
  return { ...view, input, onSubmit };
}

function rasterFile(bytes: number): File {
  return new File([new Uint8Array(bytes)], 'icon.png', { type: 'image/png' });
}

describe('BasicInfoSection support contact', () => {
  afterEach(() => {
    mockMcpServerContactEnabled = true;
  });

  it('prepopulates name and email independently', () => {
    renderSection();

    expect(screen.getByLabelText('Support name Optional')).toHaveValue('Platform Team');
    expect(screen.getByLabelText('Support email Optional')).toHaveValue('platform@example.com');
  });

  it('hides contact fields when disabled and retains their values on submit', async () => {
    mockMcpServerContactEnabled = false;
    const { onSubmit } = renderSection();

    expect(screen.queryByLabelText('Support name Optional')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Support email Optional')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          support_contact: { name: 'Platform Team', email: 'platform@example.com' },
        }),
      );
    });
  });

  it('validates a non-empty short name', async () => {
    renderSection();

    fireEvent.change(screen.getByLabelText('Support name Optional'), { target: { value: 'ab' } });

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Name must be at least 3 characters');
    });
  });

  it('validates a malformed email and allows an empty email', async () => {
    renderSection();
    const email = screen.getByLabelText('Support email Optional');

    fireEvent.change(email, { target: { value: 'invalid' } });
    await waitFor(() => {
      expect(screen.getByText('Please enter a valid email address')).toBeInTheDocument();
    });

    fireEvent.change(email, { target: { value: '' } });
    await waitFor(() => {
      expect(screen.queryByText('Please enter a valid email address')).not.toBeInTheDocument();
    });
  });
});

describe('BasicInfoSection icon upload', () => {
  it('rejects a file too large to store, explains why, and keeps the current icon', async () => {
    const { input } = renderSection();

    fireEvent.change(input, { target: { files: [rasterFile(MAX_MCP_ICON_PATH_LENGTH)] } });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('com_ui_icon_too_large:192');
    expect(screen.getByTestId('icon-preview')).toHaveAttribute(
      'src',
      'data:image/png;base64,existing',
    );
  });

  it('still submits the form after a rejected pick', async () => {
    const { input, onSubmit } = renderSection();

    fireEvent.change(input, { target: { files: [rasterFile(MAX_MCP_ICON_PATH_LENGTH)] } });
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].icon).toBe('data:image/png;base64,existing');
  });

  it('refuses an oversized SVG before reading or sanitizing it', async () => {
    const readAsText = jest.spyOn(FileReader.prototype, 'readAsText');
    const { input } = renderSection();
    const svg = new File([new Uint8Array(MAX_MCP_ICON_PATH_LENGTH)], 'icon.svg', {
      type: 'image/svg+xml',
    });

    fireEvent.change(input, { target: { files: [svg] } });

    expect(await screen.findByRole('alert')).toHaveTextContent('com_ui_icon_too_large:192');
    expect(readAsText).not.toHaveBeenCalled();
    readAsText.mockRestore();
  });

  it('sanitizes and previews an SVG that fits', async () => {
    const { input } = renderSection();
    const svg = new File(
      ['<svg><script>alert(1)</script><path d="M0 0h1v1z"/></svg>'],
      'icon.svg',
      {
        type: 'image/svg+xml',
      },
    );

    fireEvent.change(input, { target: { files: [svg] } });

    await waitFor(() => {
      const src = screen.getByTestId('icon-preview').getAttribute('src') ?? '';
      expect(src.startsWith('data:image/svg+xml;base64,')).toBe(true);
      const markup = atob(src.slice('data:image/svg+xml;base64,'.length));
      expect(markup).not.toContain('script');
      expect(markup).toContain('path');
    });
  });

  it('describes the upload control with the rejection so it is announced', async () => {
    const { input } = renderSection();

    fireEvent.change(input, { target: { files: [rasterFile(MAX_MCP_ICON_PATH_LENGTH)] } });

    const alert = await screen.findByRole('alert');
    const button = screen.getByRole('button', { name: 'Upload icon image' });
    expect(button).toHaveAttribute('aria-describedby', alert.id);
    expect(button).toHaveAttribute('aria-invalid', 'true');
  });

  it('accepts a file that fits and previews it without an error', async () => {
    const { input } = renderSection();

    fireEvent.change(input, { target: { files: [rasterFile(1024)] } });

    await waitFor(() => {
      expect(screen.getByTestId('icon-preview')).toHaveAttribute(
        'src',
        expect.stringMatching(/^data:image\/png;base64,A/),
      );
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('clears a previous rejection once an acceptable file is picked', async () => {
    const { input } = renderSection();

    fireEvent.change(input, { target: { files: [rasterFile(MAX_MCP_ICON_PATH_LENGTH)] } });
    await screen.findByRole('alert');

    fireEvent.change(input, { target: { files: [rasterFile(1024)] } });

    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('icon-preview')).toHaveAttribute(
      'src',
      expect.stringMatching(/^data:image\/png;base64,A/),
    );
  });
});
