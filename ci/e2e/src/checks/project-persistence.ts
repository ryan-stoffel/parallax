// A plain launch, and the same profile after a relaunch, is a blank window. The sidebar is not created (#316).
import { assertBlankWindow } from '../../../screenshots/src/blankWindow.ts';
import { check } from '../check.ts';
import { launchConnected, ready, type Session } from '../harness.ts';

export const projectPersistenceChecks = [
  check('a plain launch stays a blank window across a relaunch', async () => {
    let session: Session = await launchConnected();
    try {
      await ready(session);
      await assertBlankWindow(session.app, session.window);

      session = (await session.relaunch()) as Session;
      await assertBlankWindow(session.app, session.window);
    } finally {
      await session.close();
    }
  }),
];
