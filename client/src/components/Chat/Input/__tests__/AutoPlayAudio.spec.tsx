import React from 'react';
import { RecoilRoot } from 'recoil';
import { render, screen } from '@testing-library/react';
import AutoPlayAudio from '../AutoPlayAudio';
import store from '~/store';

jest.mock('../BrowserAudio', () => () => <div data-testid="browser-autoplay" />);
jest.mock('../StreamAudio', () => () => <div data-testid="external-autoplay" />);

const renderAutoPlayAudio = ({
  engineTTS,
  initialized = true,
}: {
  engineTTS: string;
  initialized?: boolean;
}) =>
  render(
    <RecoilRoot
      initializeState={({ set }) => {
        set(store.engineTTS, engineTTS);
        set(store.speechSettingsInitialized, initialized);
      }}
    >
      <AutoPlayAudio index={0} />
    </RecoilRoot>,
  );

describe('AutoPlayAudio engine selection', () => {
  it('drives autoplay through the Web Speech API for the browser engine', () => {
    renderAutoPlayAudio({ engineTTS: 'browser' });

    expect(screen.getByTestId('browser-autoplay')).toBeInTheDocument();
    expect(screen.queryByTestId('external-autoplay')).not.toBeInTheDocument();
  });

  it('drives autoplay through the server stream for the external engine', () => {
    renderAutoPlayAudio({ engineTTS: 'external' });

    expect(screen.getByTestId('external-autoplay')).toBeInTheDocument();
    expect(screen.queryByTestId('browser-autoplay')).not.toBeInTheDocument();
  });

  it('mounts nothing before speech settings initialize', () => {
    renderAutoPlayAudio({ engineTTS: 'browser', initialized: false });

    expect(screen.queryByTestId('browser-autoplay')).not.toBeInTheDocument();
    expect(screen.queryByTestId('external-autoplay')).not.toBeInTheDocument();
  });

  it('mounts nothing for an unknown engine', () => {
    renderAutoPlayAudio({ engineTTS: 'unsupported' });

    expect(screen.queryByTestId('browser-autoplay')).not.toBeInTheDocument();
    expect(screen.queryByTestId('external-autoplay')).not.toBeInTheDocument();
  });
});
