import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // The API tests work with a database and files, so every test file runs in its own
    // process
    pool: 'forks',
    testTimeout: 30000
  }
});
