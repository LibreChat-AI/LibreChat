import React from 'react';
import { RecoilRoot } from 'recoil';
import { render, screen, fireEvent } from '@testing-library/react';
import EngineSTTDropdown from '../EngineSTTDropdown';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('@librechat/client', () => ({
  Dropdown: ({
    value,
    options,
    onChange,
  }: {
    value: string;
    options: { value: string; label: string }[];
    onChange: (value: string) => void;
  }) => (
    <select
      data-testid="EngineSTTDropdown"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

const optionsOf = () =>
  Array.from(screen.getByTestId('EngineSTTDropdown').querySelectorAll('option')).map((option) => [
    option.value,
    option.textContent,
  ]);

describe('EngineSTTDropdown', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('offers the live engine only when the server reports it', () => {
    render(
      <RecoilRoot>
        <EngineSTTDropdown external realtime />
      </RecoilRoot>,
    );

    expect(optionsOf()).toEqual([
      ['browser', 'com_nav_browser'],
      ['external', 'com_nav_external'],
      ['realtime', 'com_nav_live'],
    ]);

    fireEvent.change(screen.getByTestId('EngineSTTDropdown'), { target: { value: 'realtime' } });
    expect(localStorage.getItem('engineSTT')).toBe(JSON.stringify('realtime'));
  });

  it('keeps the existing choices when live transcription is not configured', () => {
    render(
      <RecoilRoot>
        <EngineSTTDropdown external />
      </RecoilRoot>,
    );

    expect(optionsOf()).toEqual([
      ['browser', 'com_nav_browser'],
      ['external', 'com_nav_external'],
    ]);
  });

  it('offers only the browser without an external provider', () => {
    render(
      <RecoilRoot>
        <EngineSTTDropdown external={false} realtime />
      </RecoilRoot>,
    );

    expect(optionsOf()).toEqual([['browser', 'com_nav_browser']]);
  });
});
