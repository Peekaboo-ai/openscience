/** Retain live changes only while a snapshot is in flight. A delayed snapshot
 * must not roll back events received after its request started. */
export function createSnapshotUpdates<T>() {
  const pending = new Map<string, Set<Map<string, T | undefined>>>()
  return {
    start(scope: string) {
      const changes = new Map<string, T | undefined>()
      const group = pending.get(scope) ?? new Set<Map<string, T | undefined>>()
      pending.set(scope, group)
      group.add(changes)
      return {
        merge(snapshot: Map<string, T>) {
          for (const [id, value] of changes) {
            if (value === undefined) snapshot.delete(id)
            else snapshot.set(id, value)
          }
          return snapshot
        },
        close() {
          group.delete(changes)
          if (!group.size) pending.delete(scope)
        },
      }
    },
    set(scope: string, id: string, value: T | undefined) {
      for (const changes of pending.get(scope) ?? []) changes.set(id, value)
    },
  }
}
