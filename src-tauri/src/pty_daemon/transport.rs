//! OS-private transport. TCP Automation/Remote ports are deliberately separate.
#[cfg(windows)]
#[path = "transport_windows.rs"]
mod platform;
#[cfg(target_os = "linux")]
#[path = "transport_linux.rs"]
mod platform;

pub(crate) use platform::{connect, current_identity, private_directory, Listener};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon_wire::{read_frame, write_frame};

    #[test]
    fn discovery_directory_must_have_current_logon_private_permissions() {
        let fixture = tempfile::tempdir().unwrap();
        let private = fixture.path().join("private");
        private_directory(&private).unwrap();
        private_directory(&private).unwrap();
        let broad = fixture.path().join("broad");
        std::fs::create_dir(&broad).unwrap();
        #[cfg(target_os = "linux")]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&broad, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        assert!(
            private_directory(&broad).is_err(),
            "an existing broadly accessible directory must not be trusted"
        );
        assert!(!current_identity().unwrap().is_empty());
    }

    #[tokio::test]
    async fn actual_private_endpoint_checks_peers_and_preserves_frame_boundaries() {
        let fixture = tempfile::tempdir().unwrap();
        let name = if cfg!(windows) {
            format!(r"\\.\pipe\laymux-test-{}", uuid::Uuid::new_v4())
        } else {
            fixture
                .path()
                .join("daemon.sock")
                .to_string_lossy()
                .into_owned()
        };
        let mut listener = Listener::bind(&name).unwrap();
        assert!(
            Listener::bind(&name).is_err(),
            "a second daemon must not replace a live endpoint"
        );
        let client = tokio::spawn(async move {
            let mut stream = connect(&name).await.unwrap();
            write_frame(&mut stream, &serde_json::json!({"request":1}))
                .await
                .unwrap();
            assert_eq!(
                read_frame::<serde_json::Value>(&mut stream).await.unwrap(),
                serde_json::json!({"response":2})
            );
        });
        let mut stream = tokio::time::timeout(
            crate::daemon_protocol::CONNECTION_DEADLINE,
            listener.accept(),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(
            read_frame::<serde_json::Value>(&mut stream).await.unwrap(),
            serde_json::json!({"request":1})
        );
        write_frame(&mut stream, &serde_json::json!({"response":2}))
            .await
            .unwrap();
        client.await.unwrap();
    }
}
