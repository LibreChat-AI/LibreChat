import React from 'react';
import { render, screen } from '@testing-library/react';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, params?: Record<string, unknown>) =>
    `${key}:${params?.[0] ?? ''}`,
}));

import SkillPills from '../SkillPills';

describe('SkillPills', () => {
  it('renders nothing when skills is undefined', () => {
    const { container } = render(<SkillPills />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when skills is empty', () => {
    const { container } = render(<SkillPills skills={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders one pill per entry', () => {
    render(<SkillPills skills={['brand-guidelines', 'pptx']} />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('brand-guidelines');
    expect(items[1]).toHaveTextContent('pptx');
  });

  it('localizes the list aria-label (manual default)', () => {
    render(<SkillPills skills={['pptx']} />);
    expect(screen.getByRole('list')).toHaveAttribute('aria-label', 'com_ui_skills_manual_invoked:');
  });

  it('tags each pill with data-skill-source="manual" by default', () => {
    render(<SkillPills skills={['brand']} />);
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveAttribute('data-skill-source', 'manual');
  });

  it('switches aria-label and data attribute for source="always-apply"', () => {
    render(<SkillPills skills={['legal']} source="always-apply" />);
    expect(screen.getByRole('list')).toHaveAttribute(
      'aria-label',
      'com_ui_skills_always_apply_invoked:',
    );
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveAttribute('data-skill-source', 'always-apply');
  });

  it('renders the pin-icon variant for always-apply (no ScrollText)', () => {
    const { container: alwaysApply } = render(
      <SkillPills skills={['legal']} source="always-apply" />,
    );
    const { container: manual } = render(<SkillPills skills={['brand']} />);
    // lucide-react icons render as SVGs with distinguishing class names. We
    // assert on class token presence rather than the full SVG markup so a
    // lucide internal change to path data doesn't break this contract.
    const alwaysApplySvg = alwaysApply.querySelector('svg');
    const manualSvg = manual.querySelector('svg');
    expect(alwaysApplySvg).toBeTruthy();
    expect(manualSvg).toBeTruthy();
    // Pin vs. ScrollText have distinct lucide class names, but both use the
    // same semantic informational color.
    expect(alwaysApplySvg?.getAttribute('class')).toContain('lucide-pin');
    expect(manualSvg?.getAttribute('class')).not.toContain('lucide-pin');
    expect(alwaysApplySvg).toHaveClass('text-status-info');
    expect(manualSvg).toHaveClass('text-status-info');
  });
});
