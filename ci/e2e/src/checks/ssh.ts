// Switching hosts and creating a project used the sidebar and the host chip.
// Boot no longer creates that chrome, so a launch is a blank window (#316).
// scripts/ci/ssh-localhost is still required when the e2e job demands it: a missing
// setup fails the job, and otherwise this check skips, the same as before.
import { assertBlankWindow } from '../../../screenshots/src/blankWindow.ts';
import { skip, check } from '../check.ts';
import { launchConnectedForSsh, readEnvFile, ready } from '../harness.ts';

/** Where `scripts/ci/ssh-localhost` writes its `KEY=value` result (also read by scripts/ci/e2e). */
const STATUS_ENV_VAR = 'WISP_E2E_SSH_STATUS_FILE';
/** Set by `ci.yml`'s `e2e` job only: makes "ssh not ready" a failure instead of a skip. */
const REQUIRE_SSH_ENV_VAR = 'WISP_E2E_REQUIRE_SSH';

export const sshChecks = [
  check('a plain launch opens the sidebar and does not show the host chip', async () => {
    const required = process.env[REQUIRE_SSH_ENV_VAR] === '1';
    const statusFile = process.env[STATUS_ENV_VAR];
    if (statusFile === undefined) {
      const reason = `${STATUS_ENV_VAR} is not set; scripts/ci/ssh-localhost did not run (see #95)`;
      if (required) {
        throw new Error(`${REQUIRE_SSH_ENV_VAR}=1 but ssh localhost is not ready: ${reason}`);
      }
      skip(reason);
    }
    const status = await readEnvFile(statusFile);
    if (status.WISP_E2E_SSH_READY !== 'true') {
      const reason = status.WISP_E2E_SSH_REASON ?? `${statusFile} does not say ssh to localhost is ready (see #95)`;
      if (required) {
        throw new Error(`${REQUIRE_SSH_ENV_VAR}=1 but ssh localhost is not ready: ${reason}`);
      }
      skip(reason);
    }

    const sshLaunch = await launchConnectedForSsh();
    const { session } = sshLaunch;
    try {
      const { app, window } = session;
      await ready({ app, window });
      await assertBlankWindow(app, window);
    } finally {
      await session.close();
      await sshLaunch.close();
    }
  }),
];
