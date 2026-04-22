/**
 * Cache provider interface for LLM responses
 */
export interface CacheProvider {
  /**
   * Get a cached value by key
   */
  get<T>(key: string): Promise<T | null>;

  /**
   * Set a cached value with optional TTL
   */
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;

  /**
   * Delete a cached value
   */
  delete(key: string): Promise<void>;

  /**
   * Clear all cached values
   */
  clear(): Promise<void>;
}

/**
 * Cache configuration
 */
export interface CacheConfig {
  /**
   * Cache mode behavior:
   * - 'read_through': Checks cache first, returns cached value if found. If not found, calls LLM and caches the result.
   *   Use this for normal caching behavior to reduce API calls and improve response times.
   * - 'bypass': Skips cache entirely - neither reads from nor writes to cache. Always calls LLM.
   *   Use this when you need fresh results or want to avoid caching for sensitive/unique requests.
   * - 'refresh': Bypasses cache read but still writes the new result to cache (forces refresh of cached value).
   *   Use this when you want to update stale cache entries while still benefiting from future cache hits.
   */
  mode: "read_through" | "bypass" | "refresh";
  /**
   * Time-to-live in seconds for cached entries. Only used when mode is 'read_through' or 'refresh'.
   * If not specified, cached entries will not expire.
   */
  ttlSeconds?: number;
}
