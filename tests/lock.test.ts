import { setTimeout as sleep } from 'timers/promises';
import { describe, expect, it } from 'vitest';

import { KeyedMutex } from '../src/lock';

describe('KeyedMutex', () => {
  it('runs functions with the same key one after another', async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];
    const task = (name: string, duration: number) =>
      mutex.run('key', async () => {
        events.push(`start ${name}`);
        await sleep(duration);
        events.push(`end ${name}`);
        return name;
      });

    const results = await Promise.all([task('a', 30), task('b', 1), task('c', 1)]);
    expect(results).toEqual(['a', 'b', 'c']);
    expect(events).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });

  it('runs functions with different keys at the same time', async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];
    await Promise.all([
      mutex.run('a', async () => {
        events.push('start a');
        await sleep(30);
        events.push('end a');
      }),
      mutex.run('b', async () => {
        events.push('start b');
        await sleep(1);
        events.push('end b');
      })
    ]);
    expect(events).toEqual(['start a', 'start b', 'end b', 'end a']);
  });

  it('releases the lock when a function throws', async () => {
    const mutex = new KeyedMutex();
    await expect(
      mutex.run('key', () => {
        throw new Error('failure');
      })
    ).rejects.toThrow('failure');
    await expect(mutex.run('key', () => 'next')).resolves.toBe('next');
  });

  it('reports when all functions have finished', async () => {
    const mutex = new KeyedMutex();
    let finished = false;
    const running = mutex.run('key', async () => {
      await sleep(20);
      finished = true;
    });
    await mutex.idle();
    expect(finished).toBe(true);
    await running;
  });
});
