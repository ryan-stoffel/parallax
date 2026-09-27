// A plain launch opens a visible window with no workbench parts and no native title bar (#316).
import { assertBlankWindow } from '../../../screenshots/src/blankWindow.ts';
import { check } from '../check.ts';
import { launchSmoke, ready } from '../harness.ts';

export const agentsWindowChecks = [
  check('plain launch opens a blank window', async () => {
    const session = await launchSmoke();
    try {
      const { app, window } = session;
      await ready({ app, window });
      await assertBlankWindow(app, window);
    } finally {
      await session.close();
    }
  }),
];
