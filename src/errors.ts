/**
 * Every error NEXUS throws extends NexusError, so callers can distinguish
 * runtime failures from bugs in their own code with a single instanceof check.
 */
export class NexusError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The browser answered a CDP command with an error object. */
export class ProtocolError extends NexusError {
  readonly method: string;
  readonly code: number;

  constructor(method: string, code: number, message: string, data?: string) {
    super(`${method} failed (${code}): ${message}${data ? ` — ${data}` : ''}`);
    this.method = method;
    this.code = code;
  }
}

/** A command, event, or condition did not complete within its deadline. */
export class TimeoutError extends NexusError {}

/** The CDP connection is closed (browser exited, crashed, or was closed). */
export class DisconnectedError extends NexusError {}

/** Chromium could not be found or failed to start. */
export class LaunchError extends NexusError {}

/** Page.navigate reported a failure (DNS error, refused connection, ...). */
export class NavigationError extends NexusError {}

/** A script passed to page.evaluate() threw inside the page. */
export class EvaluationError extends NexusError {}

/** A locator matched no element before its timeout expired. */
export class ElementNotFoundError extends NexusError {}

/** A locator used for a single-element operation matched more than one element. */
export class AmbiguousLocatorError extends NexusError {
  readonly count: number;

  constructor(message: string, count: number) {
    super(message);
    this.count = count;
  }
}

/** An element was found but the action cannot be performed on it. */
export class ActionError extends NexusError {}

/** An expect() assertion did not hold before its timeout expired. */
export class VerificationError extends NexusError {}

/**
 * Another element would receive a click at the target's position (e.g. an
 * overlay). Locators retry this until their timeout, since overlays are
 * often transient.
 */
export class ElementCoveredError extends ActionError {}

/** A task file is malformed. `issues` lists every problem found, with its location. */
export class TaskValidationError extends NexusError {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid task:\n  ${issues.join('\n  ')}`);
    this.issues = issues;
  }
}

/** Calling the model failed (credentials, rate limit, API error) or the model declined. */
export class AiError extends NexusError {}
