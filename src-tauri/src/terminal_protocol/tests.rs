use super::*;

const SET_BRACKETED: &[u8] = b"\x1b[?2004h";
const RESET_BRACKETED: &[u8] = b"\x1b[?2004l";
const SOFT_RESET: &[u8] = b"\x1b[!p";
const FULL_RESET: &[u8] = b"\x1bc";

fn enabled_state() -> TerminalProtocolState {
    let mut state = TerminalProtocolState::new();
    assert!(state.process_output(SET_BRACKETED));
    assert!(state.bracketed_paste());
    state
}

#[test]
fn protocol_state_starts_disabled_at_revision_zero() {
    let state = TerminalProtocolState::new();
    assert_eq!(state.snapshot(), TerminalProtocolSnapshot::default());
    assert!(!state.bracketed_paste());
    assert_eq!(state.revision(), 0);
}

#[test]
fn set_sequence_survives_every_two_chunk_split() {
    for split in 0..=SET_BRACKETED.len() {
        let mut state = TerminalProtocolState::new();
        state.process_output(&SET_BRACKETED[..split]);
        state.process_output(&SET_BRACKETED[split..]);
        assert!(state.bracketed_paste(), "split={split}");
        assert_eq!(state.revision(), 1, "split={split}");
    }
}

#[test]
fn reset_sequence_survives_every_two_chunk_split() {
    for split in 0..=RESET_BRACKETED.len() {
        let mut state = enabled_state();
        state.process_output(&RESET_BRACKETED[..split]);
        state.process_output(&RESET_BRACKETED[split..]);
        assert!(!state.bracketed_paste(), "split={split}");
        assert_eq!(state.revision(), 2, "split={split}");
    }
}

#[test]
fn all_sequences_survive_one_byte_chunks() {
    let mut state = TerminalProtocolState::new();
    for byte in SET_BRACKETED {
        state.process_output(std::slice::from_ref(byte));
    }
    assert!(state.bracketed_paste());

    for byte in RESET_BRACKETED {
        state.process_output(std::slice::from_ref(byte));
    }
    assert!(!state.bracketed_paste());
    assert_eq!(state.revision(), 2);
}

#[test]
fn private_mode_parser_finds_2004_in_multiple_parameters() {
    for sequence in [
        b"\x1b[?2004;25h".as_slice(),
        b"\x1b[?1;2004;25h".as_slice(),
        b"\x1b[?1;25;2004h".as_slice(),
        b"\x1b[?;2004;;25h".as_slice(),
    ] {
        let mut state = TerminalProtocolState::new();
        assert!(state.process_output(sequence), "sequence={sequence:?}");
        assert!(state.bracketed_paste(), "sequence={sequence:?}");
        assert_eq!(state.revision(), 1);
    }

    let mut state = enabled_state();
    assert!(state.process_output(b"\x1b[?1;2004;25l"));
    assert!(!state.bracketed_paste());
    assert_eq!(state.revision(), 2);
}

#[test]
fn unrelated_private_modes_do_not_change_state() {
    let mut state = TerminalProtocolState::new();
    assert!(!state.process_output(b"\x1b[?1;25;2026h"));
    assert_eq!(state.snapshot(), TerminalProtocolSnapshot::default());
}

#[test]
fn revision_changes_only_for_effective_transitions() {
    let mut state = TerminalProtocolState::new();
    assert!(state.process_output(SET_BRACKETED));
    assert!(!state.process_output(SET_BRACKETED));
    assert_eq!(state.revision(), 1);

    assert!(state.process_output(RESET_BRACKETED));
    assert!(!state.process_output(RESET_BRACKETED));
    assert_eq!(state.revision(), 2);

    assert!(state.process_output(b"\x1b[?2004h\x1b[?2004h\x1b[?2004l\x1b[?2004l\x1b[?2004h"));
    assert!(state.bracketed_paste());
    assert_eq!(state.revision(), 5);
}

#[test]
fn incomplete_and_malformed_sequences_do_not_toggle_and_parser_recovers() {
    let mut state = TerminalProtocolState::new();
    assert!(!state.process_output(b"\x1b[?2004"));
    assert!(!state.process_output(b"x"));
    assert!(!state.process_output(b"\x1b[?20:04h"));
    assert!(!state.process_output(b"\x1b[?2004$h"));
    assert!(!state.process_output(b"\x1b[?2004\x18h"));
    assert_eq!(state.snapshot(), TerminalProtocolSnapshot::default());

    assert!(state.process_output(SET_BRACKETED));
    assert!(state.bracketed_paste());
    assert_eq!(state.revision(), 1);
}

#[test]
fn plain_text_and_utf8_cannot_fabricate_a_mode_transition() {
    let mut state = TerminalProtocolState::new();
    assert!(!state.process_output("일반 한글 출력 ?2004h 와 ESC 없는 [!p".as_bytes()));
    assert_eq!(state.snapshot(), TerminalProtocolSnapshot::default());
}

#[test]
fn full_and_soft_reset_survive_every_split() {
    for reset in [FULL_RESET, SOFT_RESET] {
        for split in 0..=reset.len() {
            let mut state = enabled_state();
            state.process_output(&reset[..split]);
            state.process_output(&reset[split..]);
            assert!(!state.bracketed_paste(), "reset={reset:?}, split={split}");
            assert_eq!(state.revision(), 2, "reset={reset:?}, split={split}");
        }
    }
}

#[test]
fn reset_is_noop_when_mode_is_already_disabled() {
    for reset in [FULL_RESET, SOFT_RESET] {
        let mut state = TerminalProtocolState::new();
        assert!(!state.process_output(reset));
        assert_eq!(state.revision(), 0);
    }

    let mut state = TerminalProtocolState::new();
    assert!(!state.reset());
    assert_eq!(state.revision(), 0);
}

#[test]
fn escape_restart_inside_partial_csi_recovers_as_a_reset() {
    let mut state = enabled_state();
    assert!(state.process_output(b"\x1b[?20\x1bc"));
    assert!(!state.bracketed_paste());
    assert_eq!(state.revision(), 2);
}

#[test]
fn encoder_normalizes_all_line_endings_to_cr() {
    let encoded = encode_terminal_input("a\r\nb\nc\rd", false, false, 64).unwrap();
    assert_eq!(encoded, b"a\rb\rc\rd");
}

#[test]
fn encoder_wraps_only_non_empty_text_and_places_submit_cr_after_suffix() {
    let encoded = encode_terminal_input("한글\nline", true, true, 64).unwrap();
    let mut expected = BRACKETED_PASTE_BEGIN.to_vec();
    expected.extend_from_slice("한글\rline".as_bytes());
    expected.extend_from_slice(BRACKETED_PASTE_END);
    expected.push(b'\r');
    assert_eq!(encoded, expected);
}

#[test]
fn encoder_unbracketed_submit_appends_one_cr() {
    assert_eq!(
        encode_terminal_input("echo hi", true, false, 64).unwrap(),
        b"echo hi\r"
    );
}

#[test]
fn encoder_empty_insert_and_send_do_not_emit_empty_paste_markers() {
    assert_eq!(
        encode_terminal_input("", false, true, 0).unwrap(),
        Vec::<u8>::new()
    );
    assert_eq!(encode_terminal_input("", true, true, 1).unwrap(), b"\r");
}

#[test]
fn encoder_preserves_unicode_bytes() {
    let text = "한글🙂é";
    assert_eq!(
        encode_terminal_input(text, false, false, text.len()).unwrap(),
        text.as_bytes()
    );
}

#[test]
fn encoder_limit_applies_to_complete_encoded_payload() {
    let encoded = encode_terminal_input("abc", true, true, 16).unwrap();
    assert_eq!(encoded.len(), 16);

    assert_eq!(
        encode_terminal_input("abc", true, true, 15),
        Err(TerminalInputEncodeError::PayloadTooLarge {
            encoded_bytes: 16,
            max_bytes: 15,
        })
    );
    assert_eq!(
        encode_terminal_input("abc", false, false, 2),
        Err(TerminalInputEncodeError::PayloadTooLarge {
            encoded_bytes: 3,
            max_bytes: 2,
        })
    );
    assert_eq!(
        encode_terminal_input("", true, false, 0),
        Err(TerminalInputEncodeError::PayloadTooLarge {
            encoded_bytes: 1,
            max_bytes: 0,
        })
    );
}

#[test]
fn encoder_limit_uses_normalized_byte_length() {
    assert_eq!(
        encode_terminal_input("a\r\nb", false, false, 3).unwrap(),
        b"a\rb"
    );
    assert_eq!(
        encode_terminal_input("한", false, false, 2),
        Err(TerminalInputEncodeError::PayloadTooLarge {
            encoded_bytes: 3,
            max_bytes: 2,
        })
    );
}
