//! Authenticated observations use a separate connection from ordered controls.
use crate::daemon_client::valid_response;
use crate::daemon_protocol::{AttachmentStamp, Capability, Challenge, PROTOCOL_VERSION};
use crate::daemon_requests::{Authentication, ReadCommand, Request, Response};
use crate::daemon_wire::{read_frame, read_frame_with_deadline, write_frame};
use crate::error::AppError;
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncWrite};

pub(crate) struct DaemonReader<T> {
    stream: T,
    stamp: AttachmentStamp,
    request_id: u64,
    failed: bool,
}

impl<T: AsyncRead + AsyncWrite + Unpin> DaemonReader<T> {
    pub(crate) async fn authenticate(
        mut stream: T,
        key: &Capability,
        scope: &str,
        runtime: &str,
        stamp: AttachmentStamp,
    ) -> Result<Self, AppError> {
        let challenge: Challenge = read_frame(&mut stream).await?;
        if challenge.protocol != PROTOCOL_VERSION
            || challenge.scope != scope
            || challenge.incarnation != stamp.incarnation
            || challenge.runtime != runtime
            || challenge.nonce.is_empty()
            || challenge.nonce.len() > 128
        {
            return Err(AppError::Other(
                "daemon read handshake identity rejected".into(),
            ));
        }
        write_frame(
            &mut stream,
            &Authentication {
                proof: key.proof(&challenge)?,
            },
        )
        .await?;
        let proof: Authentication = read_frame(&mut stream).await?;
        key.verify_server(&challenge, &proof.proof)?;
        Ok(Self {
            stream,
            stamp,
            request_id: 0,
            failed: false,
        })
    }

    pub(crate) async fn call(&mut self, query: ReadCommand) -> Result<Value, AppError> {
        if self.failed {
            return Err(AppError::Other("daemon read connection unavailable".into()));
        }
        self.request_id = self
            .request_id
            .checked_add(1)
            .ok_or_else(|| AppError::Other("daemon read request sequence exhausted".into()))?;
        let deadline = if matches!(query, ReadCommand::Attributions { .. }) {
            std::time::Duration::from_secs(35)
        } else {
            crate::daemon_protocol::CONNECTION_DEADLINE
        };
        let outcome = async {
            write_frame(
                &mut self.stream,
                &Request::Read {
                    request_id: self.request_id,
                    stamp: self.stamp.clone(),
                    query,
                },
            )
            .await?;
            let response: Response = read_frame_with_deadline(&mut self.stream, deadline).await?;
            if response.request_id != self.request_id
                || response.result.is_some() == response.error.is_some()
            {
                return Err(AppError::Other(
                    "daemon read response envelope rejected".into(),
                ));
            }
            Ok(response)
        }
        .await;
        match outcome {
            Ok(response) => valid_response(response, self.request_id),
            Err(error) => {
                self.failed = true;
                Err(error)
            }
        }
    }
}
