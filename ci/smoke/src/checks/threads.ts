// New Chat and the sidebar thread list lived in chrome that boot no longer creates (#316).
import { assertBlankWindow } from '../../../screenshots/src/blankWindow.ts';
import { check } from '../check.ts';
import { launchSmoke, ready } from '../harness.ts';

export const threadsChecks = [
  check('plain launch opens a blank window instead of a thread', async () => {
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
