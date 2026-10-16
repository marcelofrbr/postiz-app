import type { Config } from 'jest';

const config: Config = {
  displayName: 'nestjs-libraries',
  testEnvironment: 'node',
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      // 7030 (noImplicitReturns) so aparece em codigo herdado do Postiz oficial
      { diagnostics: { ignoreCodes: [7030] } },
    ],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  rootDir: '.',
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  moduleNameMapper: {
    '^@gitroom/nestjs-libraries/(.*)$': '<rootDir>/src/$1',
    '^@gitroom/helpers/(.*)$': '<rootDir>/../../libraries/helpers/src/$1',
    '^@gitroom/backend/(.*)$': '<rootDir>/../../apps/backend/src/$1',
    '^file-type$': '<rootDir>/../../jest-mocks/file-type.js',
    '^isomorphic-dompurify$':
      '<rootDir>/../../jest-mocks/isomorphic-dompurify.js',
  },
};

export default config;
