import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against the real app (API + worker + web) and the seeded database.
 * Prerequisites: docker compose up, npm run db:migrate, npm run seed.
 * The dev servers are started automatically, or reused if already running.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  workers: 2,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, testIgnore: /mobile\.spec\.ts/ },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /mobile\.spec\.ts/ },
  ],
  webServer: {
    command: 'npm run dev',
    cwd: '..',
    // Proxied through Vite, so this only answers once both the web app and the API are up.
    url: 'http://localhost:5173/api/health',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
