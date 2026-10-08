/** The run was taken over or changed state while this job was working; stop without writing. */
export class RunSupersededError extends Error {}

/** This job's lease on the run expired and another job claimed it. */
export class LeaseLostError extends RunSupersededError {}

/** Called right before each product's Shopify writes; throws to stop the job first. */
export type WriteGuard = () => Promise<void>;

export const noGuard: WriteGuard = async () => {};
