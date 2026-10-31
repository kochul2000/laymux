//! Narrow PE32+ comparison exceptions. Ranges come only from the bundled file.
//! https://learn.microsoft.com/en-us/windows/win32/debug/pe-format
use std::ops::Range;

const SECTION_BYTES: usize = 40;
const DEBUG_ENTRY_BYTES: usize = 28;
const MAX_SECTIONS: usize = 96;
const MAX_DEBUG_ENTRIES: usize = 64;
const READ_ONLY_DATA: u32 = 0x4000_0040;
const MEMORY_AND_DATA_FLAGS: u32 = 0xe000_0040;

fn u16_at(bytes: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_le_bytes(
        bytes.get(offset..offset.checked_add(2)?)?.try_into().ok()?,
    ))
}
fn u32_at(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        bytes.get(offset..offset.checked_add(4)?)?.try_into().ok()?,
    ))
}
fn overlaps(a: &Range<usize>, b: &Range<usize>) -> bool {
    !a.is_empty() && !b.is_empty() && a.start < b.end && b.start < a.end
}

struct Section {
    raw: Range<usize>,
    rva: Range<usize>,
    flags: u32,
}

fn read_only_range(sections: &[Section], rva: usize, size: usize) -> Option<Range<usize>> {
    let end = rva.checked_add(size)?;
    let section = sections
        .iter()
        .find(|s| s.rva.start <= rva && end <= s.rva.end)?;
    if section.flags & MEMORY_AND_DATA_FLAGS != READ_ONLY_DATA {
        return None;
    }
    let start = section
        .raw
        .start
        .checked_add(rva.checked_sub(section.rva.start)?)?;
    let end = start.checked_add(size)?;
    (end <= section.raw.end).then_some(start..end)
}

pub(super) fn build_metadata_ranges(bytes: &[u8]) -> Option<Vec<Range<usize>>> {
    if bytes.get(..2)? != b"MZ" {
        return None;
    }
    let pe = u32_at(bytes, 0x3c)? as usize;
    if pe < 0x40
        || bytes.get(pe..pe.checked_add(4)?)? != b"PE\0\0"
        || u16_at(bytes, pe.checked_add(4)?)? != 0x8664
    {
        return None;
    }
    let count = usize::from(u16_at(bytes, pe.checked_add(6)?)?);
    if !(1..=MAX_SECTIONS).contains(&count) {
        return None;
    }
    let optional_size = usize::from(u16_at(bytes, pe.checked_add(20)?)?);
    let optional = pe.checked_add(24)?;
    let optional_end = optional.checked_add(optional_size)?;
    if optional_size < 112 || optional_end > bytes.len() || u16_at(bytes, optional)? != 0x20b {
        return None;
    }
    let directories = u32_at(bytes, optional.checked_add(108)?)? as usize;
    if directories > 16 || 112usize.checked_add(directories.checked_mul(8)?)? > optional_size {
        return None;
    }
    let table_end = optional_end.checked_add(count.checked_mul(SECTION_BYTES)?)?;
    let headers_end = u32_at(bytes, optional.checked_add(60)?)? as usize;
    if table_end > headers_end || headers_end > bytes.len() {
        return None;
    }
    let mut sections: Vec<Section> = Vec::with_capacity(count);
    for i in 0..count {
        let entry = optional_end.checked_add(i.checked_mul(SECTION_BYTES)?)?;
        let virtual_size = u32_at(bytes, entry + 8)? as usize;
        let rva = u32_at(bytes, entry + 12)? as usize;
        let size = u32_at(bytes, entry + 16)? as usize;
        let start = u32_at(bytes, entry + 20)? as usize;
        let raw = start..start.checked_add(size)?;
        let rva = rva..rva.checked_add(virtual_size.max(size))?;
        if raw.end > bytes.len()
            || rva.end > u32::MAX as usize
            || (size != 0 && start < headers_end)
            || sections
                .iter()
                .any(|s| overlaps(&s.raw, &raw) || overlaps(&s.rva, &rva))
        {
            return None;
        }
        sections.push(Section {
            raw,
            rva,
            flags: u32_at(bytes, entry + 36)?,
        });
    }
    let mut ignored: Vec<_> = std::iter::once(pe.checked_add(8)?..pe.checked_add(12)?).collect();
    if directories <= 6 {
        return Some(ignored);
    }
    let directory = optional.checked_add(112 + 6 * 8)?;
    let rva = u32_at(bytes, directory)? as usize;
    let size = u32_at(bytes, directory + 4)? as usize;
    if rva == 0 && size == 0 {
        return Some(ignored);
    }
    if rva == 0
        || size == 0
        || !size.is_multiple_of(DEBUG_ENTRY_BYTES)
        || size / DEBUG_ENTRY_BYTES > MAX_DEBUG_ENTRIES
    {
        return None;
    }
    let table = read_only_range(&sections, rva, size)?;
    let mut occupied = vec![table.clone()];
    for i in 0..size / DEBUG_ENTRY_BYTES {
        let entry = table.start.checked_add(i.checked_mul(DEBUG_ENTRY_BYTES)?)?;
        if u32_at(bytes, entry)? != 0 {
            return None; // Reserved Characteristics must be zero.
        }
        let kind = u32_at(bytes, entry + 12)?;
        let size = u32_at(bytes, entry + 16)? as usize;
        let rva = u32_at(bytes, entry + 20)? as usize;
        let pointer = u32_at(bytes, entry + 24)? as usize;
        ignored.push(entry + 4..entry + 8);
        if size == 0 {
            if rva != 0 || pointer != 0 || kind == 2 {
                return None;
            }
            continue;
        }
        let payload = read_only_range(&sections, rva, size)?;
        if payload.start != pointer || occupied.iter().any(|range| overlaps(range, &payload)) {
            return None;
        }
        if kind == 2 {
            let record = bytes.get(payload.clone())?;
            if record.len() < 26
                || record.get(..4)? != b"RSDS"
                || record.last() != Some(&0)
                || record[24..record.len() - 1].contains(&0)
            {
                return None;
            }
            // Only the PDB signature GUID and age; signature and path still compare.
            ignored.push(payload.start + 4..payload.start + 24);
        }
        occupied.push(payload);
    }
    Some(ignored)
}
