import React from 'react';
import { QueryKeys } from 'librechat-data-provider';
import { Controller, useForm } from 'react-hook-form';
import { useQueryClient } from '@tanstack/react-query';
import { Checkbox, FieldMessage, Label, TextareaAutosize, Input } from '@librechat/client';
import type { TConversationTag, TConversationTagRequest } from 'librechat-data-provider';
import { useBookmarkContext } from '~/Providers/BookmarkContext';
import { useConversationTagMutation } from '~/data-provider';
import { useLocalize } from '~/hooks';
import { cn, logger } from '~/utils';

type TBookmarkFormProps = {
  tags?: string[];
  bookmark?: TConversationTag;
  conversationId?: string;
  formRef: React.RefObject<HTMLFormElement>;
  mutation: ReturnType<typeof useConversationTagMutation>;
};
const BookmarkForm = ({
  tags,
  bookmark,
  mutation,
  conversationId,
  formRef,
}: TBookmarkFormProps) => {
  const localize = useLocalize();
  const queryClient = useQueryClient();
  const { bookmarks } = useBookmarkContext();

  const {
    register,
    handleSubmit,
    setValue,
    getValues,
    control,
    formState: { errors },
  } = useForm<TConversationTagRequest>({
    mode: 'onBlur',
    reValidateMode: 'onChange',
    defaultValues: {
      tag: bookmark?.tag ?? '',
      description: bookmark?.description ?? '',
      conversationId: conversationId ?? '',
      addToConversation: conversationId != null && conversationId ? true : false,
    },
  });

  const [prevBookmark, setPrevBookmark] = React.useState(bookmark);

  if (bookmark !== prevBookmark) {
    setPrevBookmark(bookmark);
    if (bookmark?.tag != null && bookmark.tag !== '') {
      setValue('tag', bookmark.tag);
      setValue('description', bookmark.description ?? '');
    }
  }

  /** Every source that could already hold the title, checked before the request is sent. */
  const isTagTaken = (value: string) => {
    const allTags =
      queryClient.getQueryData<TConversationTag[]>([QueryKeys.conversationTags]) ?? [];

    return (
      (tags ?? []).includes(value) ||
      allTags.some((tag) => tag.tag === value) ||
      bookmarks.some((existing) => existing.tag === value)
    );
  };

  const onSubmit = (data: TConversationTagRequest) => {
    logger.log('tag_mutation', 'BookmarkForm - onSubmit: data', data);
    if (mutation.isLoading) {
      return;
    }
    if (data.tag === bookmark?.tag && data.description === bookmark?.description) {
      return;
    }

    mutation.mutate(data);
  };

  return (
    <form ref={formRef} aria-label="Bookmark form" method="POST" onSubmit={handleSubmit(onSubmit)}>
      <div className="space-y-4">
        {/* Tag name input */}
        <div className="space-y-2">
          <Label htmlFor="bookmark-tag" className="text-text-primary text-sm font-medium">
            {localize('com_ui_bookmarks_title')}
          </Label>
          <Input
            type="text"
            id="bookmark-tag"
            aria-label={localize('com_ui_bookmarks_title')}
            {...register('tag', {
              required: localize('com_ui_field_required'),
              maxLength: {
                value: 128,
                message: localize('com_ui_field_max_length', {
                  field: localize('com_ui_bookmarks_title'),
                  length: 128,
                }),
              },
              validate: (value) => {
                if (value == null || value === '' || value === bookmark?.tag) {
                  return true;
                }
                return !isTagTaken(value) || localize('com_ui_bookmarks_tag_exists');
              },
            })}
            className="w-full"
            aria-invalid={!!errors.tag}
            placeholder={localize('com_ui_enter_name')}
            aria-describedby="bookmark-tag-error"
          />
          <FieldMessage id="bookmark-tag-error" message={errors.tag?.message} />
        </div>

        {/* Description textarea */}
        <div className="space-y-2">
          <Label
            id="bookmark-description-label"
            htmlFor="bookmark-description"
            className="text-text-primary text-sm font-medium"
          >
            {localize('com_ui_bookmarks_description')}
          </Label>
          <TextareaAutosize
            focusOutline="hidden"
            {...register('description', {
              maxLength: {
                value: 1048,
                message: localize('com_ui_field_max_length', {
                  field: localize('com_ui_bookmarks_description'),
                  length: 1048,
                }),
              },
            })}
            id="bookmark-description"
            disabled={false}
            placeholder={localize('com_ui_enter_description')}
            className={cn(
              'border-border-light min-h-[100px] w-full resize-none rounded-lg border',
              'text-text-primary bg-transparent px-3 py-2 text-sm',
              'placeholder:text-text-tertiary',
              'focus-visible:ring-border-heavy focus-visible:ring-1',
            )}
            aria-labelledby="bookmark-description-label"
            aria-invalid={!!errors.description}
            aria-describedby="bookmark-description-error"
          />
          <FieldMessage id="bookmark-description-error" message={errors.description?.message} />
        </div>

        {/* Add to conversation checkbox */}
        {conversationId != null && conversationId && (
          <div className="flex items-center gap-2">
            <Controller
              name="addToConversation"
              control={control}
              render={({ field }) => (
                <Checkbox
                  {...field}
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  className="size-4 cursor-pointer"
                  value={field.value?.toString()}
                  aria-label={localize('com_ui_bookmarks_add_to_conversation')}
                />
              )}
            />
            <button
              type="button"
              aria-label={localize('com_ui_bookmarks_add_to_conversation')}
              className="text-text-primary cursor-pointer text-sm"
              onClick={() =>
                setValue('addToConversation', !(getValues('addToConversation') ?? false), {
                  shouldDirty: true,
                })
              }
            >
              {localize('com_ui_bookmarks_add_to_conversation')}
            </button>
          </div>
        )}
      </div>
    </form>
  );
};

export default BookmarkForm;
