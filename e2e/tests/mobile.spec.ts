import { expect, test } from '@playwright/test';
import { BOB, signIn } from './helpers.js';

test('on a phone the pages list stacks into cards without sideways scrolling', async ({ page }) => {
  await signIn(page, BOB);
  await expect(page.locator('a[href^="/pages/"]').first()).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Likely keywords' })).toBeHidden();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
