import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:4173/',
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    serviceWorkers: 'block', // cada teste começa sem cache do app
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // Servidor local que imita o GitHub Pages (inclusive o 404.html).
  webServer: {
    command: 'node tests/server.mjs 4173',
    url: 'http://localhost:4173/',
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'android', use: { ...devices['Pixel 7'] }, testMatch: /(site|members|birthdays)\.spec\.mjs/ },
    { name: 'iphone', use: { ...devices['iPhone 14'] }, testMatch: /site\.spec\.mjs/ },
    { name: 'banco-e-codigo', testMatch: /(security|isolation|units)\.spec\.mjs/ },
  ],
});
