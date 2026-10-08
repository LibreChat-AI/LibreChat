import React from 'react';
import { Constants } from 'librechat-data-provider';
import { useForm, FormProvider } from 'react-hook-form';
import { renderHook, act } from '@testing-library/react';
import { useRemoveMCPTool } from '../useRemoveMCPTool';

const mockShowToast = jest.fn();

jest.mock('@librechat/client', () => ({
  useToastContext: () => ({ showToast: mockShowToast }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

function makeWrapper(tools: string[], onTools: (next: string[]) => void) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    const methods = useForm({ defaultValues: { tools } });
    const original = methods.setValue;
    methods.setValue = ((name: 'tools', value: string[], options?: object) => {
      if (name === 'tools') {
        onTools(value);
      }
      return original(name, value, options);
    }) as typeof methods.setValue;
    return <FormProvider {...methods}>{children}</FormProvider>;
  };
}

describe('useRemoveMCPTool', () => {
  beforeEach(() => {
    mockShowToast.mockClear();
  });

  test('strips every token format the selection logic counts as the server', () => {
    const tools = [
      `${Constants.mcp_server}${Constants.mcp_delimiter}srv`,
      'srv',
      'mcp_srv',
      `search${Constants.mcp_delimiter}srv`,
      `sys__all__sys${Constants.mcp_delimiter}srv`,
      'dalle',
      `search${Constants.mcp_delimiter}other`,
    ];
    let next: string[] = [];
    const { result } = renderHook(() => useRemoveMCPTool(), {
      wrapper: makeWrapper(tools, (value) => {
        next = value;
      }),
    });

    act(() => {
      result.current.removeTool('srv');
    });

    expect(next).toEqual(['dalle', `search${Constants.mcp_delimiter}other`]);
    expect(mockShowToast).toHaveBeenCalledTimes(1);
  });

  test('does not remove a longer configured server whose tool key shares the suffix', () => {
    const tools = [
      `search${Constants.mcp_delimiter}bar`,
      `search${Constants.mcp_delimiter}foo_mcp_bar`,
    ];
    let next: string[] = [];
    const { result } = renderHook(() => useRemoveMCPTool({ serverNames: ['bar', 'foo mcp bar'] }), {
      wrapper: makeWrapper(tools, (value) => {
        next = value;
      }),
    });

    act(() => {
      result.current.removeTool('bar');
    });

    expect(next).toEqual([`search${Constants.mcp_delimiter}foo_mcp_bar`]);
  });

  test('ignores an empty server name', () => {
    let called = false;
    const { result } = renderHook(() => useRemoveMCPTool(), {
      wrapper: makeWrapper(['srv'], () => {
        called = true;
      }),
    });

    act(() => {
      result.current.removeTool('');
    });

    expect(called).toBe(false);
    expect(mockShowToast).not.toHaveBeenCalled();
  });
});
