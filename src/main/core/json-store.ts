/**
 * Minimal persistence boundary used by the application layer.
 *
 * Implementations may use an atomic JSON file, SQLite, or an in-memory fake. The
 * application deliberately does not depend on implementation-specific paths or
 * transaction handles.
 */
export interface JsonStore<T> {
  read(): Promise<T>
  write(value: T): Promise<T>
  update(mutator: (current: T) => T | Promise<T>): Promise<T>
}
