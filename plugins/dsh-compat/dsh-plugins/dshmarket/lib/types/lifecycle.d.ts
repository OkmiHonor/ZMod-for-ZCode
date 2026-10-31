/** Bound asynchronous loader work without pretending that timeout cancels it. */
export declare class LifecycleWaitError extends Error {
}
/**
 * The refusal `waitForLifecycle` gives a second caller while the first call's
 * work is still in flight. A distinct subclass, so a caller can tell "the same
 * operation I already know about has not finished" from a fresh failure
 * without matching on message text (#788). It stays a LifecycleWaitError, so
 * every existing `instanceof LifecycleWaitError` check keeps its meaning.
 */
export declare class LifecyclePendingError extends LifecycleWaitError {
}
/** Never start a second mutation on a loader object whose earlier work is pending. */
export declare function waitForLifecycle<T>(key: object, start: () => T | Promise<T>, label: string): Promise<T>;
