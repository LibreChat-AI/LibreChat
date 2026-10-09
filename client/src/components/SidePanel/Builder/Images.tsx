import ProgressCircle from '~/components/Chat/Input/Files/ProgressCircle';

export function NoImage() {
  return (
    <div className="border-border-medium flex h-full w-full items-center justify-center rounded-full border-2 border-dashed">
      <svg
        stroke="currentColor"
        fill="none"
        strokeWidth="2"
        viewBox="0 0 24 24"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-4xl"
        height="1em"
        width="1em"
        xmlns="http://www.w3.org/2000/svg"
      >
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
      </svg>
    </div>
  );
}

export const AssistantAvatar = ({
  url,
  progress = 1,
}: {
  url?: string;
  progress: number; // between 0 and 1
}) => {
  const radius = 55; // Radius of the SVG circle
  const circumference = 2 * Math.PI * radius;

  // Calculate the offset based on the loading progress
  const offset = circumference - progress * circumference;
  const circleCSSProperties = {
    transition: 'stroke-dashoffset 0.3s linear',
  };

  return (
    <div>
      <div className="relative h-20 w-20 overflow-hidden rounded-full">
        <img
          src={url}
          className="bg-avatar-placeholder h-full w-full rounded-full object-cover"
          alt="GPT"
          width="80"
          height="80"
          style={{ opacity: progress < 1 ? 0.4 : 1 }}
        />
        {progress < 1 && (
          <ProgressCircle
            circumference={circumference}
            offset={offset}
            circleCSSProperties={circleCSSProperties}
          />
        )}
      </div>
    </div>
  );
};
