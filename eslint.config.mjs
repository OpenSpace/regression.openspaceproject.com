import { tsLint } from '@openspace/shared-configs/eslint';
import { reactLint } from '@openspace/shared-configs/eslint/react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'out', 'data', 'frontend/dist', '**/*.d.ts'] },
  {
    // Backend
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    extends: [tsLint],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node
    }
  },
  {
    // Frontend
    files: ['frontend/**/*.{ts,tsx}'],
    extends: [reactLint],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser
    },
    plugins: {
      'react-hooks': reactHooks
    },
    rules: reactHooks.configs.recommended.rules
  }
);
