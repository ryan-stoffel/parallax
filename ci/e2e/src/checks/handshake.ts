// A plain launch opens a blank window. The host chip is not created (#316).
import { assertBlankWindow } from '../../../screenshots/src/blankWindow.ts';
import { check } from '../check.ts';
import { launchConnected, ready } from '../harness.ts';

export const handshakeChecks = [
  check('a plain launch opens a blank window', async () => {
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
