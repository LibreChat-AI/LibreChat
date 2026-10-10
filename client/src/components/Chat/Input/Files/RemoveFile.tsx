import { useLocalize } from '~/hooks';

export default function RemoveFile({
  onRemove,
  label,
  disabled = false,
}: {
  onRemove: () => void;
  disabled?: boolean;
  /** Names the file, where several chips sit side by side and "Remove file" would not say which. */
  label?: string;
}) {
  const localize = useLocalize();
  return (
    <button
      type="button"
      data-remove-file
      className="bg-surface-secondary hover:bg-surface-primary absolute top-1 right-1 translate-x-1/2 -translate-y-1/2 rounded-full p-0.5 transition-colors duration-200"
      onClick={onRemove}
      disabled={disabled}
      aria-label={label ?? localize('com_ui_attach_remove')}
    >
      <span aria-hidden="true">
        <svg
          stroke="currentColor"
          fill="none"
          strokeWidth="2"
          viewBox="0 0 24 24"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="icon-sm"
          xmlns="http://www.w3.org/2000/svg"
          width="32"
          height="32"
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </span>
    </button>
  );
}
