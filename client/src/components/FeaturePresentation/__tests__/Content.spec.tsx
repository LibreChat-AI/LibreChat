import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { featureContent } from '../Content';

jest.mock('@librechat/chat/react', () => ({
  ChatProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
jest.mock('~/Providers/ChatFormContext', () => ({
  ChatFormProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
jest.mock('../Actions', () => () => null);
jest.mock('~/components/Prompts/sidebar/PromptsAccordion', () => ({
  __esModule: true,
  default: ({ isChatRoute }: { isChatRoute: boolean }) => (
    <div data-testid="prompt-mode" data-chat={String(isChatRoute)} />
  ),
}));

it.each([
  ['/c/chat-a', true],
  ['/prompts', false],
  ['/prompts/prompt-a', false],
  ['/skills/skill-a/edit', false],
])('uses the actual %s route for prompt selection mode', (path, chat) => {
  const Prompts = featureContent.prompts;
  render(
    <MemoryRouter initialEntries={[String(path)]}>
      <Prompts visible />
    </MemoryRouter>,
  );
  expect(screen.getByTestId('prompt-mode')).toHaveAttribute('data-chat', String(chat));
});
