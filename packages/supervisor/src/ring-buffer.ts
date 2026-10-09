/** Fixed-capacity FIFO that overwrites its oldest entry. */
export class RingBuffer<T> {
  private readonly items: T[] = [];
  private start = 0;

  constructor(readonly capacity: number) {}

  push(item: T): void {
    if (this.items.length < this.capacity) {
      this.items.push(item);
      return;
    }
    this.items[this.start] = item;
    this.start = (this.start + 1) % this.capacity;
  }

  /** Oldest → newest. */
  toArray(): T[] {
    return [...this.items.slice(this.start), ...this.items.slice(0, this.start)];
  }

  get size(): number {
    return this.items.length;
  }
}
