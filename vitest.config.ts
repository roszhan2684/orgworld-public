import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['packages/*/test/**/*.test.ts', 'cli/test/**/*.test.ts', 'integrations/*/test/**/*.test.ts'], exclude: ['**/*.live.test.ts'], testTimeout: 30000 } },
      { test: { name: 'e2e', include: ['tests/e2e/**/*.e2e.test.ts'], testTimeout: 90000, hookTimeout: 60000, expect: { poll: { timeout: 15000 } } } },
      { test: { name: 'live', include: ['**/test/**/*.live.test.ts'], exclude: ['**/node_modules/**'], testTimeout: 600000 } },
    ],
  },
});
