use serde::{Deserialize, Serialize};
use std::process::Command;

/// A detected listening port.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ListeningPort {
    pub port: u16,
    pub pid: Option<u32>,
    pub process_name: Option<String>,
}

/// Parse listening ports from netstat output (Windows).
pub fn parse_netstat_output(output: &str) -> Vec<ListeningPort> {
    let mut ports = Vec::new();

    for line in output.lines() {
        let line = line.trim();
        if !line.contains("LISTENING") {
            continue;
        }

        let parts: Vec<&str> = line.split_whitespace().collect();
        // Windows netstat -ano: Proto  Local Address  Foreign Address  State  PID
        if parts.len() < 5 {
            continue;
        }

        // Parse local address (e.g., "0.0.0.0:3000" or "[::]:3000")
        let local_addr = parts[1];
        let port = if let Some(colon_pos) = local_addr.rfind(':') {
            local_addr[colon_pos + 1..].parse::<u16>().ok()
        } else {
            None
        };

        let pid = parts[4].parse::<u32>().ok();

        if let Some(port) = port {
            // Skip common system ports
            if port == 0 {
                continue;
            }
            ports.push(ListeningPort {
                port,
                pid,
                process_name: None,
            });
        }
    }

    // Deduplicate by port
    ports.sort_by_key(|p| p.port);
    ports.dedup_by_key(|p| p.port);
    ports
}

/// Get currently listening ports by running netstat.
pub fn get_listening_ports() -> Vec<ListeningPort> {
    #[cfg(target_os = "windows")]
    {
        match Command::new("netstat")
            .args(["-ano", "-p", "TCP"])
            .output()
        {
            Ok(output) => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                parse_netstat_output(&stdout)
            }
            Err(_) => Vec::new(),
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        match Command::new("ss").args(["-tlnp"]).output() {
            Ok(output) => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                parse_ss_output(&stdout)
            }
            Err(_) => Vec::new(),
        }
    }
}

/// Parse listening ports from ss output (Linux).
#[cfg(not(target_os = "windows"))]
pub fn parse_ss_output(output: &str) -> Vec<ListeningPort> {
    let mut ports = Vec::new();

    for line in output.lines().skip(1) {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 5 {
            continue;
        }

        // Local Address:Port is typically at index 3
        let local_addr = parts[3];
        let port = if let Some(colon_pos) = local_addr.rfind(':') {
            local_addr[colon_pos + 1..].parse::<u16>().ok()
        } else {
            None
        };

        if let Some(port) = port {
            if port == 0 {
                continue;
            }
            ports.push(ListeningPort {
                port,
                pid: None,
                process_name: None,
            });
        }
    }

    ports.sort_by_key(|p| p.port);
    ports.dedup_by_key(|p| p.port);
    ports
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_netstat_output_extracts_ports() {
        let output = r#"
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1128
  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       12345
  TCP    0.0.0.0:8080           0.0.0.0:0              LISTENING       6789
  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       9999
  TCP    192.168.1.10:54321     192.168.1.20:443       ESTABLISHED     5555
"#;
        let ports = parse_netstat_output(output);
        assert!(ports.len() >= 3);
        assert!(ports.iter().any(|p| p.port == 3000));
        assert!(ports.iter().any(|p| p.port == 8080));
        assert!(ports.iter().any(|p| p.port == 5173));
        // ESTABLISHED lines should not be included
        assert!(!ports.iter().any(|p| p.port == 54321));
    }

    #[test]
    fn parse_netstat_output_extracts_pid() {
        let output = "  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       12345\n";
        let ports = parse_netstat_output(output);
        assert_eq!(ports.len(), 1);
        assert_eq!(ports[0].port, 3000);
        assert_eq!(ports[0].pid, Some(12345));
    }

    #[test]
    fn parse_netstat_output_handles_empty() {
        let ports = parse_netstat_output("");
        assert!(ports.is_empty());
    }

    #[test]
    fn parse_netstat_output_deduplicates() {
        let output = r#"
  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       100
  TCP    [::]:3000              [::]:0                 LISTENING       100
"#;
        let ports = parse_netstat_output(output);
        assert_eq!(ports.len(), 1);
        assert_eq!(ports[0].port, 3000);
    }

    #[test]
    fn listening_port_serializes() {
        let port = ListeningPort {
            port: 3000,
            pid: Some(12345),
            process_name: Some("node".into()),
        };
        let json = serde_json::to_string(&port).unwrap();
        let parsed: ListeningPort = serde_json::from_str(&json).unwrap();
        assert_eq!(port, parsed);
    }
}
