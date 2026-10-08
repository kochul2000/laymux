//! One ordered connection. Human input is never automatically retried.
use crate::daemon_protocol::{AttachmentStamp, Capability, Challenge, PROTOCOL_VERSION};
use crate::daemon_requests::{Authentication, Command, Request, Response};
use crate::daemon_wire::{read_frame, write_frame};
use crate::error::AppError;
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncWrite};

pub(crate) struct DaemonClient<T> {
    stream: T,
    request_id: u64,
    pub(crate) stamp: AttachmentStamp,
    pub(crate) catalog: Value,
    failed: bool,
}

impl<T: AsyncRead + AsyncWrite + Unpin> DaemonClient<T> {
    pub(crate) fn failed(&self) -> bool {
        self.failed
    }
    pub(crate) async fn authenticate(
        mut stream: T,
        key: &Capability,
        scope: &str,
        expected_incarnation: &str,
        expected_runtime: &str,
    ) -> Result<Self, AppError> {
        let challenge: Challenge = read_frame(&mut stream).await?;
        if challenge.protocol != PROTOCOL_VERSION
            || challenge.scope != scope
            || challenge.incarnation != expected_incarnation
            || challenge.runtime != expected_runtime
            || challenge.nonce.len() > 128
            || challenge.nonce.is_empty()
        {
            return Err(AppError::Other("daemon handshake identity rejected".into()));
        }
        write_frame(
            &mut stream,
            &Authentication {
                proof: key.proof(&challenge)?,
            },
        )
        .await?;
        let server: Authentication = read_frame(&mut stream).await?;
        key.verify_server(&challenge, &server.proof)?;
        write_frame(&mut stream, &Request::Attach).await?;
        let attached: Response = read_frame(&mut stream).await?;
        let value = valid_response(attached, 0)?;
        let stamp: AttachmentStamp = serde_json::from_value(value["stamp"].clone())?;
        if stamp.incarnation != expected_incarnation
            || stamp.epoch == 0
            || stamp.connection.is_empty()
        {
            return Err(AppError::Other(
                "daemon attachment identity rejected".into(),
            ));
        }
        if !value["catalog"].is_array() {
            return Err(AppError::Other("daemon catalog rejected".into()));
        }
        Ok(Self {
            stream,
            request_id: 0,
            stamp,
            catalog: value["catalog"].clone(),
            failed: false,
        })
    }

    pub(crate) async fn call(&mut self, command: Command) -> Result<Value, AppError> {
        if self.failed {
            return Err(AppError::Other("daemon connection unavailable".into()));
        }
        self.request_id = self
            .request_id
            .checked_add(1)
            .ok_or_else(|| AppError::Other("daemon request sequence exhausted".into()))?;
        let request = Request::Call {
            request_id: self.request_id,
            stamp: self.stamp.clone(),
            command,
        };
        // Once any transport outcome is ambiguous, this connection admits no
        // more operations. A later connection obtains a fresh attachment epoch.
        let outcome = async {
            write_frame(&mut self.stream, &request).await?;
            let response: Response = read_frame(&mut self.stream).await?;
            if response.request_id != self.request_id
                || response.result.is_some() == response.error.is_some()
            {
                return Err(AppError::Other("daemon response envelope rejected".into()));
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

pub(crate) fn valid_response(response: Response, id: u64) -> Result<Value, AppError> {
    if response.request_id != id || response.result.is_some() == response.error.is_some() {
        return Err(AppError::Other("daemon response envelope rejected".into()));
    }
    match (response.result, response.error) {
        (Some(value), None) => Ok(value),
        (None, Some(error)) => Err(AppError::Other(error)),
        _ => Err(AppError::Other("daemon response envelope rejected".into())),
    }
}
