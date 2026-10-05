import { X } from 'lucide-react';
import { Button, ControlCombobox } from '@librechat/client';
import { mediaInputRoleSchema } from 'librechat-data-provider';
import type { MediaDraftForm } from './useMediaDraftForm';
import { mediaInputRoleLabels } from './labels';
import { MediaPreview } from './Asset';
export function MediaReferences({ form }: { form: MediaDraftForm }) {
  const { portal, localize, draft, automaticReference, capability, change } = form;
  return (
    draft.inputs.length > 0 && (
      <ul
        className="flex max-h-40 flex-wrap gap-2 overflow-y-auto"
        aria-label={localize('com_media_references')}
      >
        {draft.inputs.map((input, index) => {
          const asset = draft.assets.find((item) => item.file_id === input.file_id);
          const playable = asset?.type.startsWith('audio/') || asset?.type.startsWith('video/');
          return (
            <li
              key={`${input.file_id}:${index}`}
              className={`border-border-light flex w-full items-center gap-2 rounded-xl border p-2 sm:w-72 ${playable ? 'flex-wrap' : ''}`}
            >
              {asset && (
                <span
                  className={`${playable ? 'w-full' : 'w-14'} shrink-0 overflow-hidden rounded-lg`}
                >
                  <MediaPreview asset={asset} compact interactive={!!playable} />
                </span>
              )}
              <div className="min-w-0 flex-1">
                {automaticReference ? (
                  <p role="status" className="text-text-secondary text-sm">
                    {localize(
                      draft.operation === 'video.generate'
                        ? 'com_media_using_latest_video'
                        : 'com_media_editing_latest',
                    )}
                  </p>
                ) : (
                  <ControlCombobox
                    showCarat
                    ariaLabel={localize('com_media_input_role')}
                    variant="field"
                    isCollapsed={false}
                    portal={portal}
                    selectedValue={input.role}
                    displayValue={localize(mediaInputRoleLabels[input.role])}
                    disabled={!capability}
                    items={(capability?.inputs.roles ?? [input.role])
                      .filter((role) => {
                        if (asset?.type.startsWith('audio/')) return role === 'audio';
                        if (asset?.type.startsWith('video/')) return role === 'video';
                        return role !== 'audio' && role !== 'video';
                      })
                      .map((role) => ({
                        value: role,
                        label: localize(mediaInputRoleLabels[role]),
                      }))}
                    setValue={(value) => {
                      const role = mediaInputRoleSchema.safeParse(value);
                      if (!role.success) return;
                      change({
                        inputs: draft.inputs.map((item, at) =>
                          at === index ? { ...item, role: role.data } : item,
                        ),
                      });
                    }}
                  />
                )}
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={localize('com_media_remove_reference')}
                onClick={() =>
                  change({
                    inputs: draft.inputs.filter((_, at) => at !== index),
                    assets: draft.assets.filter((item) => item.file_id !== input.file_id),
                    parentTurnId: index === 0 ? undefined : draft.parentTurnId,
                    autoEdit: false,
                    operation:
                      draft.inputs.length === 1 && draft.operation === 'image.edit'
                        ? 'image.generate'
                        : draft.operation,
                  })
                }
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </li>
          );
        })}
      </ul>
    )
  );
}
