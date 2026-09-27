// Disconnect used to show on the host chip. Boot no longer creates that chip (#316).
import { assertBlankWindow } from '../../../screenshots/src/blankWindow.ts';
import { check } from '../check.ts';
import { launchConnected, ready } from '../harness.ts';

export const reconnectChecks = [
  check('a plain launch opens a blank window and does not show a host chip', async () => {
    const session = await launchConnected();
    try {
      const { app, window } = session;
      await ready({ app, window });
      await assertBlankWindow(app, window);
    } finally {
      await session.close();
    }
  }),
];
