/**
 * @jest-environment jsdom
 */
/* eslint-disable i18next/no-literal-string */
import { render, fireEvent } from '@testing-library/react';
import { FormProvider, useForm, type UseFormReturn } from 'react-hook-form';
import type { AgentForm } from '~/common';
import AgentAvatar from '../AgentAvatar';

jest.mock('@librechat/client', () => ({
  useToastContext: () => ({
    showToast: jest.fn(),
  }),
}));

jest.mock('~/data-provider', () => ({
  useGetFileConfig: () => ({
    data: { avatarSizeLimit: 1024 * 1024 },
  }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('../Images', () => ({
  AgentAvatarRender: () => <div data-testid="avatar-render" />,
  NoImage: () => <div data-testid="no-avatar" />,
  AvatarMenu: ({ onReset }: { onReset: () => void }) => (
    <button type="button" data-testid="reset-avatar" onClick={onReset}>
      Reset
    </button>
  ),
}));

const defaultFormValues: AgentForm = {
  agent: undefined,
  id: 'agent_123',
  name: 'Agent',
  description: null,
  instructions: null,
  instructionsSource: 'inline',
  instructionsPrompt: null,
  model: 'gpt-4',
  model_parameters: {
    temperature: 1,
    maxContextTokens: null,
    max_context_tokens: null,
    max_output_tokens: null,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  },
  tools: [],
  provider: 'openai',
  agent_ids: [],
  edges: [],
  end_after_tools: false,
  hide_sequential_outputs: false,
  recursion_limit: undefined,
  category: 'general',
  support_contact: undefined,
  artifacts: '',
  execute_code: false,
  file_search: false,
  web_search: false,
  avatar_file: null,
  avatar_preview: '',
  avatar_action: null,
};

describe('AgentAvatar reset menu', () => {
  it('clears preview and file state when reset is triggered', () => {
    let methodsRef: UseFormReturn<AgentForm> | undefined;
    const Wrapper = () => {
      methodsRef = useForm<AgentForm>({
        defaultValues: {
          ...defaultFormValues,
          avatar_preview: 'data:image/png;base64,abc',
          avatar_file: new File(['avatar'], 'avatar.png', { type: 'image/png' }),
          avatar_action: 'upload',
        },
      });

      return (
        <FormProvider {...methodsRef}>
          <AgentAvatar
            avatar={{
              filepath: 'https://example.com/current.png',
              source: 's3',
            }}
          />
        </FormProvider>
      );
    };

    const { getByTestId } = render(<Wrapper />);
    fireEvent.click(getByTestId('reset-avatar'));

    if (!methodsRef) {
      throw new Error('Form methods were not initialized');
    }

    expect(methodsRef.getValues('avatar_preview')).toBe('');
    expect(methodsRef.getValues('avatar_file')).toBeNull();
    expect(methodsRef.getValues('avatar_action')).toBe('reset');
  });
});
