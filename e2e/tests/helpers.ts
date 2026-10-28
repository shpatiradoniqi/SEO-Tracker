import { expect, type Page } from '@playwright/test';

// Demo accounts created by `npm run seed`.
export const ALICE = { email: 'alice@example.com', password: 'password123', client: 'Semrush', host: 'semrush.com' };
export const BOB = { email: 'bob@example.com', password: 'password123', client: 'Yoast', host: 'yoast.com' };

export async function signIn(page: Page, user: { email: string; password: string }) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/pages/);
  await expect(page.getByRole('heading', { name: 'Pages' })).toBeVisible();
}
