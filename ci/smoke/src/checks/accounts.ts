// The Accounts view lived in chrome that boot no longer creates (#316). A plain launch is a blank window.
import { assertBlankWindow } from '../../../screenshots/src/blankWindow.ts';
import { check } from '../check.ts';
import { launchSmoke, ready } from '../harness.ts';

export const accountsChecks = [
  check('plain launch opens a blank window instead of the Accounts view', async () => {
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
