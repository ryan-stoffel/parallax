// Review Agent Changes opened a multi-diff editor in chrome that boot no longer creates (#316).
import { assertBlankWindow } from '../../../screenshots/src/blankWindow.ts';
import { check } from '../check.ts';
import { launchSmoke, ready } from '../harness.ts';

export const agentReviewChecks = [
  check('plain launch opens a blank window instead of the review editor', async () => {
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
