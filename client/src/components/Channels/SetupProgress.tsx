interface SetupProgressProps {
  steps: { label: string }[];
  /** The 1-based step the person is on. */
  current: number;
  label: string;
}

/** The setup wizard's header: a progress bar over the step labels, shared by every channel setup. */
export default function SetupProgress({ steps, current, label }: SetupProgressProps) {
  const progress = steps.length > 1 ? ((current - 1) / (steps.length - 1)) * 100 : 0;
  return (
    <div className="space-y-3">
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress)}
        className="bg-surface-tertiary h-1.5 overflow-hidden rounded-full"
      >
        <div
          className="bg-surface-inverted h-full rounded-full transition-all duration-500 ease-out motion-reduce:transition-none"
          style={{ width: `${progress}%` }}
        />
      </div>
      <ol className="flex justify-between text-xs">
        {steps.map((item, index) => (
          <li
            key={item.label}
            aria-current={index + 1 === current ? 'step' : undefined}
            className={
              index + 1 <= current ? 'text-text-primary font-medium' : 'text-text-secondary'
            }
          >
            {item.label}
          </li>
        ))}
      </ol>
    </div>
  );
}
