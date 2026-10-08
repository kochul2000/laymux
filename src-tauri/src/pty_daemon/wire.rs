//! Length-prefixed private IPC. Never allocate before validating the length.
use crate::daemon_protocol::{CONNECTION_DEADLINE, MAX_FRAME_BYTES};
use crate::error::AppError;
use serde::{de::DeserializeOwned, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub(crate) async fn read_frame<T: DeserializeOwned>(
    reader: &mut (impl AsyncRead + Unpin),
) -> Result<T, AppError> {
    read_frame_with_deadline(reader, CONNECTION_DEADLINE).await
}

pub(crate) async fn read_frame_with_deadline<T: DeserializeOwned>(
    reader: &mut (impl AsyncRead + Unpin),
    deadline: std::time::Duration,
) -> Result<T, AppError> {
    tokio::time::timeout(deadline, async {
        let size = reader.read_u32().await? as usize;
        if size == 0 || size > MAX_FRAME_BYTES {
            return Err(AppError::Other("daemon frame size rejected".into()));
        }
        let mut payload = vec![0; size];
        reader.read_exact(&mut payload).await?;
        Ok(serde_json::from_slice(&payload)?)
    })
    .await
    .map_err(|_| AppError::Other("daemon read deadline exceeded".into()))?
}

pub(crate) async fn write_frame<T: Serialize>(
    writer: &mut (impl AsyncWrite + Unpin),
    payload: &T,
) -> Result<(), AppError> {
    let payload = serde_json::to_vec(payload)?;
    if payload.is_empty() || payload.len() > MAX_FRAME_BYTES {
        return Err(AppError::Other(
            "daemon outgoing frame size rejected".into(),
        ));
    }
    tokio::time::timeout(CONNECTION_DEADLINE, async {
        writer.write_u32(payload.len() as u32).await?;
        writer.write_all(&payload).await?;
        writer.flush().await?;
        Ok::<_, AppError>(())
    })
    .await
    .map_err(|_| AppError::Other("daemon write deadline exceeded".into()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[tokio::test]
    async fn independent_frames_survive_fragmented_io() {
        let (mut sender, mut receiver) = tokio::io::duplex(3);
        let producer = tokio::spawn(async move {
            write_frame(&mut sender, &json!({"text":"한글🙂"}))
                .await
                .unwrap();
            write_frame(&mut sender, &json!({"seq":2})).await.unwrap();
        });
        assert_eq!(
            read_frame::<Value>(&mut receiver).await.unwrap(),
            json!({"text":"한글🙂"})
        );
        assert_eq!(
            read_frame::<Value>(&mut receiver).await.unwrap(),
            json!({"seq":2})
        );
        producer.await.unwrap();
    }

    #[tokio::test]
    async fn oversized_header_is_rejected_without_waiting_for_a_body() {
        let (mut sender, mut receiver) = tokio::io::duplex(8);
        sender
            .write_u32((MAX_FRAME_BYTES + 1) as u32)
            .await
            .unwrap();
        let result = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            read_frame::<Value>(&mut receiver),
        )
        .await
        .unwrap();
        assert!(result.unwrap_err().to_string().contains("size rejected"));
    }

    #[tokio::test]
    async fn truncated_and_invalid_json_frames_fail_closed() {
        for data in [b"{oops".as_slice(), b"\"unterminated".as_slice()] {
            let (mut sender, mut receiver) = tokio::io::duplex(64);
            sender.write_u32(data.len() as u32).await.unwrap();
            sender.write_all(data).await.unwrap();
            drop(sender);
            assert!(read_frame::<Value>(&mut receiver).await.is_err());
        }
        let (mut sender, mut receiver) = tokio::io::duplex(8);
        sender.write_u32(1024).await.unwrap();
        drop(sender);
        assert!(read_frame::<Value>(&mut receiver).await.is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn idle_or_partial_clients_do_not_hold_connections_forever() {
        let (_sender, mut receiver) = tokio::io::duplex(8);
        assert!(read_frame::<Value>(&mut receiver)
            .await
            .unwrap_err()
            .to_string()
            .contains("deadline"));
    }
}
