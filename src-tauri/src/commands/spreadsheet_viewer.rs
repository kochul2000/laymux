//! Desktop-only, read-only spreadsheet data (ADR-0242).
use crate::{error::AppError, path_utils};
use calamine::{Data, DataType, Ods, Reader, Sheets, Xls, Xlsb, Xlsx};
use std::io::{Cursor, Read};

const MAX_SOURCE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_INFLATED_BYTES: u64 = 64 * 1024 * 1024;
const MAX_ZIP_ENTRIES: usize = 2_048;
const MAX_ODS_CELLS: u64 = 1_000_000;
const MAX_ROWS: u32 = 10_000;
const MAX_COLUMNS: u32 = 256;
const MAX_CELLS: usize = 100_000;
const MAX_VALUE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpreadsheetCell {
    pub row: u32,
    pub column: u32,
    pub value: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpreadsheetContent {
    pub sheet_names: Vec<String>,
    pub sheet: String,
    pub cells: Vec<SpreadsheetCell>,
    pub total_rows: u32,
    pub total_columns: u32,
    pub truncated: bool,
}

#[tauri::command(async)]
pub fn read_spreadsheet_for_viewer(
    path: String,
    sheet: Option<String>,
) -> Result<SpreadsheetContent, String> {
    read_spreadsheet(&path, sheet.as_deref()).map_err(String::from)
}

fn parse_error(error: impl std::fmt::Display) -> AppError {
    AppError::Other(format!("Cannot read spreadsheet: {error}"))
}

fn read_spreadsheet(path: &str, sheet: Option<&str>) -> Result<SpreadsheetContent, AppError> {
    let resolved = path_utils::resolve_address_path_following_symlinks(path, None);
    let ext = std::path::Path::new(&resolved)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(ext.as_str(), "xls" | "xlsx" | "xlsb" | "ods") {
        return Err(parse_error("supported formats: xls, xlsx, xlsb, ods"));
    }
    let file = std::fs::File::open(&resolved)?;
    if file.metadata()?.len() > MAX_SOURCE_BYTES {
        return Err(parse_error("file exceeds the 16 MiB viewer limit"));
    }
    let mut bytes = Vec::new();
    file.take(MAX_SOURCE_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_SOURCE_BYTES {
        return Err(parse_error("file exceeds the 16 MiB viewer limit"));
    }
    if ext != "xls" {
        validate_container(&bytes, ext == "ods")?;
    }
    // No persistent workbook cache: switching sheets reopens the file, so a
    // changed file is never paired with cells from a previous cached version.
    let source = Cursor::new(bytes);
    let mut book = match ext.as_str() {
        "xls" => Sheets::Xls(Xls::new(source).map_err(parse_error)?),
        "xlsx" => Sheets::Xlsx(Xlsx::new(source).map_err(parse_error)?),
        "xlsb" => Sheets::Xlsb(Xlsb::new(source).map_err(parse_error)?),
        _ => Sheets::Ods(Ods::new(source).map_err(parse_error)?),
    };
    let names: Vec<String> = book
        .sheets_metadata()
        .iter()
        .filter(|s| s.typ == calamine::SheetType::WorkSheet)
        .map(|s| s.name.clone())
        .collect();
    let selected = match sheet {
        Some(name) if !names.iter().any(|s| s == name) => {
            return Err(parse_error("sheet not found"))
        }
        Some(name) => name.to_owned(),
        None => names.first().cloned().unwrap_or_default(),
    };
    let mut result = SpreadsheetContent {
        sheet_names: names,
        sheet: selected.clone(),
        cells: Vec::new(),
        total_rows: 0,
        total_columns: 0,
        truncated: false,
    };
    if result.sheet_names.is_empty() {
        return Ok(result);
    }
    let mut value_bytes = 0;
    match &mut book {
        Sheets::Xlsx(book) => {
            let mut reader = book
                .worksheet_cells_reader(&selected)
                .map_err(parse_error)?;
            while let Some(cell) = reader.next_cell().map_err(parse_error)? {
                result.push(
                    cell.get_position(),
                    &Data::from(cell.get_value().clone()),
                    &mut value_bytes,
                );
                if result.truncated {
                    break;
                }
            }
        }
        Sheets::Xlsb(book) => {
            let mut reader = book
                .worksheet_cells_reader(&selected)
                .map_err(parse_error)?;
            while let Some(cell) = reader.next_cell().map_err(parse_error)? {
                result.push(
                    cell.get_position(),
                    &Data::from(cell.get_value().clone()),
                    &mut value_bytes,
                );
                if result.truncated {
                    break;
                }
            }
        }
        _ => {
            let range = book.worksheet_range(&selected).map_err(parse_error)?;
            let (row_start, column_start) = range.start().unwrap_or_default();
            for (row, column, value) in range.used_cells() {
                result.push(
                    (row_start + row as u32, column_start + column as u32),
                    value,
                    &mut value_bytes,
                );
                if result.truncated {
                    break;
                }
            }
        }
    }
    Ok(result)
}

impl SpreadsheetContent {
    fn push(&mut self, (row, column): (u32, u32), data: &Data, value_bytes: &mut usize) {
        if data.is_empty() {
            return;
        }
        self.total_rows = self.total_rows.max(row.saturating_add(1));
        self.total_columns = self.total_columns.max(column.saturating_add(1));
        if row >= MAX_ROWS || column >= MAX_COLUMNS || self.cells.len() >= MAX_CELLS {
            self.truncated = true;
            return;
        }
        let value = match data {
            Data::DateTime(date) if !date.is_duration() => date
                .as_datetime()
                .map(|d| d.format("%Y-%m-%d %H:%M:%S").to_string())
                .unwrap_or_else(|| data.to_string()),
            _ => data.to_string(),
        };
        if value.len() > MAX_VALUE_BYTES.saturating_sub(*value_bytes) {
            self.truncated = true;
            return;
        }
        *value_bytes += value.len();
        self.cells.push(SpreadsheetCell { row, column, value });
    }
}

/// Validate actual inflated bytes before calamine parses shared strings or ODS
/// repeated rows. Nothing is extracted to the filesystem.
fn validate_container(bytes: &[u8], ods: bool) -> Result<(), AppError> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(parse_error)?;
    if archive.len() > MAX_ZIP_ENTRIES {
        return Err(parse_error("too many ZIP entries"));
    }
    let mut remaining = MAX_INFLATED_BYTES;
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(parse_error)?;
        if entry.size() > remaining {
            return Err(parse_error(
                "expanded workbook exceeds the 64 MiB viewer limit",
            ));
        }
        let is_content = ods && entry.name() == "content.xml";
        let mut data = Vec::new();
        entry.take(remaining + 1).read_to_end(&mut data)?;
        if data.len() as u64 > remaining {
            return Err(parse_error(
                "expanded workbook exceeds the 64 MiB viewer limit",
            ));
        }
        remaining -= data.len() as u64;
        if is_content {
            validate_ods_repeats(&data)?;
        }
    }
    Ok(())
}

fn validate_ods_repeats(bytes: &[u8]) -> Result<(), AppError> {
    use quick_xml::events::Event;
    let mut xml = quick_xml::Reader::from_reader(bytes);
    xml.config_mut().expand_empty_elements = true;
    let (mut depth, mut in_table, mut in_row) = (0_usize, false, false);
    let (mut rows, mut columns, mut widest) = (0_u64, 0_u64, 0_u64);
    let (mut in_cell, mut has_value) = (false, false);
    let (mut completed_cells, mut sheet_cells) = (0_u64, 0_u64);
    let (mut row_repeat, mut column_repeat, mut text_bytes) = (1_u64, 1_u64, 0_u64);
    loop {
        let mut added_text = 0_u64;
        let event = xml.read_event().map_err(parse_error)?;
        match &event {
            Event::Start(_) => {
                depth += 1;
                if depth > 256 {
                    return Err(parse_error("ODS XML nesting exceeds the viewer limit"));
                }
            }
            Event::End(_) => {
                depth = depth
                    .checked_sub(1)
                    .ok_or_else(|| parse_error("invalid ODS XML"))?
            }
            Event::Eof if depth != 0 => return Err(parse_error("incomplete ODS XML")),
            _ => {}
        }
        match event {
            Event::Start(ref tag) | Event::Empty(ref tag) => match tag.name().as_ref() {
                b"table:table" => {
                    if in_table {
                        return Err(parse_error("nested ODS table"));
                    }
                    in_table = true;
                    completed_cells = completed_cells.saturating_add(sheet_cells);
                    sheet_cells = 0;
                    rows = 0;
                    widest = 0;
                    has_value = false;
                    in_cell = false;
                }
                b"table:table-row" => {
                    if !in_table || in_row {
                        return Err(parse_error("invalid ODS row nesting"));
                    }
                    in_row = true;
                    row_repeat = repeat_count(tag, b"table:number-rows-repeated")?.max(1);
                    rows = rows.saturating_add(row_repeat);
                    columns = 0;
                    in_cell = false;
                    has_value = false;
                }
                b"table:table-cell" | b"table:covered-table-cell" => {
                    if !in_row || in_cell {
                        return Err(parse_error("invalid ODS cell nesting"));
                    }
                    column_repeat = repeat_count(tag, b"table:number-columns-repeated")?.max(1);
                    columns = columns.saturating_add(column_repeat);
                    in_cell = true;
                    has_value = false;
                    for attr in tag.attributes() {
                        let attr = attr.map_err(parse_error)?;
                        let value_attribute = matches!(
                            attr.key.as_ref(),
                            b"office:value"
                                | b"office:string-value"
                                | b"office:boolean-value"
                                | b"office:date-value"
                                | b"office:time-value"
                                | b"table:formula"
                        );
                        has_value |= value_attribute;
                        has_value |= attr.key.as_ref() == b"office:value-type"
                            && attr.value.as_ref() == b"string";
                        if value_attribute {
                            added_text = added_text
                                .saturating_add((attr.value.len() as u64).saturating_mul(4));
                        }
                    }
                }
                b"text:s" if in_cell => {
                    added_text = repeat_count(tag, b"text:c")?;
                    has_value |= added_text > 0;
                }
                b"text:p" | b"text:tab" | b"text:line-break" if in_cell => {
                    added_text = 1;
                    has_value = true;
                }
                _ => {}
            },
            Event::Text(ref text) if in_cell => {
                has_value |= !text.is_empty();
                // Conservative UTF-8 bound for XML using a legacy encoding.
                added_text = (text.len() as u64).saturating_mul(4);
            }
            Event::CData(ref text) if in_cell => {
                has_value |= !text.is_empty();
                added_text = (text.len() as u64).saturating_mul(4);
            }
            Event::GeneralRef(ref entity) if in_cell => {
                has_value = true;
                added_text = (entity.len() as u64).max(4);
            }
            Event::End(ref tag)
                if matches!(
                    tag.name().as_ref(),
                    b"table:table-cell" | b"table:covered-table-cell"
                ) =>
            {
                in_cell = false;
                has_value = false;
            }
            Event::End(ref tag) if tag.name().as_ref() == b"table:table-row" => {
                in_row = false;
                has_value = false;
            }
            Event::End(ref tag) if tag.name().as_ref() == b"table:table" => {
                in_table = false;
                has_value = false;
            }
            Event::Eof => break,
            _ => {}
        }
        // ODS stores text:s counts and repeated strings compactly. Calamine
        // expands both before returning a Range, so the IPC value cap is too late.
        text_bytes = text_bytes.saturating_add(
            added_text
                .saturating_mul(row_repeat)
                .saturating_mul(column_repeat),
        );
        if text_bytes > MAX_INFLATED_BYTES {
            return Err(parse_error(
                "ODS text expansion exceeds the 64 MiB viewer limit",
            ));
        }
        // LibreOffice writes trailing empty rows/columns up to the sheet
        // boundary. Calamine discards those, so only populated extents count.
        if has_value {
            widest = widest.max(columns);
            sheet_cells = rows.saturating_mul(widest);
            if completed_cells.saturating_add(sheet_cells) > MAX_ODS_CELLS {
                return Err(parse_error("ODS repeated cells exceed the viewer limit"));
            }
        }
    }
    Ok(())
}

fn repeat_count(tag: &quick_xml::events::BytesStart<'_>, name: &[u8]) -> Result<u64, AppError> {
    for attr in tag.attributes() {
        let attr = attr.map_err(parse_error)?;
        if attr.key.as_ref() == name {
            return std::str::from_utf8(&attr.value)
                .map_err(parse_error)?
                .parse::<u64>()
                .map_err(parse_error);
        }
    }
    Ok(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sparse_far_cell_and_value_budget_are_explicitly_truncated() {
        let mut content = SpreadsheetContent {
            sheet_names: vec![],
            sheet: String::new(),
            cells: vec![],
            total_rows: 0,
            total_columns: 0,
            truncated: false,
        };
        let mut bytes = 0;
        content.push((1_048_575, 16_383), &Data::Float(1.0), &mut bytes);
        assert!(content.truncated);
        assert!(content.cells.is_empty());
        assert_eq!(content.total_rows, 1_048_576);
        bytes = MAX_VALUE_BYTES;
        content.push((0, 0), &Data::String("x".into()), &mut bytes);
        assert!(content.cells.is_empty());
    }

    #[test]
    fn ods_repeated_cell_bomb_is_rejected_before_parsing() {
        assert!(validate_ods_repeats(br#"<table:table><table:table-row table:number-rows-repeated="1000000"><table:table-cell table:number-columns-repeated="1000000" office:value="1"/></table:table-row></table:table>"#).is_err());
    }

    #[test]
    fn trailing_empty_ods_cells_and_whitespace_do_not_count_as_values() {
        assert!(validate_ods_repeats(br#"<table:table><table:table-row><table:table-cell office:value="1"/><table:table-cell table:number-columns-repeated="16383"/>
        </table:table-row><table:table-row table:number-rows-repeated="1048575"><table:table-cell table:number-columns-repeated="16384"/>
        </table:table-row></table:table>"#).is_ok());
    }

    #[test]
    fn ods_space_and_string_repeats_are_bounded_before_calamine_allocates() {
        let spaces = br#"<table:table><table:table-row><table:table-cell><text:p><text:s text:c="1000000000"/></text:p></table:table-cell></table:table-row></table:table>"#;
        assert!(validate_ods_repeats(spaces)
            .unwrap_err()
            .to_string()
            .contains("text expansion"));
        let repeated = format!(
            r#"<table:table><table:table-row table:number-rows-repeated="256"><table:table-cell table:number-columns-repeated="256"><text:p>{}</text:p></table:table-cell></table:table-row></table:table>"#,
            "x".repeat(1025)
        );
        assert!(validate_ods_repeats(repeated.as_bytes())
            .unwrap_err()
            .to_string()
            .contains("text expansion"));
    }

    #[test]
    fn ods_empty_strings_are_cells_and_paragraph_entity_expansion_is_bounded() {
        assert!(validate_ods_repeats(br#"<table:table><table:table-row table:number-rows-repeated="1048576"><table:table-cell table:number-columns-repeated="16384" office:value-type="string"/></table:table-row></table:table>"#).is_err());
        for text in ["<text:p/>".repeat(1025), "&amp;".repeat(1025)] {
            let xml = format!(
                r#"<table:table><table:table-row table:number-rows-repeated="256"><table:table-cell table:number-columns-repeated="256" office:value-type="string">{text}</table:table-cell></table:table-row></table:table>"#
            );
            assert!(validate_ods_repeats(xml.as_bytes())
                .unwrap_err()
                .to_string()
                .contains("text expansion"));
        }
    }

    #[test]
    fn ods_validation_requires_balanced_xml_and_valid_table_nesting() {
        for xml in [
            "<table:table>",
            "<table:table><table:table-row></table:table>",
            "<table:table><table:table-row><table:table-cell><table:table-row/></table:table-cell></table:table-row></table:table>",
        ] {
            assert!(validate_ods_repeats(xml.as_bytes()).is_err());
        }
    }

    #[test]
    fn ods_foreign_namespace_names_do_not_change_the_table_budget() {
        let xml = format!(
            r#"<table:table><table:table-row x:number-rows-repeated="1" table:number-rows-repeated="256"><table:table-cell table:number-columns-repeated="256" office:value-type="string"><x:table-row/><x:table-cell/><text:p>{}</text:p></table:table-cell></table:table-row></table:table>"#,
            "x".repeat(1025)
        );
        assert!(validate_ods_repeats(xml.as_bytes())
            .unwrap_err()
            .to_string()
            .contains("text expansion"));
    }
}
