/**
 * Runs jobs one at a time, in the order they were added. LibreOffice cannot convert two files with the same profile at once, and one
 * conversion already uses a lot of memory, so Word → PDF is deliberately a queue of one. A job that fails does not stop the ones behind it.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  /** Jobs that are running or waiting. */
  get size(): number {
    return this.pending;
  }

  run<T>(job: () => Promise<T>): Promise<T> {
    this.pending += 1;
    const result = this.tail.then(job);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result.finally(() => {
      this.pending -= 1;
    });
  }
}
