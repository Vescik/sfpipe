/** Error with a user-facing message and an optional hint on how to fix it. */
export class SfpipeError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'SfpipeError';
  }
}
