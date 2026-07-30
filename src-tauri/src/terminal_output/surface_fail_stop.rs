use super::*;

impl TerminalOutputSession {
    /// Fail-stop only the current desktop surface transport. The terminal and
    /// ring remain available for diagnostics until the user explicitly closes
    /// and recreates the terminal generation.
    pub fn fail_stop_desktop_surface(
        &self,
        generation: u64,
        token: &str,
        reason: &str,
    ) -> Result<bool, String> {
        let close_reason = parse_surface_fail_stop_reason(reason)?;
        if generation != self.generation {
            return Ok(false);
        }
        let _control = self.desktop_control_gate.lock_or_err()?;
        if self.desktop_delivery.diagnostics()?.lease_token.as_deref() != Some(token) {
            return Ok(false);
        }
        self.desktop_delivery.close(close_reason);
        Ok(true)
    }
}
fn parse_surface_fail_stop_reason(
    reason: &str,
) -> Result<TerminalOutputDeliveryCloseReason, String> {
    match reason {
        "surface_unavailable" => Ok(TerminalOutputDeliveryCloseReason::SurfaceUnavailable),
        "control_orphan_cap" => Ok(TerminalOutputDeliveryCloseReason::ControlOrphanCap),
        _ => Err("invalid terminal output surface fail-stop reason".into()),
    }
}
