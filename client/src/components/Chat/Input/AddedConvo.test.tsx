/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import type { TConversation, TEndpointsConfig } from 'librechat-data-provider';
import AddedConvo from './AddedConvo';

let mockEndpointsConfig: TEndpointsConfig = {};

jest.mock('~/data-provider', () => ({
  useGetEndpointsQuery: () => ({ data: mockEndpointsConfig }),
}));

jest.mock('~/Providers', () => ({
  useAgentsMapContext: () => ({}),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/components/Endpoints', () => ({
  EndpointIcon: () => null,
}));

const addedConvo: TConversation = {
  conversationId: 'new',
  endpoint: 'Anthropic' as TConversation['endpoint'],
  title: '',
  createdAt: '',
  updatedAt: '',
  model: 'claude-opus-4-7',
};

describe('AddedConvo', () => {
  beforeEach(() => {
    mockEndpointsConfig = {};
  });

  it('displays the configured model label', () => {
    mockEndpointsConfig = {
      Anthropic: {
        order: 0,
        modelLabels: { 'claude-opus-4-7': 'Claude Opus 4.7' },
      },
    };

    render(<AddedConvo addedConvo={addedConvo} setAddedConvo={jest.fn()} />);

    expect(screen.getByText('+ Claude Opus 4.7')).toBeInTheDocument();
  });

  it('falls back to the model id when the configured label is empty', () => {
    mockEndpointsConfig = {
      Anthropic: { order: 0, modelLabels: { 'claude-opus-4-7': '' } },
    };

    render(<AddedConvo addedConvo={addedConvo} setAddedConvo={jest.fn()} />);

    expect(screen.getByText('+ claude-opus-4-7')).toBeInTheDocument();
  });
});
