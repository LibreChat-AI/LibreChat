/** @jest-environment jsdom */
import { render } from '@testing-library/react';
import { MessagePartsHostProvider } from '@librechat/chat/react';
import { AnimatedText, ThinkingContent } from '@librechat/chat/components';
import { createMessagePartsHost } from '../src/__fixtures__/partsHost';

test('a consumer supplies the canonical effect and settles without fade wrappers', () => {
  const host = createMessagePartsHost({
    renderStreamingText: (text) => <AnimatedText text={text} />,
  });
  const view = (animate: boolean) => (
    <MessagePartsHostProvider host={host}>
      <ThinkingContent animate={animate}>Checking the manifest</ThinkingContent>
    </MessagePartsHostProvider>
  );
  const { container, rerender } = render(view(true));
  expect(container.querySelectorAll('[data-lc-fade]')).toHaveLength(3);
  expect(container.textContent).toBe('Checking the manifest');
  rerender(view(false));
  expect(container.querySelector('[data-lc-fade]')).toBeNull();
  expect(container.textContent).toBe('Checking the manifest');
});
