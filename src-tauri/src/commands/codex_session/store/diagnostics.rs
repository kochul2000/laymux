use rusqlite::{Connection, OptionalExtension};

pub(super) fn find_process_uuid_checked(
    connection: &Connection,
    pid: u32,
) -> Result<Option<(String, i64)>, String> {
    let pattern = format!("pid:{pid}:*");
    let process_uuid: Option<String> = connection
        .query_row(
            "SELECT process_uuid
             FROM logs INDEXED BY idx_logs_process_uuid_threadless_ts
             WHERE thread_id IS NULL AND process_uuid GLOB ?1
             ORDER BY id DESC
             LIMIT 1",
            [&pattern],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("failed to query Codex process identity: {error}"))?;
    let Some(process_uuid) = process_uuid else {
        return Ok(None);
    };
    let first_log_id = connection
        .query_row(
            "SELECT MIN(id)
             FROM logs INDEXED BY idx_logs_process_uuid_threadless_ts
             WHERE thread_id IS NULL AND process_uuid = ?1
             LIMIT 1",
            [&process_uuid],
            |row| row.get(0),
        )
        .map_err(|error| format!("failed to query Codex process start: {error}"))?;
    Ok(Some((process_uuid, first_log_id)))
}

pub(super) fn find_process_thread_ids_checked(
    connection: &Connection,
    process_uuid: &str,
    first_log_id: i64,
) -> Result<Vec<String>, String> {
    let mut statement = connection
        .prepare(
            "SELECT thread_id, MAX(id) AS last_id
             FROM logs NOT INDEXED
             WHERE id >= ?1 AND process_uuid = ?2 AND thread_id IS NOT NULL
             GROUP BY thread_id
             ORDER BY last_id DESC",
        )
        .map_err(|error| format!("failed to prepare Codex thread query: {error}"))?;
    let rows = statement
        .query_map((first_log_id, process_uuid), |row| row.get::<_, String>(0))
        .map_err(|error| format!("failed to query Codex threads: {error}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("failed to read Codex thread rows: {error}"))
}

/// Codex 0.153 emits title-generation threads without a rollout. Their own
/// threadless startup span, not absence of a file or a model name, proves that
/// they are temporary. Keep the evidence scoped to this process incarnation.
pub(super) fn is_temporary_thread_checked(
    connection: &Connection,
    process_uuid: &str,
    first_log_id: i64,
    thread_id: &str,
) -> Result<bool, String> {
    let marker = format!("startup_prewarm{{otel.name=\"startup_prewarm\" thread.id={thread_id}}}");
    let mut statement = connection
        .prepare(
            "SELECT substr(feedback_log_body, 1, 2048)
         FROM logs INDEXED BY idx_logs_process_uuid_threadless_ts
         WHERE thread_id IS NULL AND process_uuid = ?1 AND id >= ?2
           AND feedback_log_body LIKE 'app_server.request{%'
           AND instr(feedback_log_body, ?3) > 0",
        )
        .map_err(|error| format!("failed to prepare Codex temporary thread query: {error}"))?;
    let rows = statement
        .query_map((process_uuid, first_log_id, &marker), |row| {
            row.get::<_, String>(0)
        })
        .map_err(|error| format!("failed to query Codex temporary thread: {error}"))?;
    for row in rows {
        let body =
            row.map_err(|error| format!("failed to read Codex temporary thread: {error}"))?;
        let Some((request, spans)) = body.split_once("}:") else {
            continue;
        };
        if request.contains("rpc.method=\"thread/start\"")
            && request.contains("rpc.request_id=temporary-structured-")
            && request.contains("app_server.client_name=\"codex-tui\"")
            && spans.starts_with("app_server.thread_start.create_thread{")
            && spans
                .split(": ")
                .next()
                .is_some_and(|prefix| prefix.contains(&marker))
        {
            return Ok(true);
        }
    }
    Ok(false)
}
