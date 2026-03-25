import { useState, useEffect } from "react";
import { getListeningPorts, type ListeningPort } from "@/lib/tauri-api";

/**
 * Hook that periodically polls for listening TCP ports.
 * @param intervalMs Polling interval in milliseconds (default: 10000)
 */
export function usePortDetection(intervalMs = 10000): ListeningPort[] {
  const [ports, setPorts] = useState<ListeningPort[]>([]);

  useEffect(() => {
    let mounted = true;

    const fetchPorts = async () => {
      try {
        const result = await getListeningPorts();
        if (mounted) {
          setPorts(result);
        }
      } catch {
        // Ignore errors — backend might not be available in dev/test
      }
    };

    fetchPorts();
    const timer = setInterval(fetchPorts, intervalMs);

    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [intervalMs]);

  return ports;
}
