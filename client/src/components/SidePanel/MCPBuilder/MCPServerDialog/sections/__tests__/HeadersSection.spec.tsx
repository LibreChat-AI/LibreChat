import React from 'react';
import userEvent from '@testing-library/user-event';
import { FormProvider, useForm } from 'react-hook-form';
import { render, screen, waitFor } from '@testing-library/react';
import type { InputHTMLAttributes, ReactNode } from 'react';
import type { MCPServerFormData, HeaderRow } from '../../hooks/useMCPServerForm';
import { buildHeadersConfig } from '../../hooks/useMCPServerForm';
import HeadersSection from '../HeadersSection';

jest.mock('~/data-provider/MCP', () => ({
  useCreateMCPServerMutation: jest.fn(),
  useUpdateMCPServerMutation: jest.fn(),
  useDeleteMCPServerMutation: jest.fn(),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, string>) =>
    values ? `${key}:${Object.values(values).join(',')}` : key,
}));

jest.mock('@librechat/client', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  const Input = R.forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
    (props, ref) => R.createElement('input', { ...props, ref }),
  );
  const SecretInput = R.forwardRef<
    HTMLInputElement,
    InputHTMLAttributes<HTMLInputElement> & { controlsOnHover?: boolean }
  >(({ controlsOnHover: _controlsOnHover, ...props }, ref) =>
    R.createElement('input', { ...props, type: 'password', ref }),
  );
  return {
    Input,
    SecretInput,
    Label: ({ children, ...props }: { children: ReactNode }) =>
      R.createElement('label', props, children),
    Button: ({
      children,
      variant: _variant,
      size: _size,
      ...props
    }: {
      children: ReactNode;
      variant?: string;
      size?: string;
    }) => R.createElement('button', props, children),
    TrashIcon: () => R.createElement('span'),
  };
});

function renderSection({
  headers = [],
  type = 'streamable-http',
  isEditMode = false,
  onSubmit = jest.fn(),
}: {
  headers?: HeaderRow[];
  type?: MCPServerFormData['type'];
  isEditMode?: boolean;
  onSubmit?: (data: MCPServerFormData) => void;
} = {}) {
  function Wrapper() {
    const methods = useForm<MCPServerFormData>({
      defaultValues: {
        title: 'Mautic',
        url: 'https://example.com/mcp',
        type,
        auth: { auth_type: 'none' as MCPServerFormData['auth']['auth_type'] },
        headers,
        trust: true,
      },
      mode: 'onChange',
    });
    return (
      <FormProvider {...methods}>
        <form onSubmit={methods.handleSubmit((data) => onSubmit(data))}>
          <HeadersSection isEditMode={isEditMode} />
          <button type="submit" aria-label="submit" />
        </form>
      </FormProvider>
    );
  }
  return render(<Wrapper />);
}

describe('HeadersSection', () => {
  it('adds and removes header rows', async () => {
    const user = userEvent.setup();
    renderSection();

    expect(screen.queryAllByTestId('mcp-header-row')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: /com_ui_add_header/ }));
    await user.click(screen.getByRole('button', { name: /com_ui_add_header/ }));
    expect(screen.getAllByTestId('mcp-header-row')).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'com_ui_remove_header:1' }));
    expect(screen.getAllByTestId('mcp-header-row')).toHaveLength(1);
  });

  it('submits the entered headers', async () => {
    const user = userEvent.setup();
    const onSubmit = jest.fn();
    renderSection({ onSubmit });

    for (const [name, value] of [
      ['X-Mautic-Client-Id', 'client-123'],
      ['X-Mautic-Client-Secret', 'secret-456'],
    ]) {
      await user.click(screen.getByRole('button', { name: /com_ui_add_header/ }));
      const names = screen.getAllByLabelText('com_ui_header_name');
      const values = screen.getAllByLabelText('com_ui_header_value');
      await user.type(names[names.length - 1], name);
      await user.type(values[values.length - 1], value);
    }
    await user.click(screen.getByRole('button', { name: 'submit' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(buildHeadersConfig(onSubmit.mock.calls[0][0].headers)).toEqual({
      'X-Mautic-Client-Id': 'client-123',
      'X-Mautic-Client-Secret': 'secret-456',
    });
  });

  it('rejects invalid and duplicate header names', async () => {
    const user = userEvent.setup();
    const onSubmit = jest.fn();
    renderSection({ onSubmit });

    await user.click(screen.getByRole('button', { name: /com_ui_add_header/ }));
    await user.type(screen.getByLabelText('com_ui_header_name'), 'Bad Header');
    await user.click(screen.getByRole('button', { name: 'submit' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('com_ui_header_name_invalid');

    await user.clear(screen.getByLabelText('com_ui_header_name'));
    await user.type(screen.getByLabelText('com_ui_header_name'), 'X-Id');
    await user.click(screen.getByRole('button', { name: /com_ui_add_header/ }));
    const names = screen.getAllByLabelText('com_ui_header_name');
    await user.type(names[1], 'x-id');
    await user.click(screen.getByRole('button', { name: 'submit' }));

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.map((alert) => alert.textContent)).toEqual([
      'com_ui_header_name_duplicate',
      'com_ui_header_name_duplicate',
    ]);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows stored headers with blank values and a keep placeholder in edit mode', () => {
    renderSection({
      isEditMode: true,
      headers: [{ name: 'X-Client-Secret', value: '', stored: true }],
    });

    expect(screen.getByLabelText('com_ui_header_name')).toHaveValue('X-Client-Secret');
    const value = screen.getByLabelText('com_ui_header_value');
    expect(value).toHaveValue('');
    expect(value).toHaveAttribute('placeholder', 'com_ui_leave_blank_to_keep');
  });

  it('renders nothing for transports without HTTP headers', () => {
    const { container } = renderSection({
      type: 'websocket' as unknown as MCPServerFormData['type'],
    });
    expect(container.querySelector('fieldset')).toBeNull();
  });
});

describe('buildHeadersConfig', () => {
  it('sends blank stored values as empty strings and drops blank new rows', () => {
    expect(
      buildHeadersConfig([
        { name: ' X-Kept ', value: '', stored: true },
        { name: 'X-New', value: '', stored: false },
        { name: '', value: 'orphan', stored: false },
        { name: 'X-Set', value: 'v', stored: false },
      ]),
    ).toEqual({ 'X-Kept': '', 'X-Set': 'v' });
  });

  it('returns undefined when no headers remain', () => {
    expect(buildHeadersConfig([])).toBeUndefined();
  });
});
