import { describe, expect, it } from 'vitest'
import { DrainableRuntimeWorker } from './DrainableRuntimeWorker'

describe('DrainableRuntimeWorker', () => {
  it('processes items in enqueue order', async () => {
    const processed: number[] = []
    const worker = new DrainableRuntimeWorker<number>((item) => {
      processed.push(item)
    })

    worker.enqueue(1)
    worker.enqueue(2)
    worker.enqueue(3)
    await worker.drain()

    expect(processed).toEqual([1, 2, 3])
  })

  it('drain() resolves when the queue is empty', async () => {
    const worker = new DrainableRuntimeWorker<string>((_item) => {})
    worker.enqueue('a')
    worker.enqueue('b')
    await worker.drain()
    // Re-drain should resolve immediately (nothing queued)
    await worker.drain()
  })

  it('processes items enqueued during processing', async () => {
    const processed: number[] = []
    const worker = new DrainableRuntimeWorker<number>((item) => {
      processed.push(item)
      if (item === 1) {
        worker.enqueue(2)
      }
    })

    worker.enqueue(1)
    await worker.drain()
    expect(processed).toEqual([1, 2])
  })

  it('is deterministic: same order across multiple drain calls', async () => {
    const processed: string[] = []
    const worker = new DrainableRuntimeWorker<string>((item) => {
      processed.push(item)
    })

    worker.enqueue('x')
    await worker.drain()
    worker.enqueue('y')
    await worker.drain()

    expect(processed).toEqual(['x', 'y'])
  })
})
