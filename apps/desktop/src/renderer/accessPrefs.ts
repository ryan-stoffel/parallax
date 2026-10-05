import { stored, merged } from "./stored";

/**
 * Access picker behavior kept on this computer. Plan is a legacy level, off by default: the picker
 * lists it only when this is on or the thread is already in Plan.
 */
export type AccessPrefs = { legacyPlan: boolean };

export const accessDefaults: AccessPrefs = { legacyPlan: false };

export const accessPrefs = stored("parallax.access", accessDefaults, merged);
