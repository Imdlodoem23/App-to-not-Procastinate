/**
 * Route handlers still running (owner: CORE). Closing the HTTP server waits only for open
 * connections, and a handler goes on after its client left (the app was closed, a request
 * cancelled): a coach call keeps waiting for the model and settles its quota reservation
 * afterwards. `app.close()` drains this set before the database pool closes, so that work
 * finishes instead of dying with the process (server.ts bounds the wait with
 * `SHUTDOWN_TIMEOUT_MS`). docs/API.md §15.
 */
export class InFlightWork {
  private readonly pending = new Set<Promise<void>>();

  /** How many tracked promises have not settled yet. */
  get size(): number {
    return this.pending.size;
  }

  /** Tracks `work` until it settles and returns it unchanged (its rejection included). */
  track<T>(work: Promise<T>): Promise<T> {
    const done: Promise<void> = work.then(
      () => {
        this.pending.delete(done);
      },
      () => {
        this.pending.delete(done);
      },
    );
    this.pending.add(done);
    return work;
  }

  /** Resolves once nothing is pending, work tracked while draining included. Never rejects. */
  async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.all(this.pending);
  }
}
