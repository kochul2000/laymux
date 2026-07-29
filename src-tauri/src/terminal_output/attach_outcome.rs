use super::desktop_integration::delivery_reason_code;
use super::*;

impl TerminalOutputSession {
    pub(super) fn attach_desktop_outcome(
        &self,
        max_snapshot_bytes: usize,
        window_bytes: usize,
    ) -> Result<DesktopTerminalOutputAttachOutcome, String> {
        if let Some(outcome) = self.current_fail_stopped_attach_outcome() {
            return Ok(outcome);
        }
        match self.attach_desktop(max_snapshot_bytes, window_bytes) {
            Ok(attachment) => Ok(DesktopTerminalOutputAttachOutcome::Attached(attachment)),
            Err(error) => match self.current_fail_stopped_attach_outcome() {
                Some(outcome) => Ok(outcome),
                None => Err(error),
            },
        }
    }

    fn current_fail_stopped_attach_outcome(&self) -> Option<DesktopTerminalOutputAttachOutcome> {
        let reason = self
            .desktop_delivery
            .diagnostics()
            .ok()
            .and_then(|diagnostics| diagnostics.close_reason)
            .or_else(|| self.delivery_failure())?;
        Some(DesktopTerminalOutputAttachOutcome::FailStopped {
            terminal_id: self.terminal_id.clone(),
            generation: self.generation,
            reason: delivery_reason_code(&reason),
        })
    }
}
