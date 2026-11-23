export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_REMAINING = 2;

export class PurgeError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = EXIT_ERROR,
  ) {
    super(message);
    this.name = "PurgeError";
  }
}
