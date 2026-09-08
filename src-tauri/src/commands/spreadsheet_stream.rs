//! Demand-driven cell parsing. The worker owns the borrowed calamine reader.
use super::spreadsheet_viewer::{
    open_workbook, parse_error, SpreadsheetContent, MAX_CELLS, MAX_ROWS,
};
use crate::{error::AppError, lock_ext::MutexExt};
use calamine::{Data, Reader, Sheets};
use std::{
    collections::HashMap,
    sync::{mpsc, Mutex},
    thread,
};

const WINDOW_ROWS: u32 = 100;
const MAX_STREAMS: usize = 4;
type Reply = mpsc::SyncSender<Result<SpreadsheetWindow, String>>;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpreadsheetWindow {
    pub session_id: String,
    pub content: SpreadsheetContent,
    pub loaded_rows: u32,
    pub has_more: bool,
}

struct Stream {
    requests: mpsc::SyncSender<Reply>,
    worker: thread::JoinHandle<()>,
}

#[derive(Default)]
pub struct SpreadsheetStreams(Mutex<HashMap<String, Stream>>);

impl SpreadsheetStreams {
    pub fn open(&self, path: String, sheet: Option<String>) -> Result<SpreadsheetWindow, AppError> {
        let id = uuid::Uuid::new_v4().to_string();
        let (requests, receiver) = mpsc::sync_channel::<Reply>(1);
        let worker_id = id.clone();
        let mut streams = self.0.lock_or_err()?;
        streams.retain(|_, stream| !stream.worker.is_finished());
        if streams.len() >= MAX_STREAMS {
            return Err(parse_error("close another spreadsheet preview first"));
        }
        let worker = thread::Builder::new()
            .name("spreadsheet-reader".into())
            .spawn(move || {
                // Opening/parsing starts only after the first request; dropping the
                // sender on close also releases a worker waiting between windows.
                let Ok(first) = receiver.recv() else {
                    return;
                };
                if let Err(error) = run(
                    &worker_id,
                    &path,
                    sheet.as_deref(),
                    first.clone(),
                    &receiver,
                ) {
                    let _ = first.send(Err(error.to_string()));
                }
            })?;
        streams.insert(id.clone(), Stream { requests, worker });
        drop(streams);
        self.next(&id)
    }

    pub fn next(&self, id: &str) -> Result<SpreadsheetWindow, AppError> {
        let sender = self
            .0
            .lock_or_err()?
            .get(id)
            .map(|stream| stream.requests.clone())
            .ok_or_else(|| parse_error("spreadsheet preview is closed"))?;
        let (reply, response) = mpsc::sync_channel(1);
        // Do not queue repeated scroll requests behind the active parse.
        sender.try_send(reply).map_err(parse_error)?;
        response.recv().map_err(parse_error)?.map_err(parse_error)
    }

    pub fn close(&self, id: &str) -> Result<(), AppError> {
        self.0.lock_or_err()?.remove(id);
        Ok(())
    }
}

#[tauri::command(async)]
pub fn open_spreadsheet_for_viewer(
    state: tauri::State<'_, SpreadsheetStreams>,
    path: String,
    sheet: Option<String>,
) -> Result<SpreadsheetWindow, String> {
    state.open(path, sheet).map_err(String::from)
}

#[tauri::command(async)]
pub fn next_spreadsheet_for_viewer(
    state: tauri::State<'_, SpreadsheetStreams>,
    session_id: String,
) -> Result<SpreadsheetWindow, String> {
    state.next(&session_id).map_err(String::from)
}

#[tauri::command(async)]
pub fn close_spreadsheet_for_viewer(
    state: tauri::State<'_, SpreadsheetStreams>,
    session_id: String,
) -> Result<(), String> {
    state.close(&session_id).map_err(String::from)
}

fn run(
    id: &str,
    path: &str,
    sheet: Option<&str>,
    first: Reply,
    receiver: &mpsc::Receiver<Reply>,
) -> Result<(), AppError> {
    let (mut book, names, selected) = open_workbook(path, sheet)?;
    if names.is_empty() {
        windows(id, names, selected, first, receiver, || Ok(None));
        return Ok(());
    }
    match &mut book {
        Sheets::Xlsx(book) => {
            let mut reader = book
                .worksheet_cells_reader(&selected)
                .map_err(parse_error)?;
            windows(id, names, selected, first, receiver, || {
                reader
                    .next_cell()
                    .map(|cell| {
                        cell.map(|cell| (cell.get_position(), Data::from(cell.get_value().clone())))
                    })
                    .map_err(parse_error)
            });
        }
        Sheets::Xlsb(book) => {
            let mut reader = book
                .worksheet_cells_reader(&selected)
                .map_err(parse_error)?;
            windows(id, names, selected, first, receiver, || {
                reader
                    .next_cell()
                    .map(|cell| {
                        cell.map(|cell| (cell.get_position(), Data::from(cell.get_value().clone())))
                    })
                    .map_err(parse_error)
            });
        }
        _ => {
            let range = book.worksheet_range(&selected).map_err(parse_error)?;
            let (start_row, start_column) = range.start().unwrap_or_default();
            let mut cells = range.used_cells();
            windows(id, names, selected, first, receiver, || {
                Ok(cells.next().map(|(row, column, value)| {
                    (
                        (start_row + row as u32, start_column + column as u32),
                        value.clone(),
                    )
                }))
            });
        }
    }
    Ok(())
}

fn windows(
    id: &str,
    names: Vec<String>,
    sheet: String,
    first: Reply,
    receiver: &mpsc::Receiver<Reply>,
    mut next: impl FnMut() -> Result<Option<((u32, u32), Data)>, AppError>,
) {
    let (mut boundary, mut value_bytes, mut cell_count) = (WINDOW_ROWS, 0, 0);
    let mut pending = None;
    let mut reply = first;
    loop {
        let mut content = SpreadsheetContent {
            sheet_names: names.clone(),
            sheet: sheet.clone(),
            cells: Vec::new(),
            total_rows: 0,
            total_columns: 0,
            truncated: false,
        };
        let mut has_more = false;
        loop {
            let cell = match pending.take().map(Ok).unwrap_or_else(&mut next) {
                Ok(Some(cell)) => cell,
                Ok(None) => break,
                Err(error) => {
                    let _ = reply.send(Err(error.to_string()));
                    return;
                }
            };
            if cell.0 .0 >= MAX_ROWS || cell_count >= MAX_CELLS {
                content.truncated = true;
                break;
            }
            if cell.0 .0 >= boundary {
                pending = Some(Some(cell));
                has_more = true;
                break;
            }
            let before = content.cells.len();
            content.push(cell.0, &cell.1, &mut value_bytes);
            cell_count += content.cells.len() - before;
            if content.truncated {
                break;
            }
        }
        let loaded_rows = if has_more {
            boundary
        } else {
            content.total_rows.max(boundary.saturating_sub(WINDOW_ROWS))
        };
        if reply
            .send(Ok(SpreadsheetWindow {
                session_id: id.into(),
                content,
                loaded_rows,
                has_more,
            }))
            .is_err()
            || !has_more
        {
            return;
        }
        let Ok(request) = receiver.recv() else {
            return;
        };
        reply = request;
        boundary = (boundary + WINDOW_ROWS).min(MAX_ROWS);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    #[test]
    fn parser_waits_between_windows_and_stops_when_closed() {
        let calls = Arc::new(AtomicUsize::new(0));
        let counted = calls.clone();
        let (requests, receiver) = mpsc::sync_channel::<Reply>(1);
        let (reply, results) = mpsc::sync_channel(1);
        let worker = thread::spawn(move || {
            windows(
                "test",
                vec!["Sheet".into()],
                "Sheet".into(),
                reply,
                &receiver,
                || {
                    let row = counted.fetch_add(1, Ordering::SeqCst) as u32;
                    Ok((row < 250).then_some(((row, 0), Data::Int(i64::from(row)))))
                },
            )
        });
        let first = results.recv().unwrap().unwrap();
        assert_eq!(first.content.cells.len(), 100);
        assert_eq!(calls.load(Ordering::SeqCst), 101);
        assert!(first.has_more);
        let (reply, results) = mpsc::sync_channel(1);
        requests.send(reply).unwrap();
        let second = results.recv().unwrap().unwrap();
        assert_eq!(second.content.cells[0].row, 100);
        assert_eq!(calls.load(Ordering::SeqCst), 201);
        drop(requests);
        worker.join().unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 201);
    }
}
