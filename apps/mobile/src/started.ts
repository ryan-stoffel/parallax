// The prompt each thread started on this phone began with, by its run id, so the thread's page can
// show it as the first message the moment it opens, before its transcript loads.
const prompts = new Map<string, string>();

/** Keeps `text` as what thread `runId` started with. */
export const setStarted = (runId: string, text: string) => void prompts.set(runId, text);

/** What thread `runId` started with here, if it started on this phone since the app opened. */
export const startedPrompt = (runId: string) => prompts.get(runId);
