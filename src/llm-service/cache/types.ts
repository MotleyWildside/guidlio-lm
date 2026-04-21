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

