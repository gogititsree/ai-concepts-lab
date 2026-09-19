import { useSyncExternalStore } from 'react';

import { getSnapshot, subscribe, type ProgressSnapshot } from '../lib/localProgress';

/**
 * Subscribes the tree to the local progress store.
 *
 * TODO(M7): becomes `useQuery(['progress'])`. The component-facing shape does not change,
 * which is the point of writing the localStorage store in the API's shape.
 */
export function useProgress(): ProgressSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
