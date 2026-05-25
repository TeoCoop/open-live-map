import * as Network from 'expo-network';
import { useEffect, useRef, useState } from 'react';

/** Polls network state every 4 s and returns whether the device has internet. */
export function useNetworkStatus(): { isConnected: boolean } {
  // Start optimistic — avoids a false "offline" flash on mount before the first check.
  const [isConnected, setIsConnected] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    async function check() {
      try {
        const state = await Network.getNetworkStateAsync();
        // isInternetReachable can be null on some platforms — treat null as unknown (keep connected).
        const reachable = state.isInternetReachable ?? true;
        setIsConnected((state.isConnected ?? false) && reachable);
      } catch {
        // If the API itself fails, don't flip to offline — keep current state.
      }
    }
    check();
    intervalRef.current = setInterval(check, 4000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  return { isConnected };
}
