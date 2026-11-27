import { JSX } from 'react/jsx-runtime';
import { cn } from '~/utils/';

export default function AzureMinimalIcon({
  size = 25,
  className = 'h-4 w-4',
}: {
  size?: number;
  className?: string;
}): JSX.Element {
  const height = size;
  const width = size;

  return (
    <svg
      stroke="currentColor"
      fill="none"
      strokeWidth="2"
      viewBox="0 0 24 24"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn(className, '')}
      width={width}
      height={height}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d="m8.0458 0.81981a1.1197 1.1197 0 0 0-1.0608 0.76184l-6.7912 20.123a1.1178 1.1178 0 0 0 1.0592 1.4751h5.4647a1.1197 1.1197 0 0 0 1.0608-0.7615l1.3528-4.0084-2.3684-2.2107a0.51536 0.51536 0 0 1 0.35193-0.8923h3.0639l1.8213-5.3966-2.8111-8.3294a1.1181 1.1181 0 0 0-1.0595-0.76049h-0.0836z" />
      <path d="m7.1147 15.307a0.51536 0.51536 0 0 0-0.35193 0.8923l7.1552 6.6782a1.1248 1.1248 0 0 0 0.76724 0.30238h0.2417a1.1181 1.1181 0 0 0 1.0534-1.4755l-2.1591-6.3974z" />
      <path d="m17.015 1.5807a1.1178 1.1178 0 0 0-1.0593-0.76049h-7.8258a1.1181 1.1181 0 0 1 1.0593 0.76049l6.7916 20.123a1.1181 1.1181 0 0 1-1.0593 1.4757h7.8261a1.1181 1.1181 0 0 0 1.059-1.4757z" />
    </svg>
  );
}
