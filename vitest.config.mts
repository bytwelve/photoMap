import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    passWithNoTests: false,
    // Keep filesystem and PowerShell suites from competing on shared CI runners.
    maxWorkers: process.env.CI ? 2 : undefined,
    restoreMocks: true
  }
});
