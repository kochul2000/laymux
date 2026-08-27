use super::{ArchiveEntry, ArchiveFormat, ArchiveListing};

const ZIP_EOCD_SIGNATURE: &[u8; 4] = b"PK\x05\x06";
const ZIP_EOCD_LEN: usize = 22;
const ZIP_CENTRAL_HEADER_SIGNATURE: &[u8; 4] = b"PK\x01\x02";
const ZIP_CENTRAL_HEADER_LEN: usize = 46;

#[derive(Debug, Clone, Copy)]
struct BoundedZipDirectory {
    start: usize,
    end: usize,
    total_entries: usize,
    archive_offset: usize,
}

/// Read bounded ZIP metadata without ever giving the whole source to
/// `ZipArchive`. zip's recovery parser intentionally tries older EOCD records
/// after a newer directory fails; keeping that recovery outside this path is
/// what makes the pre-parser entry bound authoritative.
pub(super) fn read_bounded_zip_listing(
    bytes: &[u8],
    max_entries: usize,
) -> Result<ArchiveListing, String> {
    let directory = enforce_bounded_zip_metadata(bytes, max_entries)?;
    let mut entries = Vec::with_capacity(directory.total_entries);
    let mut total_bytes = 0_u64;
    let mut cursor = directory.start;
    for index in 0..directory.total_entries {
        let record_end = zip_central_record_end(bytes, cursor, directory.end, index)?;
        let entry = read_bounded_zip_entry(
            bytes,
            &bytes[cursor..record_end],
            directory.archive_offset,
            index,
        )?;
        total_bytes = total_bytes.saturating_add(entry.size);
        entries.push(entry);
        cursor = record_end;
    }

    Ok(ArchiveListing {
        format: ArchiveFormat::Zip,
        entries,
        total_entries: directory.total_entries,
        total_bytes,
        truncated: false,
    })
}

/// Reject a ZIP whose central directory would exceed the bounded viewer's
/// metadata budget before allocating per-entry metadata. ZIP64 EOCD is
/// unnecessary inside the 2/8 MiB source cap and is rejected rather than
/// letting sentinel counts bypass this preflight.
fn enforce_bounded_zip_metadata(
    bytes: &[u8],
    max_entries: usize,
) -> Result<BoundedZipDirectory, String> {
    const MAX_COMMENT_LEN: usize = u16::MAX as usize;

    if bytes.len() < ZIP_EOCD_LEN {
        return Err("Cannot read zip archive: end of central directory is missing".into());
    }
    let search_start = bytes
        .len()
        .saturating_sub(ZIP_EOCD_LEN.saturating_add(MAX_COMMENT_LEN));
    let eocd_offset = (search_start..=bytes.len() - ZIP_EOCD_LEN)
        .rev()
        .find(|&offset| {
            bytes.get(offset..offset + 4) == Some(ZIP_EOCD_SIGNATURE)
                && read_zip_u16(bytes, offset + 20).is_some_and(|comment_len| {
                    offset
                        .checked_add(ZIP_EOCD_LEN)
                        .and_then(|end| end.checked_add(comment_len as usize))
                        == Some(bytes.len())
                })
        })
        .ok_or_else(|| {
            "Cannot read zip archive: end of central directory is invalid".to_string()
        })?;

    let disk = read_zip_u16(bytes, eocd_offset + 4).unwrap_or(u16::MAX);
    let central_disk = read_zip_u16(bytes, eocd_offset + 6).unwrap_or(u16::MAX);
    let entries_on_disk = read_zip_u16(bytes, eocd_offset + 8).unwrap_or(u16::MAX);
    let total_entries = read_zip_u16(bytes, eocd_offset + 10).unwrap_or(u16::MAX);
    let central_size = read_zip_u32(bytes, eocd_offset + 12).unwrap_or(u32::MAX);
    let central_offset = read_zip_u32(bytes, eocd_offset + 16).unwrap_or(u32::MAX);

    if total_entries == u16::MAX || central_size == u32::MAX || central_offset == u32::MAX {
        return Err("ZIP64 metadata exceeds the bounded archive viewer limit".into());
    }
    if disk != 0 || central_disk != 0 || entries_on_disk != total_entries {
        return Err("Cannot read multi-disk zip archive".into());
    }
    if usize::from(total_entries) > max_entries {
        return Err(format!(
            "Archive entry count exceeds the {max_entries} entry viewer limit"
        ));
    }

    let central_size = usize::try_from(central_size)
        .map_err(|_| "Cannot read zip archive: central directory is too large".to_string())?;
    let central_start = eocd_offset
        .checked_sub(central_size)
        .ok_or_else(|| "Cannot read zip archive: central directory is invalid".to_string())?;
    let relative_central_offset = usize::try_from(central_offset)
        .map_err(|_| "Cannot read zip archive: central directory is too large".to_string())?;
    if relative_central_offset > central_start
        || usize::from(total_entries).saturating_mul(ZIP_CENTRAL_HEADER_LEN) > central_size
    {
        return Err("Cannot read zip archive: central directory is invalid".into());
    }

    let mut cursor = central_start;
    for index in 0..usize::from(total_entries) {
        cursor = zip_central_record_end(bytes, cursor, eocd_offset, index)?;
    }
    if cursor != eocd_offset {
        return Err("Cannot read zip archive: central directory size is inconsistent".into());
    }
    Ok(BoundedZipDirectory {
        start: central_start,
        end: eocd_offset,
        total_entries: usize::from(total_entries),
        archive_offset: central_start - relative_central_offset,
    })
}

fn zip_central_record_end(
    bytes: &[u8],
    cursor: usize,
    central_end: usize,
    index: usize,
) -> Result<usize, String> {
    let fixed_end = cursor
        .checked_add(ZIP_CENTRAL_HEADER_LEN)
        .filter(|end| *end <= central_end)
        .ok_or_else(|| {
            format!("Cannot read zip archive: central directory header {index} is truncated")
        })?;
    if bytes.get(cursor..cursor + 4) != Some(ZIP_CENTRAL_HEADER_SIGNATURE) {
        return Err(format!(
            "Cannot read zip archive: central directory header {index} is invalid"
        ));
    }
    let file_name_len = read_zip_u16(bytes, cursor + 28).unwrap_or(u16::MAX) as usize;
    let extra_field_len = read_zip_u16(bytes, cursor + 30).unwrap_or(u16::MAX) as usize;
    let comment_len = read_zip_u16(bytes, cursor + 32).unwrap_or(u16::MAX) as usize;
    fixed_end
        .checked_add(file_name_len)
        .and_then(|end| end.checked_add(extra_field_len))
        .and_then(|end| end.checked_add(comment_len))
        .filter(|end| *end <= central_end)
        .ok_or_else(|| {
            format!("Cannot read zip archive: central directory header {index} exceeds its range")
        })
}

fn read_bounded_zip_entry(
    source: &[u8],
    record: &[u8],
    archive_offset: usize,
    index: usize,
) -> Result<ArchiveEntry, String> {
    let flags = read_zip_u16(record, 8).unwrap_or_default();
    let raw_compressed_size = read_zip_u32(record, 20).unwrap_or(u32::MAX);
    let raw_size = read_zip_u32(record, 24).unwrap_or(u32::MAX);
    let file_name_len = read_zip_u16(record, 28).unwrap_or_default() as usize;
    let extra_field_len = read_zip_u16(record, 30).unwrap_or_default() as usize;
    let raw_disk_number = read_zip_u16(record, 34).unwrap_or(u16::MAX);
    let raw_local_offset = read_zip_u32(record, 42).unwrap_or(u32::MAX);
    let name_start = ZIP_CENTRAL_HEADER_LEN;
    let extra_start = name_start + file_name_len;
    let extra_end = extra_start + extra_field_len;
    let raw_name = &record[name_start..extra_start];
    let extra = &record[extra_start..extra_end];

    let mut size = u64::from(raw_size);
    let mut compressed_size = u64::from(raw_compressed_size);
    let mut local_offset = u64::from(raw_local_offset);
    let mut disk_number = u32::from(raw_disk_number);
    let mut unicode_name: Option<Vec<u8>> = None;
    let zip64_required = raw_size == u32::MAX
        || raw_compressed_size == u32::MAX
        || raw_local_offset == u32::MAX
        || raw_disk_number == u16::MAX;
    let mut saw_zip64 = false;
    let mut saw_unicode_path = false;
    let mut extra_cursor = 0_usize;
    while extra_cursor < extra.len() {
        let header_end = extra_cursor
            .checked_add(4)
            .filter(|end| *end <= extra.len())
            .ok_or_else(|| {
                format!("Cannot read zip archive: extra field header {index} is truncated")
            })?;
        let field_id = read_zip_u16(extra, extra_cursor).unwrap_or_default();
        let field_len = read_zip_u16(extra, extra_cursor + 2).unwrap_or_default() as usize;
        let field_end = header_end
            .checked_add(field_len)
            .filter(|end| *end <= extra.len())
            .ok_or_else(|| {
                format!("Cannot read zip archive: extra field {index} exceeds its range")
            })?;
        let field = &extra[header_end..field_end];
        if field_id == 0x0001 {
            if saw_zip64 {
                return Err(format!(
                    "Cannot read zip archive: duplicate ZIP64 field {index}"
                ));
            }
            saw_zip64 = true;
            let mut zip64_cursor = 0_usize;
            if raw_size == u32::MAX {
                size = take_zip_u64(field, &mut zip64_cursor, index)?;
            }
            if raw_compressed_size == u32::MAX {
                compressed_size = take_zip_u64(field, &mut zip64_cursor, index)?;
            }
            if raw_local_offset == u32::MAX {
                local_offset = take_zip_u64(field, &mut zip64_cursor, index)?;
            }
            if raw_disk_number == u16::MAX {
                disk_number = take_zip_u32(field, &mut zip64_cursor, index)?;
            }
        } else if field_id == 0x7075 {
            if saw_unicode_path {
                return Err(format!(
                    "Cannot read zip archive: duplicate Unicode path field {index}"
                ));
            }
            saw_unicode_path = true;
            if field.len() < 5 {
                return Err(format!(
                    "Cannot read zip archive: Unicode path field {index} is truncated"
                ));
            }
            if field[0] != 1 {
                return Err(format!(
                    "Cannot read zip archive: Unicode path field {index} uses unsupported version {}",
                    field[0]
                ));
            }
            let expected_crc = read_zip_u32(field, 1).unwrap_or_default();
            if crc32fast::hash(raw_name) != expected_crc {
                return Err(format!(
                    "Cannot read zip archive: Unicode path checksum {index} is invalid"
                ));
            }
            unicode_name = Some(
                String::from_utf8(field[5..].to_vec())
                    .map_err(|_| {
                        format!("Cannot read zip archive: Unicode path {index} is invalid")
                    })?
                    .into_bytes(),
            );
        }
        extra_cursor = field_end;
    }

    if zip64_required && !saw_zip64 {
        return Err(format!(
            "Cannot read zip archive: ZIP64 field {index} is missing"
        ));
    }

    if disk_number != 0 {
        return Err("Cannot read multi-disk zip archive".into());
    }
    let actual_local_offset = usize::try_from(local_offset)
        .ok()
        .and_then(|offset| archive_offset.checked_add(offset))
        .ok_or_else(|| format!("Cannot read zip archive: local header {index} is invalid"))?;
    let local_signature_end = actual_local_offset
        .checked_add(4)
        .ok_or_else(|| format!("Cannot read zip archive: local header {index} is invalid"))?;
    if source.get(actual_local_offset..local_signature_end) != Some(b"PK\x03\x04") {
        return Err(format!(
            "Cannot read zip archive: local header {index} is invalid"
        ));
    }

    let name = match unicode_name {
        Some(name) => String::from_utf8(name)
            .map_err(|_| format!("Cannot read zip archive: Unicode path {index} is invalid"))?,
        None => decode_zip_name(raw_name, flags),
    };
    Ok(ArchiveEntry {
        is_directory: matches!(name.as_bytes().last(), Some(b'/') | Some(b'\\')),
        name,
        size,
        compressed_size,
    })
}

fn take_zip_u64(field: &[u8], cursor: &mut usize, index: usize) -> Result<u64, String> {
    let value = read_zip_u64(field, *cursor)
        .ok_or_else(|| format!("Cannot read zip archive: ZIP64 field {index} is truncated"))?;
    *cursor += 8;
    Ok(value)
}

fn take_zip_u32(field: &[u8], cursor: &mut usize, index: usize) -> Result<u32, String> {
    let value = read_zip_u32(field, *cursor)
        .ok_or_else(|| format!("Cannot read zip archive: ZIP64 field {index} is truncated"))?;
    *cursor += 4;
    Ok(value)
}

/// Decode the two filename encodings allowed by the ZIP central-directory
/// contract without invoking a recovery parser over attacker-controlled name
/// bytes. Bit 11 selects UTF-8 with replacement, matching `zip`; otherwise the
/// original IBM code page 437 mapping is used.
fn decode_zip_name(raw_name: &[u8], flags: u16) -> String {
    if flags & (1 << 11) != 0 {
        return String::from_utf8_lossy(raw_name).into_owned();
    }

    raw_name
        .iter()
        .map(|byte| {
            if *byte < 0x80 {
                char::from(*byte)
            } else {
                CP437_HIGH[usize::from(*byte - 0x80)]
            }
        })
        .collect()
}

#[rustfmt::skip]
const CP437_HIGH: [char; 128] = [
    '\u{00c7}', '\u{00fc}', '\u{00e9}', '\u{00e2}', '\u{00e4}', '\u{00e0}', '\u{00e5}', '\u{00e7}',
    '\u{00ea}', '\u{00eb}', '\u{00e8}', '\u{00ef}', '\u{00ee}', '\u{00ec}', '\u{00c4}', '\u{00c5}',
    '\u{00c9}', '\u{00e6}', '\u{00c6}', '\u{00f4}', '\u{00f6}', '\u{00f2}', '\u{00fb}', '\u{00f9}',
    '\u{00ff}', '\u{00d6}', '\u{00dc}', '\u{00a2}', '\u{00a3}', '\u{00a5}', '\u{20a7}', '\u{0192}',
    '\u{00e1}', '\u{00ed}', '\u{00f3}', '\u{00fa}', '\u{00f1}', '\u{00d1}', '\u{00aa}', '\u{00ba}',
    '\u{00bf}', '\u{2310}', '\u{00ac}', '\u{00bd}', '\u{00bc}', '\u{00a1}', '\u{00ab}', '\u{00bb}',
    '\u{2591}', '\u{2592}', '\u{2593}', '\u{2502}', '\u{2524}', '\u{2561}', '\u{2562}', '\u{2556}',
    '\u{2555}', '\u{2563}', '\u{2551}', '\u{2557}', '\u{255d}', '\u{255c}', '\u{255b}', '\u{2510}',
    '\u{2514}', '\u{2534}', '\u{252c}', '\u{251c}', '\u{2500}', '\u{253c}', '\u{255e}', '\u{255f}',
    '\u{255a}', '\u{2554}', '\u{2569}', '\u{2566}', '\u{2560}', '\u{2550}', '\u{256c}', '\u{2567}',
    '\u{2568}', '\u{2564}', '\u{2565}', '\u{2559}', '\u{2558}', '\u{2552}', '\u{2553}', '\u{256b}',
    '\u{256a}', '\u{2518}', '\u{250c}', '\u{2588}', '\u{2584}', '\u{258c}', '\u{2590}', '\u{2580}',
    '\u{03b1}', '\u{00df}', '\u{0393}', '\u{03c0}', '\u{03a3}', '\u{03c3}', '\u{00b5}', '\u{03c4}',
    '\u{03a6}', '\u{0398}', '\u{03a9}', '\u{03b4}', '\u{221e}', '\u{03c6}', '\u{03b5}', '\u{2229}',
    '\u{2261}', '\u{00b1}', '\u{2265}', '\u{2264}', '\u{2320}', '\u{2321}', '\u{00f7}', '\u{2248}',
    '\u{00b0}', '\u{2219}', '\u{00b7}', '\u{221a}', '\u{207f}', '\u{00b2}', '\u{25a0}', '\u{00a0}',
];

fn read_zip_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    let value: [u8; 2] = bytes.get(offset..offset.checked_add(2)?)?.try_into().ok()?;
    Some(u16::from_le_bytes(value))
}

fn read_zip_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    let value: [u8; 4] = bytes.get(offset..offset.checked_add(4)?)?.try_into().ok()?;
    Some(u32::from_le_bytes(value))
}

fn read_zip_u64(bytes: &[u8], offset: usize) -> Option<u64> {
    let value: [u8; 8] = bytes.get(offset..offset.checked_add(8)?)?.try_into().ok()?;
    Some(u64::from_le_bytes(value))
}

#[cfg(test)]
mod tests;
