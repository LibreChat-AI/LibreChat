import fs from 'fs';
import { ContentTypes } from 'librechat-data-provider';
import { render, screen } from '@testing-library/react';
import { PhaseLabel as PackagePhaseLabel, FOLD_EASING } from '@librechat/chat/components';
import type { TMessageContentParts } from 'librechat-data-provider';
import ActivityPhaseGroup, { PhaseLabel } from '../ActivityPhaseGroup';

jest.mock('~/hooks/Messages/useSmoothStreaming', () => ({
  __esModule: true,
  default: () => true,
}));

jest.mock('~/hooks/MCP', () => ({
  useMCPIconMap: () => new Map(),
  useMCPServerNames: () => [],
}));

/** The package's parts read the localizer from the client package. */
jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/components/MCPUIResource', () => ({
  MCPAppViews: () => null,
}));

const LABEL = 'Compared both release paths';
const NEXT_LABEL = 'Confirmed the rollback path is clean';

const labelPart: Extract<TMessageContentParts, { type: ContentTypes.ACTIVITY_LABEL }> = {
  type: ContentTypes.ACTIVITY_LABEL,
  activity_label: LABEL,
  activity_label_type: 'phase',
  activity_start_index: 0,
  pending: false,
};

/** The phase group's own cases live with it in `packages/chat`. These two are the app's: its
 *  re-export, and the markup the browser lane asks this file to save. */
describe('ActivityPhaseGroup', () => {
  test('preserves the package ticker export for existing tool group consumers', () => {
    expect(PhaseLabel).toBe(PackagePhaseLabel);
  });

  test('exports real phase consumers for the browser cascade checks', () => {
    const ticker = render(<PhaseLabel text={LABEL} animate live />);
    ticker.rerender(<PhaseLabel text={NEXT_LABEL} animate live />);
    expect(ticker.container.querySelector('.animate-out')).toHaveAttribute('aria-hidden', 'true');
    const tickerMarkup = ticker.container.innerHTML;
    ticker.unmount();

    const entrance = render(
      <ActivityPhaseGroup labelPart={labelPart} hasContent={false} animateEntrance>
        <div />
      </ActivityPhaseGroup>,
    );
    for (const name of FOLD_EASING.split(' ')) {
      expect(screen.getByTestId('activity-phase-card')).toHaveClass(name);
    }
    const entranceMarkup = entrance.container.innerHTML;
    entrance.unmount();

    const reduced = render(<PhaseLabel text={LABEL} animate={false} live />);
    reduced.rerender(<PhaseLabel text={NEXT_LABEL} animate={false} live />);
    expect(reduced.container.querySelector('.animate-in, .animate-out')).toBeNull();
    const fixturePath = process.env.E2E_PHASE_CASCADE_FIXTURE;
    if (fixturePath) {
      fs.writeFileSync(
        fixturePath,
        JSON.stringify({
          ticker: tickerMarkup,
          entrance: entranceMarkup,
          reduced: reduced.container.innerHTML,
        }),
      );
    }
  });
});
