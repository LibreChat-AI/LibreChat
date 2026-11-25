import userEvent from '@testing-library/user-event';
import { render, screen } from 'test/layout-test-utils';
import PluginAuthForm from '../PluginAuthForm';

describe('PluginAuthForm', () => {
  const plugin = {
    pluginKey: 'test-plugin',
    authConfig: [
      {
        authField: 'key',
        label: 'Key',
      },
      {
        authField: 'secret',
        label: 'Secret',
      },
    ],
  };

  const onSubmit = jest.fn();

  it('renders the form with the correct fields', () => {
    //@ts-ignore - dont need all props of plugin
    render(<PluginAuthForm plugin={plugin} onSubmit={onSubmit} />);

    expect(screen.getByLabelText('Key')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Secret')).toHaveAttribute('type', 'password');
  });

  it('masks fields by default and renders non-sensitive fields as plain text', () => {
    const mixedPlugin = {
      pluginKey: 'mixed-plugin',
      authConfig: [
        { authField: 'token', label: 'Token' },
        { authField: 'secret', label: 'Secret', sensitive: true },
        { authField: 'url', label: 'URL', sensitive: false },
      ],
    };

    //@ts-ignore - dont need all props of plugin
    render(<PluginAuthForm plugin={mixedPlugin} onSubmit={onSubmit} />);

    expect(screen.getByLabelText('Token')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Secret')).toHaveAttribute('type', 'password');

    const urlField = screen.getByLabelText('URL');
    expect(urlField).toHaveAttribute('type', 'text');
    expect(urlField.parentElement?.querySelector('button')).toBeNull();
  });

  it('shows a semantic warning for a recognized credential with the wrong format', async () => {
    const openAiPlugin = {
      pluginKey: 'dalle',
      authConfig: [{ authField: 'DALLE3_API_KEY||DALLE_API_KEY', label: 'OpenAI API Key' }],
    };
    //@ts-ignore - dont need all props of plugin
    render(<PluginAuthForm plugin={openAiPlugin} onSubmit={onSubmit} />);

    const input = screen.getByLabelText('OpenAI API Key');
    expect(input).toHaveAttribute('placeholder', 'sk-...');

    await userEvent.type(input, 'invalid-key');

    expect(document.getElementById('DALLE3_API_KEY-hint')).toHaveClass('text-text-warning');
  });

  it('calls the onSubmit function with the form data when submitted', async () => {
    //@ts-ignore - dont need all props of plugin
    render(<PluginAuthForm plugin={plugin} onSubmit={onSubmit} />);

    await userEvent.type(screen.getByLabelText('Key'), '1234567890');
    await userEvent.type(screen.getByLabelText('Secret'), '1234567890');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).toHaveBeenCalledWith({
      pluginKey: 'test-plugin',
      action: 'install',
      auth: {
        key: '1234567890',
        // file deepcode ignore HardcodedNonCryptoSecret/test: test
        secret: '1234567890',
      },
    });
  });

  it('reflects an external saving state as a disabled, in-progress submit button', () => {
    //@ts-ignore - dont need all props of plugin
    render(<PluginAuthForm plugin={plugin} onSubmit={onSubmit} isSaving />);

    const button = screen.getByRole('button', { name: 'Saving...' });
    expect(button).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('renders a Cancel button when onCancel is provided and invokes it on click', async () => {
    const onCancel = jest.fn();
    //@ts-ignore - dont need all props of plugin
    render(<PluginAuthForm plugin={plugin} onSubmit={onSubmit} onCancel={onCancel} />);

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does not render a Cancel button by default', () => {
    //@ts-ignore - dont need all props of plugin
    render(<PluginAuthForm plugin={plugin} onSubmit={onSubmit} />);
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });
});
