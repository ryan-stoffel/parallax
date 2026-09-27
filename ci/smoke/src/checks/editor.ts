// `wisp <folder>` used to open the editor chrome. Boot now opens a blank window in that case too (#316).
import { assertBlankWindow } from '../../../screenshots/src/blankWindow.ts';
import { check } from '../check.ts';
import { gitWorkspace, launchSmoke, ready } from '../harness.ts';

export const editorChecks = [
  check('wisp <folder> opens a blank window', async () => {
    const workspace = await gitWorkspace();
    const session = await launchSmoke([workspace.folder]);
    try {
      const { app, window } = session;
      await ready({ app, window });
      await assertBlankWindow(app, window);
    } finally {
      await session.close();
      await workspace.cleanup();
    }
  }),
];
