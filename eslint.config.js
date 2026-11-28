// ESLint flat config. Conservative ruleset for 0.1.0.
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

const restrictedImportsForDomain = {
  paths: [
    {
      name: 'playwright',
      message: 'Domain / capability / evidence layers must not depend on Playwright.',
    },
    {
      name: '@anthropic-ai/sdk',
      message: 'Use the fetch-based provider adapter under src/reasoner/providers/.',
    },
    {
      name: 'openai',
      message: 'Use the fetch-based provider adapter under src/reasoner/providers/.',
    },
    {
      name: 'langchain',
      message: 'Use the fetch-based provider adapter under src/reasoner/providers/.',
    },
  ],
  patterns: [
    {
      group: ['playwright/*', '@playwright/*'],
      message: 'Domain layer must not reach into Playwright.',
    },
    {
      group: ['@anthropic-ai/*'],
      message: 'Use the fetch-based provider adapter under src/reasoner/providers/.',
    },
  ],
};

export default [
  {
    ignores: ['dist/**', 'node_modules/**', '.tmp/**', 'coverage/**', 'runs/**'],
  },
  {
    // `examples/**` is listed because `eslint .` reports a green run
    // even when every matched file is ignored. Leaving it out made the
    // versioned-environment example pass lint without ever being
    // checked, which is the same "zero files, still a pass" shape as
    // the broken `test:unit` / `test:e2e` scripts.
    files: ['src/**/*.ts', 'test/**/*.ts', 'examples/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
      'eqeqeq': ['error', 'always'],
    },
  },
  {
    // Hard guard the domain and capability layers from leaking SDK types.
    files: ['src/domain/**/*.ts', 'src/capability/**/*.ts', 'src/evidence/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', restrictedImportsForDomain],
    },
  },
];
