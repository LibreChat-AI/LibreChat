import React from 'react';
import '@testing-library/jest-dom';
import { ProviderId } from 'librechat-data-provider';
import { render, screen } from '@testing-library/react';
import type { TEndpointsConfig } from 'librechat-data-provider';
import type { Endpoint } from '~/common';
import { getSelectedIcon } from '../utils';

const ollama: Endpoint = {
  value: 'Ollama',
  label: 'Ollama',
  hasModels: true,
  icon: <span />,
};

const endpointsConfig = {
  Ollama: { order: 1, providerId: ProviderId.ollama },
} as unknown as TEndpointsConfig;

const renderSelected = (model: string) =>
  render(
    <>
      {getSelectedIcon({
        mappedEndpoints: [ollama],
        selectedValues: { endpoint: 'Ollama', model, modelSpec: '' },
        modelSpecs: [],
        endpointsConfig,
      })}
    </>,
  );

describe('getSelectedIcon', () => {
  it('shows the maker of a model the endpoint only hosts', () => {
    renderSelected('gemma4:12b-it-qat');
    expect(screen.getByRole('img', { name: 'Gemma' })).toBeInTheDocument();
  });

  it('keeps the endpoint icon for a model with no known maker', () => {
    renderSelected('starcoder2:15b');
    expect(screen.getByRole('img', { name: 'Ollama' })).toBeInTheDocument();
  });
});
