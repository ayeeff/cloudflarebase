import { expect, test } from '@playwright/test';

/**
 * The /pricing calculator is a public marketing page: anonymous visitors,
 * client-side math, no backend. The spec pins the page's contract - both
 * totals render, presets actually move the numbers, and the assumptions +
 * sources footer exists (an estimate without visible assumptions is an ad).
 */
test.describe('pricing page (frontend)', () => {
	test.use({ storageState: { cookies: [], origins: [] } });

	test('renders all three bills and the breakdown for the default workload', async ({ page }) => {
		await page.goto('/pricing');
		await expect(page.getByRole('heading', { name: /Our price/ })).toBeVisible();

		await expect(page.getByTestId('pricing-total-cf')).toContainText('$');
		await expect(page.getByTestId('pricing-total-fb')).toContainText('$');
		await expect(page.getByTestId('pricing-total-sb')).toContainText('$');
		await expect(page.getByTestId('pricing-breakdown')).toBeVisible();

		// The 1M-user preset is the default - the divergence is the point - so
		// the multiplier shows without touching anything.
		await expect(page.getByTestId('pricing-preset-scale')).toHaveAttribute('data-active', 'true');
		await expect(page.getByTestId('pricing-multiplier')).toContainText('×');

		// The itemized legend carries the values (text tokens, not marks).
		await expect(page.getByTestId('pricing-cloudflare')).toContainText('Workers Paid base');
		await expect(page.getByTestId('pricing-cloudflare')).toContainText('$5.00');

		// MAU is a shared input; the competitor cards carry auth lines, and the
		// Supabase card names its structural caveat (compute is not metered
		// per operation).
		await expect(page.getByTestId('pricing-value-mau')).toBeVisible();
		await expect(page.getByTestId('pricing-firebase')).toContainText('Auth MAU');
		await expect(page.getByTestId('pricing-supabase')).toContainText('compute');
	});

	test('the side-project preset fits the Workers free tier', async ({ page }) => {
		await page.goto('/pricing');
		await page.getByTestId('pricing-preset-side').click();

		// Durable Objects are on the free plan - a small workload has no bill,
		// and the same workload honestly fits Supabase's Free plan too.
		await expect(page.getByTestId('pricing-free-tier')).toBeVisible();
		await expect(page.getByTestId('pricing-total-cf')).toContainText('$0.00');
		await expect(page.getByTestId('pricing-total-sb')).toContainText('$0.00');
		await expect(page.getByTestId('pricing-supabase-free')).toBeVisible();
	});

	test('presets move the numbers', async ({ page }) => {
		await page.goto('/pricing');

		await page.getByTestId('pricing-preset-side').click();
		const sideTotal = await page.getByTestId('pricing-total-cf').textContent();

		await page.getByTestId('pricing-preset-scale').click();
		await expect(page.getByTestId('pricing-total-cf')).not.toHaveText(sideTotal ?? '');
		await expect(page.getByTestId('pricing-value-reads')).toHaveText('20M');

		// The clicked preset is the active one - highlighted AND round-tripped
		// through the slider indices (a preset that does not survive its own
		// scale mapping would silently deselect itself).
		await expect(page.getByTestId('pricing-preset-scale')).toHaveAttribute('data-active', 'true');
		await expect(page.getByTestId('pricing-preset-side')).toHaveAttribute('data-active', 'false');

		// At scale the realtime fan-out makes Firebase the expensive column,
		// and the page says so with the multiplier and the listener-reads line.
		await expect(page.getByTestId('pricing-multiplier')).toContainText('×');
		await expect(page.getByTestId('pricing-firebase')).toContainText('listener reads');
	});

	test('assumptions and dated sources are visible, not hidden', async ({ page }) => {
		await page.goto('/pricing');
		const details = page.locator('details');
		await details.locator('summary').click();
		await expect(details).toContainText('Rates as of');
		await expect(details.getByRole('link', { name: 'Durable Objects pricing' })).toHaveAttribute(
			'href',
			/developers\.cloudflare\.com/
		);
	});
});
