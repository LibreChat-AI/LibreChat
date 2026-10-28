import CodeSetup from '~/components/Code/Setup';

export const codeSetupRoute = {
  path: 'code/setup/:attemptId',
  caseSensitive: true,
  element: <CodeSetup />,
};
