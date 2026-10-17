use super::*;

fn user(uuid: &str, parent: &str) -> String {
    format!(
        r#"{{"parentUuid":"{parent}","isSidechain":false,"type":"user","message":{{"role":"user","content":"hi"}},"uuid":"{uuid}"}}"#
    )
}

fn assistant(uuid: &str, parent: &str) -> String {
    format!(
        r#"{{"parentUuid":"{parent}","isSidechain":false,"type":"assistant","message":{{"role":"assistant","stop_reason":"end_turn"}},"uuid":"{uuid}"}}"#
    )
}

fn api_error(uuid: &str, parent: &str) -> String {
    format!(
        r#"{{"parentUuid":"{parent}","isSidechain":false,"type":"assistant","message":{{"model":"<synthetic>","role":"assistant"}},"error":"authentication_failed","isApiErrorMessage":true,"uuid":"{uuid}"}}"#
    )
}

fn attachment(uuid: &str, parent: &str) -> String {
    format!(
        r#"{{"parentUuid":"{parent}","isSidechain":false,"attachment":{{"type":"hook_success","hookEvent":"Stop"}},"type":"attachment","uuid":"{uuid}"}}"#
    )
}

fn stop_summary(uuid: &str, parent: &str) -> String {
    format!(
        r#"{{"parentUuid":"{parent}","isSidechain":false,"type":"system","subtype":"stop_hook_summary","preventedContinuation":false,"uuid":"{uuid}"}}"#
    )
}

fn duration(uuid: &str, parent: &str) -> String {
    format!(
        r#"{{"parentUuid":"{parent}","isSidechain":false,"type":"system","subtype":"turn_duration","durationMs":1,"uuid":"{uuid}"}}"#
    )
}

fn interrupt(uuid: &str, parent: &str, marked: bool) -> String {
    let id = if marked {
        r#","interruptedMessageId":"msg_1""#
    } else {
        ""
    };
    format!(
        r#"{{"parentUuid":"{parent}","isSidechain":false,"type":"user","message":{{"role":"user","content":[{{"type":"text","text":"[Request interrupted by user]"}}]}},"uuid":"{uuid}"{id}}}"#
    )
}

fn local_command(uuid: &str, parent: &str) -> String {
    format!(
        r#"{{"parentUuid":"{parent}","isSidechain":false,"type":"user","message":{{"role":"user","content":"<command-name>/model</command-name>"}},"uuid":"{uuid}"}}"#
    )
}

fn sidechain_assistant(uuid: &str, parent: &str) -> String {
    format!(
        r#"{{"parentUuid":"{parent}","isSidechain":true,"type":"assistant","message":{{}},"uuid":"{uuid}"}}"#
    )
}

/// The normal end of a turn whose last assistant record is `last`.
fn ended(last: &str, prefix: &str) -> Vec<String> {
    vec![
        attachment(&format!("{prefix}h"), last),
        stop_summary(&format!("{prefix}s"), &format!("{prefix}h")),
        duration(&format!("{prefix}d"), &format!("{prefix}s")),
    ]
}

fn scan(lines: &[String]) -> ClaudeTurnOutcome {
    let mut scan = TurnScan::default();
    for line in lines {
        scan.push(line.as_bytes());
    }
    scan.outcome()
}

fn turn(lines: Vec<Vec<String>>) -> Vec<String> {
    lines.into_iter().flatten().collect()
}

#[test]
fn a_normal_turn_end_is_success() {
    let lines = turn(vec![
        vec![user("u1", "x"), assistant("a1", "u1")],
        ended("a1", "e1"),
    ]);
    assert_eq!(scan(&lines), ClaudeTurnOutcome::Success);
}

#[test]
fn an_api_error_before_turn_duration_is_failure() {
    let lines = turn(vec![
        vec![user("u1", "x"), api_error("a1", "u1")],
        vec![duration("d1", "a1")],
    ]);
    assert_eq!(scan(&lines), ClaudeTurnOutcome::Failure);
}

#[test]
fn an_interrupt_marker_with_its_message_id_is_interrupted() {
    let lines = vec![
        user("u1", "x"),
        assistant("a1", "u1"),
        interrupt("i1", "a1", true),
    ];
    assert_eq!(scan(&lines), ClaudeTurnOutcome::Interrupted);
}

#[test]
fn interrupt_text_without_a_message_id_is_not_a_boundary() {
    let lines = vec![user("u1", "x"), interrupt("i1", "u1", false)];
    assert_eq!(scan(&lines), ClaudeTurnOutcome::Pending);
}

#[test]
fn no_boundary_yet_is_pending() {
    let lines = vec![user("u1", "x"), assistant("a1", "u1")];
    assert_eq!(scan(&lines), ClaudeTurnOutcome::Pending);
}

#[test]
fn two_boundaries_are_unknown() {
    let lines = turn(vec![
        vec![user("u1", "x"), assistant("a1", "u1")],
        ended("a1", "e1"),
        vec![user("u2", "e1d")],
        vec![interrupt("i2", "u2", true)],
    ]);
    assert_eq!(scan(&lines), ClaudeTurnOutcome::Unknown);
}

/// Real 2.1.300 shape: after `turn_duration` an assistant record on another
/// parent path continues without a new prompt (Claude resuming on its own).
#[test]
fn work_continuing_after_the_boundary_is_unknown() {
    let lines = turn(vec![
        vec![user("u1", "x"), assistant("a1", "u1")],
        ended("a1", "e1"),
        vec![
            r#"{"parentUuid":"t9","isSidechain":false,"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result","content":"done"}]},"uuid":"r1"}"#.to_string(),
            assistant("a2", "r1"),
        ],
    ]);
    assert_eq!(scan(&lines), ClaudeTurnOutcome::Unknown);
}

#[test]
fn records_after_the_boundary_that_are_not_assistant_do_not_hide_it() {
    let lines = turn(vec![
        vec![user("u1", "x"), assistant("a1", "u1")],
        ended("a1", "e1"),
        vec![
            local_command("c1", "e1d"),
            r#"{"type":"last-prompt","lastPrompt":"x","leafUuid":"e1d"}"#.to_string(),
        ],
    ]);
    assert_eq!(scan(&lines), ClaudeTurnOutcome::Success);
}

#[test]
fn a_chain_leaving_the_read_range_is_unknown() {
    // The baseline fell after the assistant record the boundary closes.
    let lines = ended("a0", "e1");
    assert_eq!(scan(&lines), ClaudeTurnOutcome::Unknown);
}

#[test]
fn sidechain_records_are_ignored() {
    let lines = turn(vec![
        vec![user("u1", "x"), assistant("a1", "u1")],
        ended("a1", "e1"),
        vec![sidechain_assistant("s1", "e1d")],
    ]);
    assert_eq!(scan(&lines), ClaudeTurnOutcome::Success);
}

#[test]
fn an_unreadable_record_is_unknown() {
    let lines = vec![user("u1", "x"), "{not json".to_string()];
    assert_eq!(scan(&lines), ClaudeTurnOutcome::Unknown);
}

fn tracked(path: PathBuf) -> Tracked {
    let (file, start) = baseline(&path).unwrap();
    Tracked::new(1, "k".into(), Location::Open(file), start)
}

fn append(path: &Path, text: &str) {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new().append(true).open(path).unwrap();
    file.write_all(text.as_bytes()).unwrap();
}

fn lines_text(lines: &[String]) -> String {
    lines.iter().map(|line| format!("{line}\n")).collect()
}

#[test]
fn boundaries_before_the_baseline_belong_to_an_earlier_task() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("s.jsonl");
    let earlier = turn(vec![
        vec![user("u0", "x"), assistant("a0", "u0")],
        ended("a0", "e0"),
    ]);
    std::fs::write(&path, lines_text(&earlier)).unwrap();
    let mut entry = tracked(path.clone());
    // The previous success is behind the baseline; this task has no end yet.
    assert_eq!(entry.outcome(), ClaudeTurnOutcome::Pending);
    append(
        &path,
        &lines_text(&[user("u1", "e0d"), assistant("a1", "u1")]),
    );
    assert_eq!(entry.outcome(), ClaudeTurnOutcome::Pending);
    append(&path, &lines_text(&[interrupt("i1", "a1", true)]));
    assert_eq!(entry.outcome(), ClaudeTurnOutcome::Interrupted);
}

#[test]
fn a_line_still_being_written_is_read_on_the_next_lookup() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("s.jsonl");
    std::fs::write(&path, "").unwrap();
    let mut entry = tracked(path.clone());
    let lines = turn(vec![
        vec![user("u1", "x"), assistant("a1", "u1")],
        ended("a1", "e1"),
    ]);
    let text = lines_text(&lines);
    let (head, tail) = text.split_at(text.len() - 20);
    append(&path, head);
    assert_eq!(entry.outcome(), ClaudeTurnOutcome::Pending);
    append(&path, tail);
    assert_eq!(entry.outcome(), ClaudeTurnOutcome::Success);
}

#[test]
fn a_baseline_inside_a_line_skips_that_line() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("s.jsonl");
    let partial = user("u0", "x");
    std::fs::write(&path, &partial[..10]).unwrap();
    let mut entry = tracked(path.clone());
    assert!(entry.partial);
    append(&path, &format!("{}\n", &partial[10..]));
    let rest = turn(vec![
        vec![user("u1", "u0"), assistant("a1", "u1")],
        ended("a1", "e1"),
    ]);
    append(&path, &lines_text(&rest));
    assert_eq!(entry.outcome(), ClaudeTurnOutcome::Success);
}

#[test]
fn a_settled_result_does_not_change_with_later_boundaries() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("s.jsonl");
    std::fs::write(&path, "").unwrap();
    let mut entry = tracked(path.clone());
    let first = turn(vec![
        vec![user("u1", "x"), assistant("a1", "u1")],
        ended("a1", "e1"),
    ]);
    append(&path, &lines_text(&first));
    assert_eq!(entry.outcome(), ClaudeTurnOutcome::Success);
    append(&path, &lines_text(&[assistant("a2", "e1d")]));
    assert_eq!(entry.outcome(), ClaudeTurnOutcome::Success);
}

#[test]
fn a_shrunk_or_deleted_transcript_fills_no_result() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("s.jsonl");
    std::fs::write(&path, lines_text(&[user("u0", "x")])).unwrap();
    let mut entry = tracked(path.clone());
    std::fs::write(&path, "").unwrap();
    assert_eq!(entry.outcome(), ClaudeTurnOutcome::Unknown);

    // A deleted file stays readable through the held handle but never grows.
    std::fs::write(&path, lines_text(&[user("u0", "x")])).unwrap();
    let mut entry = tracked(path.clone());
    std::fs::remove_file(&path).unwrap();
    assert_eq!(entry.outcome(), ClaudeTurnOutcome::Pending);
}

#[test]
fn the_transcript_is_found_only_by_an_exact_unique_name() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(find_transcript(dir.path(), "s1"), Transcript::Absent);
    let projects = dir.path().join("projects");
    std::fs::create_dir_all(projects.join("D--a")).unwrap();
    std::fs::create_dir_all(projects.join("D--b")).unwrap();
    assert_eq!(find_transcript(dir.path(), "s1"), Transcript::Absent);
    std::fs::write(projects.join("D--a").join("s1.jsonl"), "").unwrap();
    std::fs::write(projects.join("D--b").join("s10.jsonl"), "").unwrap();
    assert_eq!(
        find_transcript(dir.path(), "s1"),
        Transcript::Found(projects.join("D--a").join("s1.jsonl"))
    );
    std::fs::write(projects.join("D--b").join("s1.jsonl"), "").unwrap();
    assert_eq!(find_transcript(dir.path(), "s1"), Transcript::Unknown);
}

/// Claude creates the transcript with the first prompt, which can land after
/// the task's start was observed: the whole file then belongs to the task.
#[test]
fn a_transcript_created_after_the_baseline_is_read_from_its_start() {
    let dir = tempfile::tempdir().unwrap();
    let project = dir.path().join("projects").join("D--a");
    std::fs::create_dir_all(&project).unwrap();
    let mut entry = Tracked::new(
        1,
        "k".into(),
        Location::NotYet {
            root: dir.path().to_path_buf(),
            session_id: "s1".into(),
        },
        Baseline::default(),
    );
    assert_eq!(entry.outcome(), ClaudeTurnOutcome::Pending);
    let first = turn(vec![
        vec![user("u1", "x"), assistant("a1", "u1")],
        ended("a1", "e1"),
    ]);
    std::fs::write(project.join("s1.jsonl"), lines_text(&first)).unwrap();
    assert_eq!(entry.outcome(), ClaudeTurnOutcome::Success);
}

#[test]
fn a_transcript_rewritten_in_place_is_unknown() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("s.jsonl");
    std::fs::write(&path, lines_text(&[user("u0", "x"), assistant("a0", "u0")])).unwrap();
    let mut entry = tracked(path.clone());
    // The same file rewritten with other content: the bytes before the read position changed.
    let replaced = turn(vec![
        vec![user("v0", "x"), assistant("b0", "v0")],
        vec![api_error("b1", "b0"), duration("d1", "b1")],
    ]);
    std::fs::write(&path, lines_text(&replaced)).unwrap();
    assert_eq!(entry.outcome(), ClaudeTurnOutcome::Unknown);
}

#[test]
fn appending_after_the_anchor_is_not_a_replacement() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("s.jsonl");
    std::fs::write(&path, lines_text(&[user("u0", "x")])).unwrap();
    let mut entry = tracked(path.clone());
    for step in [
        vec![user("u1", "u0")],
        vec![assistant("a1", "u1")],
        ended("a1", "e1"),
    ] {
        assert_eq!(entry.outcome(), ClaudeTurnOutcome::Pending);
        append(&path, &lines_text(&step));
    }
    assert_eq!(entry.outcome(), ClaudeTurnOutcome::Success);
}

/// A capped read must not settle a result that later records already in the
/// file would overturn.
#[test]
fn a_result_waits_until_the_whole_file_was_read() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("s.jsonl");
    std::fs::write(&path, "").unwrap();
    let mut entry = tracked(path.clone());
    let filler = format!(
        r#"{{"type":"api-request-blob","blob":"{}"}}"#,
        "x".repeat(1024 * 1024)
    );
    let mut lines = turn(vec![
        vec![user("u1", "x"), assistant("a1", "u1")],
        ended("a1", "e1"),
    ]);
    lines.extend(std::iter::repeat_n(filler, 9));
    lines.push(assistant("a2", "r9"));
    append(&path, &lines_text(&lines));
    assert!(std::fs::metadata(&path).unwrap().len() > READ_LIMIT);
    assert_eq!(entry.outcome(), ClaudeTurnOutcome::Pending);
    assert_eq!(entry.outcome(), ClaudeTurnOutcome::Unknown);
}

#[test]
fn pruning_drops_closed_replaced_and_abandoned_baselines() {
    let entry = |generation: u64, key: &str| {
        Tracked::new(generation, key.into(), Location::Done, Baseline::default())
    };
    let mut tracked = HashMap::from([
        ("closed".to_string(), vec![entry(1, "a")]),
        (
            "live".to_string(),
            vec![entry(1, "old"), entry(2, "now"), {
                let mut abandoned = entry(2, "gone");
                abandoned.looked_up = Some(Instant::now() - ABANDONED_AFTER);
                abandoned
            }],
        ),
    ]);
    prune(&mut tracked, &HashMap::from([("live".to_string(), 2)]));
    let keys: Vec<_> = tracked
        .values()
        .flatten()
        .map(|entry| entry.key.as_str())
        .collect();
    assert_eq!(keys, ["now"]);
}

/// Codex review shape: the path is replaced by a file whose tail matches the
/// anchor but whose earlier records differ. The held handle keeps reading the
/// original, which never gets the boundary, so no result is filled.
#[test]
fn a_path_replaced_by_another_file_fills_no_result() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("s.jsonl");
    let meta = format!(r#"{{"type":"last-prompt","pad":"{}"}}"#, "p".repeat(512));
    std::fs::write(&path, "").unwrap();
    let mut entry = tracked(path.clone());
    append(
        &path,
        &lines_text(&[user("u1", "x"), assistant("a", "u1"), meta.clone()]),
    );
    assert_eq!(entry.outcome(), ClaudeTurnOutcome::Pending);
    let swapped = dir.path().join("swap.jsonl");
    let mut other = lines_text(&[user("u1", "x"), api_error("a", "u1"), meta]);
    other.push_str(&lines_text(&[duration("d", "a")]));
    std::fs::write(&swapped, other).unwrap();
    std::fs::rename(&swapped, &path).unwrap();
    assert_eq!(entry.outcome(), ClaudeTurnOutcome::Pending);
}

#[test]
fn an_empty_baseline_replaced_by_another_file_fills_no_result() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("s.jsonl");
    std::fs::write(&path, "").unwrap();
    let mut entry = tracked(path.clone());
    let swapped = dir.path().join("swap.jsonl");
    let other = turn(vec![
        vec![user("u1", "x"), assistant("a1", "u1")],
        ended("a1", "e1"),
    ]);
    std::fs::write(&swapped, lines_text(&other)).unwrap();
    std::fs::rename(&swapped, &path).unwrap();
    assert_eq!(entry.outcome(), ClaudeTurnOutcome::Pending);
}

#[test]
fn a_settled_outcome_can_be_asked_again() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("s.jsonl");
    std::fs::write(&path, "").unwrap();
    let mut entry = tracked(path.clone());
    let lines = turn(vec![
        vec![user("u1", "x"), assistant("a1", "u1")],
        ended("a1", "e1"),
    ]);
    append(&path, &lines_text(&lines));
    assert_eq!(entry.outcome(), ClaudeTurnOutcome::Success);
    assert!(matches!(entry.location, Location::Done));
    assert_eq!(entry.outcome(), ClaudeTurnOutcome::Success);
}
