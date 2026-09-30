/** A registration that can be undone. Shaped like `vscode.Disposable`. */
export interface Disposable {
  dispose(): void;
}

/**
 * A minimal typed event source.
 *
 * Node's `EventEmitter` is string-keyed and untyped, which is exactly the
 * kind of stringly-typed seam this package exists to avoid; VSCode's own
 * `EventEmitter` lives behind the `vscode` module, which host-core must
 * work without (its tests run under plain Node). This is the small subset
 * both provide.
 *
 * Listeners are invoked over a snapshot of the list, so a listener that
 * disposes itself — or another — cannot corrupt the iteration.
 */
export class Emitter<T> {
  private listeners: ((event: T) => void)[] = [];

  /** Register [listener]; dispose the result to stop receiving events. */
  listen(listener: (event: T) => void): Disposable {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const index = this.listeners.indexOf(listener);
        if (index >= 0) this.listeners.splice(index, 1);
      },
    };
  }

  /** Deliver [event] to every current listener. */
  emit(event: T): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  /** Drop every listener. */
  clear(): void {
    this.listeners = [];
  }

  /** How many listeners are registered. */
  get listenerCount(): number {
    return this.listeners.length;
  }
}
