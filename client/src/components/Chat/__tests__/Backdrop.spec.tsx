import React from 'react';
import '@testing-library/jest-dom';
import { render, act, screen } from '@testing-library/react';
import { applyResolvedTheme, clearAppliedTheme, resolveTheme } from '@librechat/client';
import WelcomeBackdrop, { registerWelcomeBackdrop } from '../Backdrop';
import { bundledThemes } from '~/Providers/bootVersion';

/** A theme asks for a backdrop through `welcomeBackdrop`; the app paints the component
 * registered for that value, through the provider's own apply and clear. */
function Dots() {
  return <div data-testid="dots-backdrop" />;
}

const applyClickHouse = () => applyResolvedTheme(resolveTheme(bundledThemes.clickhouse, 'light'));

describe('WelcomeBackdrop', () => {
  afterEach(() => {
    clearAppliedTheme();
  });

  it('paints nothing under a theme that asks for no backdrop', () => {
    const unregister = registerWelcomeBackdrop('dots', Dots);
    render(<WelcomeBackdrop />);
    expect(screen.queryByTestId('dots-backdrop')).toBeNull();
    unregister();
  });

  it('keeps the plain surface when the build registers nothing for the asked value', () => {
    applyClickHouse();
    const { container } = render(<WelcomeBackdrop />);
    expect(container).toBeEmptyDOMElement();
  });

  it('paints the registered backdrop for the value the theme asks for', () => {
    const unregister = registerWelcomeBackdrop('dots', Dots);
    applyClickHouse();
    render(<WelcomeBackdrop />);
    expect(screen.getByTestId('dots-backdrop')).toBeInTheDocument();
    unregister();
  });

  it('follows a theme applied after mount and withdrawn again', async () => {
    const unregister = registerWelcomeBackdrop('dots', Dots);
    render(<WelcomeBackdrop />);
    expect(screen.queryByTestId('dots-backdrop')).toBeNull();

    await act(async () => {
      applyClickHouse();
      await Promise.resolve();
    });
    expect(screen.getByTestId('dots-backdrop')).toBeInTheDocument();

    await act(async () => {
      clearAppliedTheme();
      await Promise.resolve();
    });
    expect(screen.queryByTestId('dots-backdrop')).toBeNull();
    unregister();
  });

  it('stops painting a backdrop once it is unregistered', () => {
    const unregister = registerWelcomeBackdrop('dots', Dots);
    unregister();
    applyClickHouse();
    const { container } = render(<WelcomeBackdrop />);
    expect(container).toBeEmptyDOMElement();
  });
});
