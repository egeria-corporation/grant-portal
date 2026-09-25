/**
 * Every component, in each sample brand, light and dark (spec §8.1, §13):
 * renders under the strict CSP and passes axe's WCAG AA color-contrast rule.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

for (const brand of ['northwind', 'bloom', 'evergreen'] as const) {
  test(`kitchen sink · ${brand} · AA contrast in light and dark`, async ({ page }) => {
    const violations: string[] = [];
    page.on('console', (msg) => {
      if (/Content Security Policy|Refused to/i.test(msg.text())) violations.push(msg.text());
    });
    await page.goto(`/_dev/kitchen-sink?brand=${brand}`);
    await expect(page.getByRole('heading', { name: 'Kitchen sink' })).toBeVisible();
    await expect(page.getByTestId('panel-light')).toBeVisible();
    await expect(page.getByTestId('panel-dark')).toBeVisible();

    const results = await new AxeBuilder({ page })
      .include('[data-testid^="panel-"]')
      .withRules(['color-contrast'])
      // Disabled controls are exempt from contrast requirements (WCAG 1.4.3).
      .exclude('[disabled]')
      .analyze();
    const failures = results.violations.flatMap((v) =>
      v.nodes.map((n) => `${n.target.join(' ')} :: ${n.failureSummary?.split('\n').slice(0, 2).join(' ')}`),
    );
    expect(failures).toEqual([]);
    expect(violations).toEqual([]);
  });
}
