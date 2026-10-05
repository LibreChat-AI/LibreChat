import { createContext, useContext } from 'react';
import type { ReactNode, Ref } from 'react';
import type { MediaDraftFormProps, MediaDraftForm } from './useMediaDraftForm';
import type { MediaFormActions } from './useMediaFormActions';
import type { MediaFormSelection } from './selection';
import type { MediaSend } from './state';
import { useMediaFormActions } from './useMediaFormActions';
import { useMediaDraftForm } from './useMediaDraftForm';
import FileDropArea from '~/components/Files/DropArea';
import { getMediaSelection } from './selection';
import { MediaComposer } from './Composer';
import { MediaSettings } from './Settings';

type FormProps = MediaDraftFormProps & {
  send: MediaSend;
  busy: boolean;
  composerRef?: Ref<HTMLTextAreaElement>;
  children?: ReactNode;
};
const Context = createContext<{
  form: MediaDraftForm;
  selection: MediaFormSelection | undefined;
  actions: MediaFormActions;
  send: MediaSend;
  busy: boolean;
  composerRef?: Ref<HTMLTextAreaElement>;
} | null>(null);

export function MediaFormSettings() {
  const context = useContext(Context);
  return context ? <MediaSettings form={context.form} selection={context.selection} /> : null;
}

export function MediaFormComposer() {
  const context = useContext(Context);
  return context ? <MediaComposer {...context} /> : null;
}

/** Owns normalization and uploads once while settings and composer share the same draft. */
export function MediaForm({ send, busy, children, composerRef, ...props }: FormProps) {
  const form = useMediaDraftForm(props);
  const selection = getMediaSelection(form);
  const actions = useMediaFormActions(form, selection, send, busy);
  return (
    <Context.Provider value={{ form, selection, actions, send, busy, composerRef }}>
      <FileDropArea
        className={children ? 'h-full min-h-0' : undefined}
        disabled={
          !form.host.canCreate ||
          actions.uploading ||
          !selection ||
          form.draft.inputs.length >= selection.uploadLimit
        }
        onFiles={(files) => void actions.uploadFiles(files)}
      >
        {children ?? (
          <div className="space-y-5">
            <MediaFormSettings />
            <MediaFormComposer />
          </div>
        )}
      </FileDropArea>
    </Context.Provider>
  );
}
