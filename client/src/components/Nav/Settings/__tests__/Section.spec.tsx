import { render, screen } from '@testing-library/react';
import Section from '../Section';

describe('Settings Section', () => {
  it('stays hidden until one of its rows has content, so an empty section draws no heading', () => {
    render(
      <Section heading="Connected accounts">
        <div data-settings-row className="empty:hidden" />
      </Section>,
    );

    const section = screen.getByText('Connected accounts').closest('section');
    expect(section).toHaveClass('hidden');
    expect(section?.className).toContain('has-[[data-settings-row]:not(:empty)]:block');
  });

  it('renders its heading and rows', () => {
    render(
      <Section heading="Connected accounts">
        <div data-settings-row>{'row content'}</div>
      </Section>,
    );

    expect(screen.getByRole('heading', { name: 'Connected accounts' })).toBeInTheDocument();
    expect(screen.getByText('row content')).toBeInTheDocument();
  });
});
