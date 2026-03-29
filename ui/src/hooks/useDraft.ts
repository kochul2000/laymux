import { useState, useEffect, useCallback, useRef } from "react";

/**
 * Draft pattern hook for Settings UI.
 *
 * Maintains a local draft copy of a store value. When the user edits the draft,
 * `dirty` becomes true. If the store value changes externally (e.g. settings.json
 * hot-reload by Tauri file watcher), the draft is fully reset to the new store value
 * and `dirty` is set to false — following Windows Terminal's behavior.
 *
 * @param storeValue - The current value from the Zustand store.
 * @returns `{ draft, setDraft, dirty, resetDraft }`
 */
export function useDraft<T>(storeValue: T) {
  const [draft, setDraftInternal] = useState<T>(storeValue);
  const [dirty, setDirty] = useState(false);

  // Track the previous storeValue to detect external changes
  const prevStoreValueRef = useRef(storeValue);

  // When storeValue changes externally, reset draft completely (Windows Terminal behavior)
  useEffect(() => {
    if (!Object.is(prevStoreValueRef.current, storeValue)) {
      prevStoreValueRef.current = storeValue;
      setDraftInternal(storeValue);
      setDirty(false);
    }
  }, [storeValue]);

  const setDraft = useCallback((value: T | ((prev: T) => T)) => {
    setDraftInternal(value);
    setDirty(true);
  }, []);

  const resetDraft = useCallback(() => {
    setDraftInternal(storeValue);
    setDirty(false);
  }, [storeValue]);

  return { draft, setDraft, dirty, resetDraft };
}
