// The Clerk instance the relay probe signs in with (PLX-1360). Its test account is on Clerk's
// development instance until PLX-1457 moves it to production, so relay-probe.mjs, its enroll
// script, and t3-compare.mjs, which runs the probe, default to that instance whatever plx defaults
// to (PLX-1049). PLX_CLERK_PUBLISHABLE_KEY and PLX_CLERK_CLIENT_ID name another instance, as for
// plx, and PROBE_CLERK_API another Frontend API, such as a local Clerk.
import { clerkOf } from "../../packages/plx/src/signin.mjs";

const DEVELOPMENT = {
  PLX_CLERK_PUBLISHABLE_KEY: "pk_test_YWRqdXN0ZWQtbWFzdG9kb24tODcwNS5jbGVyay5hY2NvdW50cy5kZXYk",
  PLX_CLERK_CLIENT_ID: "SXDueyOLOJ2v4Vmq",
};

/** The probe's Clerk application, from `env`. @param {NodeJS.ProcessEnv} env */
export function probeClerk(env) {
  const clerk = clerkOf({ ...DEVELOPMENT, ...env });
  return { ...clerk, ...(env["PROBE_CLERK_API"] && { api: env["PROBE_CLERK_API"] }) };
}

/**
 * The environment that makes a plxd take `clerk`'s tokens, whichever instance a release's plxd
 * takes by default. Clerk's issuer is its Frontend API. @param {{ api: string, clientId: string }} clerk
 */
export const plxdTrusts = (clerk) => ({ PLXD_CLERK_ISSUER: clerk.api, PLXD_CLERK_CLIENT_IDS: clerk.clientId });
