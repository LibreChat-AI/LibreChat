import { maxWorkers } from '../../config/jest.workers.cjs';

export default {
  collectCoverageFrom: ['src/**/*.{js,jsx,ts,tsx}', '!<rootDir>/node_modules/'],
  coveragePathIgnorePatterns: ['/node_modules/', '/dist/'],
  coverageReporters: ['text', 'cobertura'],
  testResultsProcessor: 'jest-junit',
  moduleNameMapper: {
    '^@src/(.*)$': '<rootDir>/src/$1',
    '^~/(.*)$': '<rootDir>/src/$1',
    '\\.(css|less|scss|sass)$': 'identity-obj-proxy',
  },
  // coverageThreshold: {
  //   global: {
  //     statements: 58,
  //     branches: 49,
  //     functions: 50,
  //     lines: 57,
  //   },
  // },
  maxWorkers,
  restoreMocks: true,
  testTimeout: 15000,
  // React component testing requires jsdom environment
  testEnvironment: 'jsdom',
  testEnvironmentOptions: { url: 'http://localhost:3080' },
  resolver: '<rootDir>/jest.resolver.cjs',
  transform: {
    '^.+\\.(ts|tsx|js|jsx)$': 'babel-jest',
  },
  transformIgnorePatterns: [
    'node_modules/(?!(@tanstack|lucide-react|lucide|morphicons|@dicebear|@ariakit/react-components|@ariakit/react-utils|@ariakit/react-store|@ariakit/components|@ariakit/store|@ariakit/utils)/)',
  ],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
};
