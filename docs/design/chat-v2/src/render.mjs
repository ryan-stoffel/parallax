// Renders the mocks to ../<scene>-<dark|light>.png at 1440x900, in Wisp Dark and Wisp Light.
// Playwright is not a repo dependency. Run this from a temp directory outside the repo that
// has playwright-core installed; it is resolved from the current directory:
//   cd "$(mktemp -d)" && npm install playwright-core@1.63.0 && npx playwright-core install chromium
//   node <repo>/docs/design/chat-v2/src/render.mjs [name ...]
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { chromium } = createRequire(join(process.cwd(), 'index.js'))('playwright-core');
const src = dirname(fileURLToPath(import.meta.url));
const out = dirname(src);

const scenes = ['setup-host', 'setup-agents', 'setup-repo', 'empty', 'model-picker', 'running', 'finished', 'error', 'settings-general', 'settings-providers'];
const pages = scenes.flatMap((scene) => [['dark', 'wisp-dark'], ['light', 'wisp-light']].map(([suffix, theme]) => [`${scene}-${suffix}`, `scene=${scene}&theme=${theme}`]));

const only = process.argv.slice(2);
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
	const page = await context.newPage();
	page.on('pageerror', (error) => {
		throw error;
	});
	for (const [name, query] of pages) {
		if (only.length && !only.includes(name)) {
			continue;
		}
		await page.goto(`${pathToFileURL(join(src, 'index.html')).href}?${query}`);
		await page.waitForSelector('body[data-ready="true"]');
		await page.evaluate(() => document.fonts.ready);
		await page.screenshot({ path: join(out, `${name}.png`) });
		console.log(`${name}.png`);
	}
} finally {
	await browser.close();
}
