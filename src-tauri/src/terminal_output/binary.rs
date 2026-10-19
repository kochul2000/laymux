//! Binary view of the immutable in-flight desktop envelope (ADR-0346).
use super::{TerminalOutputDeltaEnvelopeV3, TerminalOutputEnvelopeGeometryRun};
use crate::constants::TERMINAL_OUTPUT_ENVELOPE_MAX_WIRE_BYTES;
use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputBinaryNotice<'a> {
    transport: &'static str,
    version: u8,
    generation: u64,
    lease_token: &'a str,
    envelope_id: u64,
    grant_id: &'a Option<String>,
    seq_start: u64,
    seq_end: u64,
}
impl<'a> From<&'a TerminalOutputDeltaEnvelopeV3> for TerminalOutputBinaryNotice<'a> {
    fn from(v: &'a TerminalOutputDeltaEnvelopeV3) -> Self {
        Self {
            transport: "binary",
            version: v.version,
            generation: v.generation,
            lease_token: &v.lease_token,
            envelope_id: v.envelope_id,
            grant_id: &v.grant_id,
            seq_start: v.seq_start,
            seq_end: v.seq_end,
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Metadata<'a> {
    version: u8,
    generation: u64,
    lease_token: &'a str,
    envelope_id: u64,
    grant_id: &'a Option<String>,
    seq_start: u64,
    seq_end: u64,
    delta_ends: &'a [u32],
    geometry_runs: &'a [TerminalOutputEnvelopeGeometryRun],
}
pub fn encode_terminal_output_binary(v: &TerminalOutputDeltaEnvelopeV3) -> Result<Vec<u8>, String> {
    let header = serde_json::to_vec(&Metadata {
        version: v.version,
        generation: v.generation,
        lease_token: &v.lease_token,
        envelope_id: v.envelope_id,
        grant_id: &v.grant_id,
        seq_start: v.seq_start,
        seq_end: v.seq_end,
        delta_ends: &v.delta_ends,
        geometry_runs: &v.geometry_runs,
    })
    .map_err(|e| format!("failed to encode terminal output metadata: {e}"))?;
    let size = 4 + header.len() + v.data.len();
    if size >= TERMINAL_OUTPUT_ENVELOPE_MAX_WIRE_BYTES {
        return Err("terminal output binary packet exceeds wire limit".into());
    }
    let len = u32::try_from(header.len()).map_err(|_| "terminal output metadata too large")?;
    let mut packet = Vec::with_capacity(size);
    packet.extend_from_slice(&len.to_le_bytes());
    packet.extend_from_slice(&header);
    packet.extend_from_slice(&v.data);
    Ok(packet)
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal_output::TerminalGeometry;
    #[test]
    fn binary_packet_preserves_utf8_metadata_and_every_raw_byte() {
        let envelope = TerminalOutputDeltaEnvelopeV3 {
            version: 3,
            generation: 7,
            lease_token: "한글".into(),
            envelope_id: 4,
            grant_id: None,
            seq_start: 0,
            seq_end: 256,
            data: (0..=255).collect(),
            delta_ends: vec![256],
            geometry_runs: vec![TerminalOutputEnvelopeGeometryRun {
                delta_index: 0,
                geometry: TerminalGeometry::new(80, 24).unwrap(),
            }],
        };
        let packet = encode_terminal_output_binary(&envelope).unwrap();
        let len = u32::from_le_bytes(packet[..4].try_into().unwrap()) as usize;
        let metadata: serde_json::Value = serde_json::from_slice(&packet[4..4 + len]).unwrap();
        assert_eq!(metadata["leaseToken"], "한글");
        assert!(metadata.get("data").is_none());
        assert_eq!(&packet[4 + len..], envelope.data);
        let notice = serde_json::to_value(TerminalOutputBinaryNotice::from(&envelope)).unwrap();
        assert_eq!(notice["transport"], "binary");
        assert!(notice.get("data").is_none());
    }
}
