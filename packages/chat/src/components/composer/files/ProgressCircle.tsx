export default function ProgressCircle({
  circumference,
  offset,
}: {
  circumference: number;
  offset: number;
}): React.JSX.Element {
  return (
    <div className="bg-surface-media-overlay/5 text-text-on-media absolute inset-0 flex items-center justify-center">
      <svg width="120" height="120" viewBox="0 0 120 120" className="h-6 w-6">
        <circle
          className="stroke-border-heavy origin-[50%_50%] -rotate-90"
          strokeWidth="10"
          fill="transparent"
          r="55"
          cx="60"
          cy="60"
        />
        <circle
          className="transition-stroke-dashoffset origin-[50%_50%] -rotate-90 duration-300 ease-linear"
          stroke="currentColor"
          strokeWidth="10"
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={offset}
          fill="transparent"
          r="55"
          cx="60"
          cy="60"
        />
      </svg>
    </div>
  );
}
