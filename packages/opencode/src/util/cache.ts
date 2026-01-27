/**
 * LRU cache with max entries limit for preventing memory leaks
 * Uses a doubly-linked list for O(1) eviction
 */

export type LruCacheOpts = {
  maxEntries?: number
  onEvict?: (key: any, value: any) => void
}

type LruNode<K, V> = {
  key: K
  value: V
  prev: LruNode<K, V> | null
  next: LruNode<K, V> | null
}

export function createLruCache<K = any, V = any>(opts: LruCacheOpts = {}) {
  const { maxEntries = Infinity, onEvict } = opts
  const cache = new Map<K, LruNode<K, V>>()

  // Doubly-linked list head (most recent) and tail (least recent)
  let head: LruNode<K, V> | null = null
  let tail: LruNode<K, V> | null = null

  function remove(node: LruNode<K, V>) {
    if (node.prev) node.prev.next = node.next
    else head = node.next

    if (node.next) node.next.prev = node.prev
    else tail = node.prev

    node.prev = null
    node.next = null
  }

  function moveToHead(node: LruNode<K, V>) {
    if (head === node) return
    remove(node)
    node.next = head
    node.prev = null
    if (head) head.prev = node
    head = node
    if (!tail) tail = node
  }

  function addToHead(node: LruNode<K, V>) {
    node.next = head
    node.prev = null
    if (head) head.prev = node
    head = node
    if (!tail) tail = node
  }

  function evictOne() {
    if (!tail) return
    const node = tail
    remove(node)
    onEvict?.(node.key, node.value)
    cache.delete(node.key)
  }

  function delete_(key: K): boolean {
    const node = cache.get(key)
    if (!node) return false
    remove(node)
    onEvict?.(key, node.value)
    return cache.delete(key)
  }

  return {
    get(key: K): V | undefined {
      const node = cache.get(key)
      if (!node) return undefined
      moveToHead(node)
      return node.value
    },

    set(key: K, value: V): void {
      const existing = cache.get(key)
      if (existing) {
        existing.value = value
        moveToHead(existing)
        return
      }

      if (cache.size >= maxEntries) {
        evictOne()
      }

      const node: LruNode<K, V> = { key, value, prev: null, next: null }
      cache.set(key, node)
      addToHead(node)
    },

    has(key: K): boolean {
      return cache.has(key)
    },

    delete(key: K): boolean {
      return delete_(key)
    },

    clear(): void {
      for (const [key, node] of cache) {
        onEvict?.(key, node.value)
      }
      cache.clear()
      head = null
      tail = null
    },

    get size() {
      return cache.size
    },

    *[Symbol.iterator](): IterableIterator<[K, V]> {
      for (const [key, node] of cache) {
        yield [key, node.value]
      }
    },

    entries(): IterableIterator<[K, V]> {
      return this[Symbol.iterator]()
    },
  }
}
