import { useEffect, useMemo, useState } from "react";
import { getRemoteHostCandidates, type HostCandidate } from "@/lib/tauri-api";
import { buildRemoteHostOptions, type RemoteHostOption } from "@/lib/remote-hosts";

export function useRemoteHostOptions(customHosts: string[]): RemoteHostOption[] {
  const [hostCandidates, setHostCandidates] = useState<HostCandidate[]>([]);

  useEffect(() => {
    let cancelled = false;
    getRemoteHostCandidates()
      .then((candidates) => {
        if (!cancelled) setHostCandidates(candidates);
      })
      .catch(() => {
        if (!cancelled) setHostCandidates([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return useMemo(
    () => buildRemoteHostOptions(hostCandidates, customHosts),
    [customHosts, hostCandidates],
  );
}
