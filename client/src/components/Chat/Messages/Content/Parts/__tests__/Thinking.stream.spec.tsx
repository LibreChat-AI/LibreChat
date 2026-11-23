import { render, screen } from '@testing-library/react';
import { ThinkingContent } from '@librechat/chat/components';
import '~/Providers/MessagePartsHostContext';

/** The app host, registered by importing it, is what fades a live reasoning stream. */
describe('app reasoning stream', () => {
  it('fades streaming reasoning through the registered host', () => {
    const text = 'Hello there';
    render(<ThinkingContent animate>{text}</ThinkingContent>);
    expect(document.querySelector('[data-lc-fade]')).not.toBeNull();
    expect(screen.getByText(/Hello/)).toBeInTheDocument();
  });
});
