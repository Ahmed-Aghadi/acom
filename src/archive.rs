//! A deliberately small, uncompressed ustar subset: regular, allowlisted files only.
use crate::app::{Fail, R, bad};
use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const MAX_FILES: usize = 100_000;
const MAX_BYTES: u64 = 256 * 1024 * 1024 * 1024;
const MAX_SECONDS: u64 = 900;

pub fn io(error: std::io::Error) -> Fail {
    Fail(500, error.to_string())
}

pub struct Stage(pub PathBuf);
impl Stage {
    pub fn new(parent: &Path) -> R<Self> {
        let path = parent.join(format!(
            ".acom-stage-{}",
            crate::harness::try_new_uuid().map_err(io)?
        ));
        fs::create_dir(&path).map_err(io)?;
        fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o700))
            .map_err(io)?;
        Ok(Self(path))
    }
}
impl Drop for Stage {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub fn regular(path: &Path) -> R<File> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)
        .map_err(io)?;
    if !file.metadata().map_err(io)?.is_file() {
        return Err(bad(
            "archive inputs must be regular files, not links or devices",
        ));
    }
    Ok(file)
}

pub fn allowed(name: &str) -> bool {
    if matches!(name, "manifest.json" | "acom.db" | "metrics.db") {
        return true;
    }
    let Some((directory, name)) = name.split_once('/') else {
        return false;
    };
    let Some((id, extension)) = name.split_once('.') else {
        return false;
    };
    matches!(directory, "logs" | "native")
        && id
            .parse::<u64>()
            .is_ok_and(|id| id > 0 && id.to_string() == name.split('.').next().unwrap())
        && (directory == "native" && extension == "jsonl"
            || directory == "logs" && matches!(extension, "txt" | "jsonl" | "err"))
}

fn octal(field: &[u8]) -> R<u64> {
    let text = std::str::from_utf8(field)
        .map_err(|_| bad("invalid tar number"))?
        .trim_matches(['\0', ' ']);
    if text.is_empty() {
        return Ok(0);
    }
    if !text.bytes().all(|b| (b'0'..=b'7').contains(&b)) {
        return Err(bad("unsupported tar number"));
    }
    u64::from_str_radix(text, 8).map_err(|_| bad("tar number is too large"))
}

fn put_octal(field: &mut [u8], value: u64) -> R<()> {
    let text = format!("{value:0width$o}", width = field.len() - 1);
    if text.len() >= field.len() {
        return Err(bad("archive entry exceeds the ustar size limit"));
    }
    field[..text.len()].copy_from_slice(text.as_bytes());
    field[text.len()] = 0;
    Ok(())
}

pub fn write_archive(destination: &Path, entries: &[(String, PathBuf, u64)]) -> R<Option<String>> {
    if !destination.is_absolute() {
        return Err(bad("archive destination must be an absolute path"));
    }
    let parent = fs::canonicalize(
        destination
            .parent()
            .ok_or_else(|| bad("archive destination needs a filename"))?,
    )
    .map_err(io)?;
    let name = destination
        .file_name()
        .ok_or_else(|| bad("archive destination needs a filename"))?;
    let destination = parent.join(name);
    let stage = Stage::new(&parent)?;
    let temporary = stage.0.join("archive.tar");
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(io)?;
    let started = Instant::now();
    let mut names = BTreeSet::new();
    let mut total = 0_u64;
    for (name, path, size) in entries {
        if !allowed(name) || !names.insert(name) || names.len() > MAX_FILES {
            return Err(bad("invalid or duplicate archive entry"));
        }
        total = total
            .checked_add(*size)
            .filter(|v| *v <= MAX_BYTES)
            .ok_or_else(|| bad("archive exceeds 256 GiB"))?;
        let mut header = [0_u8; 512];
        header[..name.len()].copy_from_slice(name.as_bytes());
        put_octal(&mut header[100..108], 0o600)?;
        put_octal(&mut header[108..116], 0)?;
        put_octal(&mut header[116..124], 0)?;
        put_octal(&mut header[124..136], *size)?;
        put_octal(&mut header[136..148], crate::app::now().max(0) as u64)?;
        header[148..156].fill(b' ');
        header[156] = b'0';
        header[257..263].copy_from_slice(b"ustar\0");
        header[263..265].copy_from_slice(b"00");
        let sum = header.iter().map(|b| u64::from(*b)).sum();
        put_octal(&mut header[148..156], sum)?;
        output.write_all(&header).map_err(io)?;
        let mut input = regular(path)?.take(*size);
        copy(&mut input, &mut output, *size, started)?;
        output
            .write_all(&[0_u8; 512][..((512 - size % 512) % 512) as usize])
            .map_err(io)?;
    }
    output.write_all(&[0_u8; 1024]).map_err(io)?;
    output.sync_all().map_err(io)?;
    // A link publishes atomically without following or overwriting an existing destination.
    fs::hard_link(&temporary, &destination).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            bad("archive destination already exists; choose another filename")
        } else {
            io(e)
        }
    })?;
    // Publication already succeeded. A durability warning must not invite a
    // retry of an export whose destination now exists.
    Ok(File::open(parent)
        .and_then(|f| f.sync_all())
        .err()
        .map(|error| {
            format!("Archive was published, but directory synchronization failed: {error}")
        }))
}

fn copy(input: &mut impl Read, output: &mut impl Write, size: u64, started: Instant) -> R<()> {
    let mut left = size;
    let mut buffer = [0_u8; 65536];
    while left > 0 {
        if started.elapsed() > Duration::from_secs(MAX_SECONDS) {
            return Err(Fail(
                503,
                "archive operation exceeded 15 minutes; nothing was imported".into(),
            ));
        }
        let length = input
            .read(&mut buffer[..left.min(65536) as usize])
            .map_err(io)?;
        if length == 0 {
            return Err(bad("archive entry was truncated"));
        }
        output.write_all(&buffer[..length]).map_err(io)?;
        left -= length as u64;
    }
    Ok(())
}

#[cfg(test)]
pub fn source_version(source: &Path) -> R<String> {
    Ok(file_version(&regular(source)?.metadata().map_err(io)?))
}

fn file_version(metadata: &std::fs::Metadata) -> String {
    format!(
        "{}:{}:{}:{}:{}:{}:{}",
        metadata.dev(),
        metadata.ino(),
        metadata.len(),
        metadata.mtime(),
        metadata.mtime_nsec(),
        metadata.ctime(),
        metadata.ctime_nsec()
    )
}

#[cfg(test)]
pub fn extract(source: &Path, destination: &Path) -> R<BTreeSet<String>> {
    extract_versioned(source, destination, None).map(|(files, _)| files)
}

pub fn extract_versioned(
    source: &Path,
    destination: &Path,
    expected_version: Option<&str>,
) -> R<(BTreeSet<String>, String)> {
    let mut input = regular(source)?;
    let version = file_version(&input.metadata().map_err(io)?);
    if expected_version.is_some_and(|expected| expected != version) {
        return Err(crate::app::conflict(
            "archive differs from the inspected file; inspect it again before importing",
        ));
    }
    let started = Instant::now();
    let mut names = BTreeSet::new();
    let mut total = 0_u64;
    loop {
        let mut header = [0_u8; 512];
        input
            .read_exact(&mut header)
            .map_err(|_| bad("truncated archive header"))?;
        if header.iter().all(|b| *b == 0) {
            let mut trailer = Vec::new();
            (&mut input)
                .take(10241)
                .read_to_end(&mut trailer)
                .map_err(io)?;
            if trailer.len() < 512 || trailer.len() > 10240 || trailer.iter().any(|b| *b != 0) {
                return Err(bad("invalid archive trailer"));
            }
            break;
        }
        let sum = octal(&header[148..156])?;
        header[148..156].fill(b' ');
        if header.iter().map(|b| u64::from(*b)).sum::<u64>() != sum {
            return Err(bad("archive header checksum failed"));
        }
        if &header[257..263] != b"ustar\0"
            || &header[263..265] != b"00"
            || header[156] != b'0'
            || header[157..257].iter().any(|b| *b != 0)
            || header[345..500].iter().any(|b| *b != 0)
        {
            return Err(bad(
                "only regular, unprefixed ustar archive entries are supported",
            ));
        }
        let end = header[..100].iter().position(|b| *b == 0).unwrap_or(100);
        if header[end..100].iter().any(|b| *b != 0) {
            return Err(bad("invalid archive entry name"));
        }
        let name =
            std::str::from_utf8(&header[..end]).map_err(|_| bad("invalid archive entry name"))?;
        if !allowed(name) || !names.insert(name.to_owned()) || names.len() > MAX_FILES {
            return Err(bad("unknown, unsafe or duplicate archive entry"));
        }
        let size = octal(&header[124..136])?;
        total = total
            .checked_add(size)
            .filter(|v| *v <= MAX_BYTES)
            .ok_or_else(|| bad("archive exceeds 256 GiB"))?;
        if name == "manifest.json" && size > 1024 * 1024 {
            return Err(bad("archive manifest exceeds 1 MiB"));
        }
        if name.contains('/') {
            fs::create_dir_all(destination.join(name.split('/').next().unwrap())).map_err(io)?;
        }
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(destination.join(name))
            .map_err(io)?;
        copy(&mut input, &mut output, size, started)?;
        output.sync_all().map_err(io)?;
        let mut padding = [0_u8; 512];
        input
            .read_exact(&mut padding[..((512 - size % 512) % 512) as usize])
            .map_err(|_| bad("truncated archive padding"))?;
    }
    if !names.contains("manifest.json") || !names.contains("acom.db") {
        return Err(bad("archive must contain manifest.json and acom.db"));
    }
    if file_version(&input.metadata().map_err(io)?) != version {
        return Err(crate::app::conflict(
            "archive changed during inspection; inspect it again",
        ));
    }
    Ok((names, version))
}

pub fn snapshot(source: &rusqlite::Connection, path: &Path) -> R<()> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                bad("snapshot destination already exists")
            } else {
                io(e)
            }
        })?;
    let mut destination = rusqlite::Connection::open(path)?;
    let started = Instant::now();
    let backup = rusqlite::backup::Backup::new(source, &mut destination)?;
    loop {
        if started.elapsed() > Duration::from_secs(30) {
            return Err(Fail(
                503,
                "database snapshot exceeded 30 seconds; retry when less busy".into(),
            ));
        }
        match backup.step(128)? {
            rusqlite::backup::StepResult::Done => return Ok(()),
            rusqlite::backup::StepResult::More => {}
            _ => return Err(Fail(503, "database snapshot is busy; try again".into())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn published_archive_is_successful_when_directory_sync_is_unavailable() {
        use std::os::unix::fs::PermissionsExt;
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let stage = Stage::new(&std::env::temp_dir()).unwrap();
        let source = stage.0.join("acom.db");
        fs::write(&source, b"synthetic").unwrap();
        let directory = stage.0.join("exports");
        fs::create_dir(&directory).unwrap();
        // Write/search permits publication; read permission is needed to open
        // the parent directory for fsync.
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o300)).unwrap();
        let target = directory.join("project.tar");
        let result = write_archive(&target, &[("acom.db".into(), source, 9)]);
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        let warning = result.unwrap().expect("parent synchronization should fail");
        assert!(warning.contains("published"));
        assert!(target.is_file());
        assert_eq!(fs::metadata(target).unwrap().mode() & 0o777, 0o600);
    }
    #[test]
    fn published_archive_reports_parent_sync_failure_without_inviting_a_retry() {
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!(
            "acom-archive-warning-test-{}",
            crate::harness::new_uuid()
        ));
        fs::create_dir(&root).unwrap();
        let source = Stage::new(&root).unwrap();
        fs::write(source.0.join("manifest.json"), b"{}").unwrap();
        fs::write(source.0.join("acom.db"), b"synthetic").unwrap();
        let entries = vec![
            ("manifest.json".into(), source.0.join("manifest.json"), 2),
            ("acom.db".into(), source.0.join("acom.db"), 9),
        ];
        let parent = root.join("destination");
        fs::create_dir(&parent).unwrap();
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o300)).unwrap();
        let destination = parent.join("project.tar");
        let published = write_archive(&destination, &entries);
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(published.unwrap().unwrap().contains("published"));
        let bytes = fs::read(&destination).unwrap();
        assert!(
            write_archive(&destination, &entries)
                .unwrap_err()
                .1
                .contains("already exists")
        );
        assert_eq!(fs::read(&destination).unwrap(), bytes);
        drop(source);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn archive_round_trip_is_streaming_private_and_non_overwriting() {
        let root =
            std::env::temp_dir().join(format!("acom-archive-test-{}", crate::harness::new_uuid()));
        fs::create_dir(&root).unwrap();
        let stage = Stage::new(&root).unwrap();
        fs::write(stage.0.join("manifest.json"), b"{}").unwrap();
        fs::write(stage.0.join("acom.db"), b"synthetic").unwrap();
        let files = vec![
            ("manifest.json".into(), stage.0.join("manifest.json"), 2),
            ("acom.db".into(), stage.0.join("acom.db"), 9),
        ];
        let archive = root.join("export.tar");
        write_archive(&archive, &files).unwrap();
        assert!(write_archive(&archive, &files).is_err());
        let extracted = Stage::new(&root).unwrap();
        assert_eq!(extract(&archive, &extracted.0).unwrap().len(), 2);
        assert_eq!(fs::read(extracted.0.join("acom.db")).unwrap(), b"synthetic");
        let mut bytes = fs::read(&archive).unwrap();
        bytes[0] = b'X';
        fs::write(root.join("bad.tar"), bytes).unwrap();
        let rejected = Stage::new(&root).unwrap();
        assert!(extract(&root.join("bad.tar"), &rejected.0).is_err());
        for name in [
            "../acom.db",
            "/acom.db",
            "logs/../acom.db",
            "logs/01.txt",
            "native/1.sh",
            "global/shared.db",
        ] {
            assert!(!allowed(name));
        }
        drop((stage, extracted, rejected));
        fs::remove_dir_all(root).unwrap();
    }
}
