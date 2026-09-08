use laymux_lib::commands::read_spreadsheet_for_viewer;

#[test]
fn reads_real_workbooks_in_all_four_formats_and_switches_sheets() {
    for ext in ["xls", "xlsx", "xlsb", "ods"] {
        let path = format!(
            "{}/tests/fixtures/spreadsheets/any_sheets.{ext}",
            env!("CARGO_MANIFEST_DIR")
        );
        let first = read_spreadsheet_for_viewer(path.clone(), None).expect(ext);
        assert!(first.sheet_names.len() >= 2, "{ext}");
        assert!(!first.cells.is_empty(), "{ext}");
        assert!(
            first
                .cells
                .iter()
                .any(|cell| cell.row == 0 && cell.column == 0 && cell.value == "1"),
            "{ext}"
        );
        let wire = serde_json::to_value(&first).unwrap();
        assert!(wire["sheetNames"].is_array());
        assert!(wire["totalRows"].is_number());
        assert_eq!(wire["cells"][0]["column"], 0);
        let name = first.sheet_names.last().unwrap().clone();
        let other = read_spreadsheet_for_viewer(path.clone(), Some(name.clone())).expect(ext);
        assert_eq!(other.sheet, name);
        assert!(read_spreadsheet_for_viewer(path, Some("missing".into())).is_err());
    }
}

#[test]
fn sparse_xlsx_coordinates_do_not_allocate_a_dense_sheet() {
    let (_dir, path) = xlsx_with_sheet(br#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>123</v></c></row><row r="1048576"><c r="XFD1048576"><v>999</v></c></row></sheetData></worksheet>"#);
    let before = std::fs::read(&path).unwrap();
    let result = read_spreadsheet_for_viewer(path.to_string_lossy().into(), None).unwrap();
    assert_eq!(result.cells.len(), 1);
    assert_eq!(result.cells[0].value, "123");
    assert_eq!(result.total_rows, 1_048_576);
    assert_eq!(result.total_columns, 16_384);
    assert!(result.truncated);
    assert_eq!(std::fs::read(path).unwrap(), before);
}

#[test]
fn corrupt_and_oversized_files_are_errors() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("broken.XLSX");
    std::fs::write(&path, b"not a workbook").unwrap();
    assert!(read_spreadsheet_for_viewer(path.to_string_lossy().into(), None).is_err());
    std::fs::File::create(&path)
        .unwrap()
        .set_len(16 * 1024 * 1024 + 1)
        .unwrap();
    let error = read_spreadsheet_for_viewer(path.to_string_lossy().into(), None).unwrap_err();
    assert!(error.contains("16 MiB"), "{error}");
}

fn xlsx_with_sheet(xml: &[u8]) -> (tempfile::TempDir, std::path::PathBuf) {
    use std::io::{Cursor, Write};
    let source = include_bytes!("fixtures/spreadsheets/any_sheets.xlsx");
    let mut original = zip::ZipArchive::new(Cursor::new(source)).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("sparse.XLSX");
    let mut output = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
    for index in 0..original.len() {
        let mut entry = original.by_index(index).unwrap();
        output
            .start_file(entry.name(), zip::write::SimpleFileOptions::default())
            .unwrap();
        if entry.name() == "xl/worksheets/sheet1.xml" {
            output.write_all(xml).unwrap();
        } else {
            std::io::copy(&mut entry, &mut output).unwrap();
        }
    }
    output.finish().unwrap();
    (dir, path)
}

#[test]
fn stops_at_the_first_display_limit_instead_of_scanning_the_rest() {
    let (_dir, path) = xlsx_with_sheet(br#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>123</v></c></row><row r="10001"><c r="A10001"><v>1</v></c></row><row r="10002"><c r="A10002"><v>2</v></c></row></sheetData></worksheet>"#);
    let result = read_spreadsheet_for_viewer(path.to_string_lossy().into(), None).unwrap();
    assert!(result.truncated);
    assert_eq!(result.cells.len(), 1);
    assert_eq!(result.total_rows, 10001);
}
