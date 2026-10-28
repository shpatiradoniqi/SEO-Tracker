import { expect, test } from '@playwright/test';
import { ALICE, BOB, signIn } from './helpers.js';

test.describe('sign-in', () => {
  test('rejects a wrong password with a readable message', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(ALICE.email);
    await page.getByLabel('Password').fill('wrong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toHaveText('Email or password is incorrect.');
    await expect(page).toHaveURL(/\/login/);
  });

  test('protected screens send you to sign-in, and back after it', async ({ page }) => {
    await page.goto('/clients/new');
    await expect(page).toHaveURL(/\/login/);
    await page.getByLabel('Email').fill(ALICE.email);
    await page.getByLabel('Password').fill(ALICE.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Add a client' })).toBeVisible();
  });

  test('the session survives a reload and ends on sign-out', async ({ page }) => {
    await signIn(page, ALICE);
    await page.reload();
    await expect(page.getByText(ALICE.email)).toBeVisible();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto('/pages');
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe('pages list', () => {
  test('shows only the signed-in user\'s client', async ({ page }) => {
    await signIn(page, ALICE);
    await expect(page.locator('a[href^="/pages/"]').first()).toBeVisible();
    await expect(page.getByText(`www.${ALICE.host}`).first()).toBeVisible();
    await expect(page.getByText(BOB.host)).toHaveCount(0);
    // Other clients the user added in the app may be listed too; another user's never are.
    const options = await page.getByLabel('Client').locator('option').allTextContents();
    expect(options).toContain(ALICE.client);
    expect(options).not.toContain(BOB.client);
  });

  test('search filters the list and is kept in the URL across a reload', async ({ page }) => {
    await signIn(page, BOB);
    await page.getByLabel('Search URL or keyword').fill('zzzz-no-such-keyword');
    await expect(page.getByText('No pages match these filters.')).toBeVisible();
    await expect(page).toHaveURL(/q=zzzz-no-such-keyword/);
    await page.getByLabel('Search URL or keyword').fill('seo');
    await expect(page).toHaveURL(/q=seo/);
    await page.reload();
    await expect(page.getByLabel('Search URL or keyword')).toHaveValue('seo');
    await expect(page.locator('a[href^="/pages/"]').first()).toBeVisible();
  });
});

test.describe('page detail', () => {
  test('draws the position chart, switches range and shows the table view', async ({ page }) => {
    await signIn(page, ALICE);
    const first = page.locator('a[href^="/pages/"]').first();
    const title = (await first.textContent())!;
    await first.click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
    await expect(page.getByRole('heading', { name: 'Position history' })).toBeVisible();
    await expect(page.locator('.recharts-surface').first()).toBeVisible();
    await expect(page.getByText('End of page 1')).toBeVisible();

    await page.getByRole('group', { name: 'Date range' }).getByRole('button', { name: '1 year' }).click();
    await expect(page.getByRole('button', { name: '1 year' })).toHaveAttribute('aria-pressed', 'true');

    await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'table' }).click();
    const table = page.getByRole('table');
    await expect(table.getByRole('columnheader', { name: 'Date' })).toBeVisible();
    expect(await table.getByRole('row').count()).toBeGreaterThan(300); // a year of daily rows
    await expect(page.getByRole('heading', { name: 'Keywords' })).toBeVisible();
    await expect(page.getByRole('heading', { name: /SEO issues/ })).toBeVisible();
  });

  test('another user\'s page answers "not found"', async ({ page }) => {
    await signIn(page, BOB);
    const href = await page.locator('a[href^="/pages/"]').first().getAttribute('href');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await signIn(page, ALICE);
    await page.goto(href!);
    await expect(page.getByRole('link', { name: 'Back to pages' })).toBeVisible();
  });
});

test.describe('add client', () => {
  test('a private address is refused by the server (CSRF-protected POST goes through)', async ({ page }) => {
    await signIn(page, ALICE);
    await page.getByRole('link', { name: 'Add client' }).click();
    await page.getByLabel('Client name').fill('Intranet');
    await page.getByLabel('Website URL').fill('http://10.0.0.1');
    await page.getByRole('button', { name: /Add client/ }).click();
    await expect(page.getByRole('alert')).toHaveText(/private or reserved network/);
    await expect(page.getByRole('heading', { name: 'Your clients' })).toBeVisible();
    await expect(page.getByRole('link', { name: ALICE.client })).toBeVisible();
  });
});
