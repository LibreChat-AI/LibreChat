import { render, screen } from '@testing-library/react';
import SpecDescription from '../SpecDescription';

describe('SpecDescription', () => {
  it('renders nothing without a description', () => {
    const { container } = render(<SpecDescription />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders plain text descriptions without interpreting markup', () => {
    render(<SpecDescription description="Fast & accurate < 1s responses" />);

    expect(screen.getByText('Fast & accurate < 1s responses')).toBeInTheDocument();
  });

  it('renders HTML descriptions with inline images', () => {
    const { container } = render(
      <SpecDescription description='<span>Powered by <img src="/assets/claude.png" alt="Claude" /> Claude</span>' />,
    );

    const image = container.querySelector('img');
    expect(image).toHaveAttribute('src', '/assets/claude.png');
    expect(image).toHaveAttribute('alt', 'Claude');
    expect(container).toHaveTextContent('Powered by Claude');
  });

  it('strips scripts, event handlers, and unsafe URLs from HTML descriptions', () => {
    const { container } = render(
      <SpecDescription description='<span onclick="alert(1)">Safe<script>alert(1)</script><img src="javascript:alert(1)" onerror="alert(1)"></span>' />,
    );

    expect(container).toHaveTextContent('Safe');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('[onclick]')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
    expect(container.querySelector('img')?.getAttribute('src') ?? '').not.toContain('javascript');
  });
});
