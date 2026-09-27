// A fake wispd that speaks a newer protocol used to show an incompatible host chip.
// Boot no longer creates that chip, so the launch is a blank window (#316).
import { join } from 'node:path';
import { assertBlankWindow } from '../../../screenshots/src/blankWindow.ts';
import { check } from '../check.ts';
import { launchWithWispd, ready } from '../harness.ts';

const fakeWispd = join(import.meta.dirname, '..', '..', 'fixtures', 'fake-wispd-incompatible.mjs');

export const versionMismatchChecks = [
  check('a plain launch opens a blank window and does not show a protocol error', async () => {
    const session = await launchWithWispd(fakeWispd);
    try {
      const { app, window } = session;
      await ready({ app, window });
      await assertBlankWindow(app, window);
    } finally {
      await session.close();
    }
  }),
];
