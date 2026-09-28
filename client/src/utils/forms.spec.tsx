import React from 'react';
import type { Agent } from 'librechat-data-provider';
import { getDefaultAgentFormValues, processAgentOption } from './forms';

describe('getDefaultAgentFormValues', () => {
  it('uses the scalable user workspace by default', () => {
    expect(getDefaultAgentFormValues().stateful_code_environment).toBe('user');
  });

  it('seeds a new agent with the user workspace preference', () => {
    expect(getDefaultAgentFormValues('agent-user').stateful_code_environment).toBe('agent-user');
  });

  it('uses the semantic success marker for public agent options', () => {
    const option = processAgentOption({
      agent: { id: 'public-agent', name: 'Public agent', isPublic: true } as Agent,
    });

    expect(React.isValidElement(option.icon)).toBe(true);
    expect((option.icon as React.ReactElement<{ className: string }>).props.className).toContain(
      'text-status-success',
    );
  });
});
