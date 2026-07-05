use std::collections::HashSet;
use std::net::IpAddr;

const HOST_KIND_LOOPBACK: &str = "loopback";
const HOST_KIND_TAILSCALE: &str = "tailscale";
const HOST_KIND_LAN: &str = "lan";

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostCandidate {
    pub kind: String,
    pub host: String,
    pub label: String,
}

#[tauri::command]
pub async fn get_remote_host_candidates() -> Result<Vec<HostCandidate>, String> {
    tokio::task::spawn_blocking(get_remote_host_candidates_inner)
        .await
        .map_err(|e| format!("Failed to collect remote host candidates: {e}"))
}

pub fn get_remote_host_candidates_inner() -> Vec<HostCandidate> {
    remote_host_candidates_from_detected(
        detect_tailscale_host_candidates(),
        detect_lan_host_candidates(),
    )
}

fn remote_host_candidates_from_detected(
    tailscale_candidates: Vec<HostCandidate>,
    lan_candidates: Vec<HostCandidate>,
) -> Vec<HostCandidate> {
    let mut candidates = Vec::new();
    candidates.extend(tailscale_candidates);
    candidates.extend(lan_candidates);
    candidates.push(loopback_host_candidate());
    dedupe_host_candidates(candidates)
}

fn loopback_host_candidate() -> HostCandidate {
    host_candidate(HOST_KIND_LOOPBACK, "127.0.0.1", "Localhost 127.0.0.1")
}

fn host_candidate(kind: &str, host: &str, label: &str) -> HostCandidate {
    HostCandidate {
        kind: kind.to_string(),
        host: host.to_string(),
        label: label.to_string(),
    }
}

fn host_candidate_for_ip(kind: &str, ip: IpAddr) -> HostCandidate {
    let host = ip.to_string();
    let prefix = match kind {
        HOST_KIND_TAILSCALE => "Tailscale",
        HOST_KIND_LAN => "LAN",
        _ => "Host",
    };
    host_candidate(kind, &host, &format!("{prefix} {host}"))
}

fn detect_tailscale_host_candidates() -> Vec<HostCandidate> {
    ["-4", "-6"]
        .into_iter()
        .filter_map(|family| {
            let output = crate::process::headless_command("tailscale")
                .args(["ip", family])
                .output()
                .ok()?;
            if !output.status.success() {
                return None;
            }
            parse_first_tailscale_ip(&output.stdout)
                .and_then(|host| host.parse::<IpAddr>().ok())
                .map(|ip| host_candidate_for_ip(HOST_KIND_TAILSCALE, ip))
        })
        .collect()
}

fn parse_first_tailscale_ip(stdout: &[u8]) -> Option<String> {
    String::from_utf8_lossy(stdout)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(ToOwned::to_owned)
}

fn detect_lan_host_candidates() -> Vec<HostCandidate> {
    let ips = match if_addrs::get_if_addrs() {
        Ok(addrs) => addrs
            .into_iter()
            .filter(|interface| !interface.is_loopback())
            .map(|interface| interface.ip())
            .collect(),
        Err(err) => {
            tracing::debug!(error = %err, "failed to enumerate network interfaces");
            Vec::new()
        }
    };
    lan_host_candidates_from_ips(ips)
}

fn lan_host_candidates_from_ips(ips: Vec<IpAddr>) -> Vec<HostCandidate> {
    let (mut ipv4, mut ipv6): (Vec<_>, Vec<_>) = ips
        .into_iter()
        .filter(|ip| is_lan_candidate_ip(*ip))
        .partition(|ip| matches!(ip, IpAddr::V4(_)));
    ipv4.append(&mut ipv6);
    ipv4.into_iter()
        .map(|ip| host_candidate_for_ip(HOST_KIND_LAN, ip))
        .collect()
}

fn is_lan_candidate_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => !ip.is_loopback() && !ip.is_link_local() && !ip.is_unspecified(),
        IpAddr::V6(ip) => {
            !ip.is_loopback()
                && !ip.is_unicast_link_local()
                && !ip.is_unspecified()
                && !ip.is_multicast()
        }
    }
}

fn dedupe_host_candidates(candidates: Vec<HostCandidate>) -> Vec<HostCandidate> {
    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter(|candidate| seen.insert(candidate.host.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    #[test]
    fn parse_first_tailscale_ip_uses_first_non_empty_line() {
        assert_eq!(
            parse_first_tailscale_ip(b"\n  100.64.0.2 \n100.64.0.3\n").as_deref(),
            Some("100.64.0.2")
        );
        assert_eq!(parse_first_tailscale_ip(b"\n \t \n"), None);
    }

    #[test]
    fn lan_host_candidates_filter_loopback_and_link_local() {
        let candidates = lan_host_candidates_from_ips(vec![
            IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)),
            IpAddr::V4(Ipv4Addr::new(169, 254, 10, 20)),
            IpAddr::V4(Ipv4Addr::new(192, 168, 0, 44)),
            IpAddr::V6(Ipv6Addr::LOCALHOST),
            IpAddr::V6("fe80::1".parse().unwrap()),
            IpAddr::V6("fd7a:115c:a1e0::7".parse().unwrap()),
        ]);

        let hosts: Vec<_> = candidates
            .iter()
            .map(|candidate| candidate.host.as_str())
            .collect();
        assert_eq!(hosts, vec!["192.168.0.44", "fd7a:115c:a1e0::7"]);
        assert!(candidates
            .iter()
            .all(|candidate| candidate.kind == HOST_KIND_LAN));
    }

    #[test]
    fn dedupe_host_candidates_preserves_first_occurrence() {
        let candidates = dedupe_host_candidates(vec![
            host_candidate(HOST_KIND_LOOPBACK, "127.0.0.1", "Localhost"),
            host_candidate(HOST_KIND_LAN, "192.168.0.2", "LAN 192.168.0.2"),
            host_candidate(HOST_KIND_TAILSCALE, "192.168.0.2", "Tailscale duplicate"),
        ]);

        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[1].kind, HOST_KIND_LAN);
        assert_eq!(candidates[1].label, "LAN 192.168.0.2");
    }

    #[test]
    fn remote_host_candidates_order_tailscale_lan_loopback() {
        let candidates = remote_host_candidates_from_detected(
            vec![host_candidate(
                HOST_KIND_TAILSCALE,
                "100.64.0.2",
                "Tailscale 100.64.0.2",
            )],
            vec![host_candidate(
                HOST_KIND_LAN,
                "192.168.0.44",
                "LAN 192.168.0.44",
            )],
        );

        let hosts: Vec<_> = candidates
            .iter()
            .map(|candidate| candidate.host.as_str())
            .collect();
        let kinds: Vec<_> = candidates
            .iter()
            .map(|candidate| candidate.kind.as_str())
            .collect();
        assert_eq!(hosts, vec!["100.64.0.2", "192.168.0.44", "127.0.0.1"]);
        assert_eq!(
            kinds,
            vec![HOST_KIND_TAILSCALE, HOST_KIND_LAN, HOST_KIND_LOOPBACK]
        );
    }

    #[test]
    fn remote_host_candidates_order_lan_loopback_when_tailscale_absent() {
        let candidates = remote_host_candidates_from_detected(
            Vec::new(),
            vec![host_candidate(
                HOST_KIND_LAN,
                "192.168.0.44",
                "LAN 192.168.0.44",
            )],
        );

        let hosts: Vec<_> = candidates
            .iter()
            .map(|candidate| candidate.host.as_str())
            .collect();
        assert_eq!(hosts, vec!["192.168.0.44", "127.0.0.1"]);
    }

    #[test]
    fn remote_host_candidates_include_loopback_when_detected_empty() {
        let candidates = remote_host_candidates_from_detected(Vec::new(), Vec::new());

        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].kind, HOST_KIND_LOOPBACK);
        assert_eq!(candidates[0].host, "127.0.0.1");
    }

    #[test]
    fn get_remote_host_candidates_always_includes_loopback() {
        let candidates = get_remote_host_candidates_inner();
        assert!(!candidates.is_empty());
        assert!(
            candidates
                .iter()
                .any(|candidate| candidate.kind == HOST_KIND_LOOPBACK
                    && candidate.host == "127.0.0.1")
        );
    }
}
