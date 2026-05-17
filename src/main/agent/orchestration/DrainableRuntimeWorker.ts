/**
 * DrainableRuntimeWorker
 *
 * A serialized processing queue that guarantees events are processed in order
 * and provides a `drain()` method for deterministic tests. Inspired by the
 * drainable worker pattern in dpcode/t3code.
 *
 * The queue is intentionally synchronous per-item: each item is processed to
 * completion before the next is dequeued so that ordering invariants hold even
 * when items produce secondary enqueues.
 */
export class DrainableRuntimeWorker<T> {
  private readonly queue: T[] = []
  private draining = false
  private drainPromise: Promise<void> = Promise.resolve()

  constructor(private readonly process: (item: T) => void) {}

  enqueue(item: T): void {
    this.queue.push(item)
    if (!this.draining) {
      this.drainPromise = this.drainLoop()
    }
  }

  /**
   * Returns a promise that resolves once all currently-queued items have been
   * processed. Useful in tests to await a deterministic end state after
   * enqueuing a batch of events.
   */
  async drain(): Promise<void> {
    await this.drainPromise
  }

  private async drainLoop(): Promise<void> {
    this.draining = true
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()
        if (item !== undefined) {
          this.process(item)
        }
      }
    } finally {
      this.draining = false
    }
  }
}
