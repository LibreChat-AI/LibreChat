import React, { createRef } from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom/extend-expect';
import type { TConversationTag } from 'librechat-data-provider';
import BookmarkForm from '../BookmarkForm';

const mockMutate = jest.fn();
const mockShowToast = jest.fn();
const mockGetQueryData = jest.fn();

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, params?: Record<string, unknown>) => {
    const translations: Record<string, string> = {
      com_ui_bookmarks_title: 'Title',
      com_ui_bookmarks_description: 'Description',
      com_ui_bookmarks_edit: 'Edit Bookmark',
      com_ui_bookmarks_new: 'New Bookmark',
      com_ui_bookmarks_create_exists: 'This bookmark already exists',
      com_ui_bookmarks_add_to_conversation: 'Add to current conversation',
      com_ui_bookmarks_tag_exists: 'A bookmark with this title already exists',
      com_ui_field_required: 'This field is required',
      com_ui_field_max_length: `${params?.field || 'Field'} must be less than ${params?.length || 0} characters`,
    };
    return translations[key] || key;
  },
}));

jest.mock('@librechat/client', () => {
  const ActualReact = jest.requireActual<typeof import('react')>('react');
  return {
    Checkbox: ({
      checked,
      onCheckedChange,
      value,
      ...props
    }: {
      checked: boolean;
      onCheckedChange: (checked: boolean) => void;
      value: string;
    }) =>
      ActualReact.createElement('input', {
        type: 'checkbox',
        checked,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => onCheckedChange(e.target.checked),
        value,
        ...props,
      }),
    Label: ({ children, ...props }: { children: React.ReactNode }) =>
      ActualReact.createElement('label', props, children),
    FieldMessage: ({
      id,
      message,
      hint,
    }: {
      id: string;
      message?: string | null;
      hint?: string | null;
    }) =>
      ActualReact.createElement(
        'p',
        { id, role: message ? 'alert' : undefined },
        message || hint || '',
      ),
    TextareaAutosize: ActualReact.forwardRef<
      HTMLTextAreaElement,
      React.TextareaHTMLAttributes<HTMLTextAreaElement>
    >((props, ref) => ActualReact.createElement('textarea', { ref, ...props })),
    Input: ActualReact.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
      (props, ref) => ActualReact.createElement('input', { ref, ...props }),
    ),
    useToastContext: () => ({
      showToast: mockShowToast,
    }),
  };
});

jest.mock('~/Providers/BookmarkContext', () => ({
  useBookmarkContext: () => ({
    bookmarks: [],
  }),
}));

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    getQueryData: mockGetQueryData,
  }),
}));

jest.mock('~/utils', () => ({
  cn: (...classes: (string | undefined | null | boolean)[]) => classes.filter(Boolean).join(' '),
  logger: {
    log: jest.fn(),
  },
}));

const createMockBookmark = (overrides?: Partial<TConversationTag>): TConversationTag => ({
  _id: 'bookmark-1',
  user: 'user-1',
  tag: 'Test Bookmark',
  description: 'Test description',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  count: 1,
  position: 0,
  ...overrides,
});

const createMockMutation = (isLoading = false) => ({
  mutate: mockMutate,
  isLoading,
  isError: false,
  isSuccess: false,
  data: undefined,
  error: null,
  reset: jest.fn(),
  mutateAsync: jest.fn(),
  status: 'idle' as const,
  variables: undefined,
  context: undefined,
  failureCount: 0,
  failureReason: null,
  isPaused: false,
  isIdle: true,
  submittedAt: 0,
});

describe('BookmarkForm - Bookmark Editing', () => {
  const formRef = createRef<HTMLFormElement>();

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetQueryData.mockReturnValue([]);
  });

  describe('Editing only the description (tag unchanged)', () => {
    it('should allow submitting when only the description is changed', async () => {
      const existingBookmark = createMockBookmark({
        tag: 'My Bookmark',
        description: 'Original description',
      });

      mockGetQueryData.mockReturnValue([existingBookmark]);

      render(
        <BookmarkForm
          bookmark={existingBookmark}
          mutation={
            createMockMutation() as ReturnType<
              typeof import('~/data-provider').useConversationTagMutation
            >
          }
          formRef={formRef}
        />,
      );

      const descriptionInput = screen.getByRole('textbox', { name: /description/i });

      await act(async () => {
        fireEvent.change(descriptionInput, { target: { value: 'Updated description' } });
      });

      await act(async () => {
        fireEvent.submit(formRef.current!);
      });

      await waitFor(() => {
        expect(mockMutate).toHaveBeenCalledWith(
          expect.objectContaining({
            tag: 'My Bookmark',
            description: 'Updated description',
          }),
        );
      });
      expect(mockShowToast).not.toHaveBeenCalled();
    });

    it('should not submit when both tag and description are unchanged', async () => {
      const existingBookmark = createMockBookmark({
        tag: 'My Bookmark',
        description: 'Same description',
      });

      mockGetQueryData.mockReturnValue([existingBookmark]);

      render(
        <BookmarkForm
          bookmark={existingBookmark}
          mutation={
            createMockMutation() as ReturnType<
              typeof import('~/data-provider').useConversationTagMutation
            >
          }
          formRef={formRef}
        />,
      );

      await act(async () => {
        fireEvent.submit(formRef.current!);
      });

      await waitFor(() => {
        expect(mockMutate).not.toHaveBeenCalled();
      });
    });
  });

  describe('Renaming a tag to an existing tag (should show inline error)', () => {
    it('should show an inline error when renaming to an existing tag name (via allTags)', async () => {
      const existingBookmark = createMockBookmark({
        tag: 'Original Tag',
        description: 'Description',
      });

      const otherBookmark = createMockBookmark({
        _id: 'bookmark-2',
        tag: 'Existing Tag',
        description: 'Other description',
      });

      mockGetQueryData.mockReturnValue([existingBookmark, otherBookmark]);

      render(
        <BookmarkForm
          bookmark={existingBookmark}
          mutation={
            createMockMutation() as ReturnType<
              typeof import('~/data-provider').useConversationTagMutation
            >
          }
          formRef={formRef}
        />,
      );

      const tagInput = screen.getByLabelText('Title');

      await act(async () => {
        fireEvent.change(tagInput, { target: { value: 'Existing Tag' } });
      });

      await act(async () => {
        fireEvent.submit(formRef.current!);
      });

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent(
          'A bookmark with this title already exists',
        );
      });
      expect(mockShowToast).not.toHaveBeenCalled();
      expect(mockMutate).not.toHaveBeenCalled();
    });

    it('should show an inline error when renaming to an existing tag name (via tags prop)', async () => {
      const existingBookmark = createMockBookmark({
        tag: 'Original Tag',
        description: 'Description',
      });

      mockGetQueryData.mockReturnValue([existingBookmark]);

      render(
        <BookmarkForm
          tags={['Existing Tag', 'Another Tag']}
          bookmark={existingBookmark}
          mutation={
            createMockMutation() as ReturnType<
              typeof import('~/data-provider').useConversationTagMutation
            >
          }
          formRef={formRef}
        />,
      );

      const tagInput = screen.getByLabelText('Title');

      await act(async () => {
        fireEvent.change(tagInput, { target: { value: 'Existing Tag' } });
      });

      await act(async () => {
        fireEvent.submit(formRef.current!);
      });

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent(
          'A bookmark with this title already exists',
        );
      });
      expect(mockShowToast).not.toHaveBeenCalled();
      expect(mockMutate).not.toHaveBeenCalled();
    });
  });

  describe('Renaming a tag to a new tag (should succeed)', () => {
    it('should allow renaming to a completely new tag name', async () => {
      const existingBookmark = createMockBookmark({
        tag: 'Original Tag',
        description: 'Description',
      });

      mockGetQueryData.mockReturnValue([existingBookmark]);

      render(
        <BookmarkForm
          bookmark={existingBookmark}
          mutation={
            createMockMutation() as ReturnType<
              typeof import('~/data-provider').useConversationTagMutation
            >
          }
          formRef={formRef}
        />,
      );

      const tagInput = screen.getByLabelText('Title');

      await act(async () => {
        fireEvent.change(tagInput, { target: { value: 'Brand New Tag' } });
      });

      await act(async () => {
        fireEvent.submit(formRef.current!);
      });

      await waitFor(() => {
        expect(mockMutate).toHaveBeenCalledWith(
          expect.objectContaining({
            tag: 'Brand New Tag',
            description: 'Description',
          }),
        );
      });
      expect(mockShowToast).not.toHaveBeenCalled();
    });

    it('should allow keeping the same tag name when editing (not trigger duplicate error)', async () => {
      const existingBookmark = createMockBookmark({
        tag: 'My Bookmark',
        description: 'Original description',
      });

      mockGetQueryData.mockReturnValue([existingBookmark]);

      render(
        <BookmarkForm
          bookmark={existingBookmark}
          mutation={
            createMockMutation() as ReturnType<
              typeof import('~/data-provider').useConversationTagMutation
            >
          }
          formRef={formRef}
        />,
      );

      const descriptionInput = screen.getByRole('textbox', { name: /description/i });

      await act(async () => {
        fireEvent.change(descriptionInput, { target: { value: 'New description' } });
      });

      await act(async () => {
        fireEvent.submit(formRef.current!);
      });

      await waitFor(() => {
        expect(mockMutate).toHaveBeenCalledWith(
          expect.objectContaining({
            tag: 'My Bookmark',
            description: 'New description',
          }),
        );
      });
      expect(mockShowToast).not.toHaveBeenCalled();
    });
  });

  describe('Validation interaction between different data sources', () => {
    it('should check both tags prop and allTags query data for duplicates', async () => {
      const existingBookmark = createMockBookmark({
        tag: 'Original Tag',
        description: 'Description',
      });

      const queryDataBookmark = createMockBookmark({
        _id: 'bookmark-query',
        tag: 'Query Data Tag',
      });

      mockGetQueryData.mockReturnValue([existingBookmark, queryDataBookmark]);

      render(
        <BookmarkForm
          tags={['Props Tag']}
          bookmark={existingBookmark}
          mutation={
            createMockMutation() as ReturnType<
              typeof import('~/data-provider').useConversationTagMutation
            >
          }
          formRef={formRef}
        />,
      );

      const tagInput = screen.getByLabelText('Title');

      await act(async () => {
        fireEvent.change(tagInput, { target: { value: 'Props Tag' } });
      });

      await act(async () => {
        fireEvent.submit(formRef.current!);
      });

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent(
          'A bookmark with this title already exists',
        );
      });
      expect(mockShowToast).not.toHaveBeenCalled();
      expect(mockMutate).not.toHaveBeenCalled();
    });

    it('should not trigger mutation when mutation is loading', async () => {
      const existingBookmark = createMockBookmark({
        tag: 'My Bookmark',
        description: 'Description',
      });

      mockGetQueryData.mockReturnValue([existingBookmark]);

      render(
        <BookmarkForm
          bookmark={existingBookmark}
          mutation={
            createMockMutation(true) as ReturnType<
              typeof import('~/data-provider').useConversationTagMutation
            >
          }
          formRef={formRef}
        />,
      );

      const descriptionInput = screen.getByRole('textbox', { name: /description/i });

      await act(async () => {
        fireEvent.change(descriptionInput, { target: { value: 'Updated description' } });
      });

      await act(async () => {
        fireEvent.submit(formRef.current!);
      });

      await waitFor(() => {
        expect(mockMutate).not.toHaveBeenCalled();
      });
    });

    it('should handle empty allTags gracefully', async () => {
      const existingBookmark = createMockBookmark({
        tag: 'My Bookmark',
        description: 'Description',
      });

      mockGetQueryData.mockReturnValue(null);

      render(
        <BookmarkForm
          bookmark={existingBookmark}
          mutation={
            createMockMutation() as ReturnType<
              typeof import('~/data-provider').useConversationTagMutation
            >
          }
          formRef={formRef}
        />,
      );

      const tagInput = screen.getByLabelText('Title');

      await act(async () => {
        fireEvent.change(tagInput, { target: { value: 'New Tag' } });
      });

      await act(async () => {
        fireEvent.submit(formRef.current!);
      });

      await waitFor(() => {
        expect(mockMutate).toHaveBeenCalledWith(
          expect.objectContaining({
            tag: 'New Tag',
          }),
        );
      });
    });
  });
});
