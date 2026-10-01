import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import type t from 'librechat-data-provider';
import { getAgentAvatarUrl, renderAgentAvatar, getContactDisplayName } from '../agents';

// Mock the Feather icon from lucide-react
jest.mock('lucide-react', () => ({
  Feather: ({ className, strokeWidth, ...props }: any) => (
    <svg
      data-testid="feather-icon"
      className={className}
      data-stroke-width={strokeWidth}
      {...props}
    >
      <title>{/* eslint-disable-line i18next/no-literal-string */}Feather Icon</title>
    </svg>
  ),
}));

describe('Agent Utilities', () => {
  describe('getAgentAvatarUrl', () => {
    it('should return null for null agent', () => {
      expect(getAgentAvatarUrl(null)).toBeNull();
    });

    it('should return null for undefined agent', () => {
      expect(getAgentAvatarUrl(undefined)).toBeNull();
    });

    it('should return null for agent without avatar', () => {
      const agent = { id: '1', name: 'Test Agent' } as t.Agent;
      expect(getAgentAvatarUrl(agent)).toBeNull();
    });

    it('should return string avatar directly', () => {
      const agent = {
        id: '1',
        name: 'Test Agent',
        avatar: '/path/to/avatar.png',
      } as unknown as t.Agent;
      expect(getAgentAvatarUrl(agent)).toBe('/path/to/avatar.png');
    });

    it('should extract filepath from object avatar', () => {
      const agent = {
        id: '1',
        name: 'Test Agent',
        avatar: { filepath: '/path/to/object-avatar.png' },
      } as t.Agent;
      expect(getAgentAvatarUrl(agent)).toBe('/path/to/object-avatar.png');
    });

    it('should return null for object avatar without filepath', () => {
      const agent = {
        id: '1',
        name: 'Test Agent',
        avatar: { someOtherProperty: 'value' },
      } as any;
      expect(getAgentAvatarUrl(agent)).toBeNull();
    });
  });

  describe('renderAgentAvatar', () => {
    it('should render image when avatar URL exists', () => {
      const agent = {
        id: '1',
        name: 'Test Agent',
        avatar: '/test-avatar.png',
      } as unknown as t.Agent;

      render(<div>{renderAgentAvatar(agent)}</div>);

      const img = screen.getByAltText('Test Agent avatar');
      expect(img).toBeInTheDocument();
      expect(img).toHaveAttribute('src', '/test-avatar.png');
      expect(img).toHaveClass('rounded-full', 'object-cover', 'shadow-lg');
    });

    it('should render Feather icon fallback when no avatar', () => {
      const agent = {
        id: '1',
        name: 'Test Agent',
      } as t.Agent;

      render(<div>{renderAgentAvatar(agent)}</div>);

      const featherIcon = screen.getByTestId('feather-icon');
      expect(featherIcon).toBeInTheDocument();
      expect(featherIcon).toHaveAttribute('data-stroke-width', '1.5');
    });

    it('should apply different size classes', () => {
      const agent = {
        id: '1',
        name: 'Test Agent',
        avatar: '/test-avatar.png',
      } as unknown as t.Agent;

      const { rerender } = render(<div>{renderAgentAvatar(agent, { size: 'sm' })}</div>);
      expect(screen.getByAltText('Test Agent avatar')).toHaveClass('h-12', 'w-12');

      rerender(<div>{renderAgentAvatar(agent, { size: 'lg' })}</div>);
      expect(screen.getByAltText('Test Agent avatar')).toHaveClass('h-20', 'w-20');

      rerender(<div>{renderAgentAvatar(agent, { size: 'xl' })}</div>);
      expect(screen.getByAltText('Test Agent avatar')).toHaveClass('h-24', 'w-24');
    });

    it('should apply custom className', () => {
      const agent = {
        id: '1',
        name: 'Test Agent',
        avatar: '/test-avatar.png',
      } as unknown as t.Agent;

      render(<div>{renderAgentAvatar(agent, { className: 'custom-class' })}</div>);

      const container = screen.getByAltText('Test Agent avatar').parentElement;
      expect(container).toHaveClass('custom-class');
    });
  });

  describe('getContactDisplayName', () => {
    it('should return null for null agent', () => {
      expect(getContactDisplayName(null)).toBeNull();
    });

    it('should return null for undefined agent', () => {
      expect(getContactDisplayName(undefined)).toBeNull();
    });

    it('should prioritize support_contact name', () => {
      const agent = {
        id: '1',
        support_contact: { name: 'Support Team', email: 'support@example.com' },
        authorName: 'John Doe',
      } as any;
      expect(getContactDisplayName(agent)).toBe('Support Team');
    });

    it('should use authorName when support_contact name is missing', () => {
      const agent = {
        id: '1',
        support_contact: { email: 'support@example.com' },
        authorName: 'John Doe',
      } as any;
      expect(getContactDisplayName(agent)).toBe('John Doe');
    });

    it('should use support_contact email when both name and authorName are missing', () => {
      const agent = {
        id: '1',
        support_contact: { email: 'support@example.com' },
      } as any;
      expect(getContactDisplayName(agent)).toBe('support@example.com');
    });

    it('should return null when no contact info is available', () => {
      const agent = {
        id: '1',
        name: 'Test Agent',
      } as any;
      expect(getContactDisplayName(agent)).toBeNull();
    });
  });

  // Tests for hardcoded category functions removed - now using database-driven categories
});
