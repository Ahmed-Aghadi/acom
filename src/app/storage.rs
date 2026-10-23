use super::*;
use std::ffi::CString;
use std::fs::{self, File, Metadata, OpenOptions, ReadDir};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;
use std::sync::TryLockError;

const MAX_ENTRIES: usize = 100_000;
const MAX_DURATION: Duration = Duration::from_secs(10);
static SCAN: Mutex<()> = Mutex::new(());

fn scan_guard(gate: &Mutex<()>) -> R<MutexGuard<'_, ()>> {
    match gate.try_lock() {
        Ok(guard) => Ok(guard),
        Err(TryLockError::Poisoned(error)) => Ok(error.into_inner()),
        Err(TryLockError::WouldBlock) => Err(conflict(
            "a storage calculation is already running; try again later",
        )),
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Category {
    Other,
    Logs(bool),
    Database,
}

impl Category {
    fn merged(self, other: Self) -> Self {
        match (self, other) {
            (Self::Database, _) | (_, Self::Database) => Self::Database,
            (Self::Logs(a), Self::Logs(b)) => Self::Logs(a || b),
            (Self::Logs(project), _) | (_, Self::Logs(project)) => Self::Logs(project),
            _ => Self::Other,
        }
    }
}

#[derive(Clone, Copy)]
enum Location {
    Home,
    Logs,
    Other,
}

struct Directory {
    file: File,
    entries: ReadDir,
    location: Location,
}

impl Directory {
    fn new(file: File, location: Location) -> std::io::Result<Self> {
        // The descriptor pins the directory even if its path is renamed or replaced.
        let entries = fs::read_dir(format!("/proc/self/fd/{}", file.as_raw_fd()))?;
        Ok(Self {
            file,
            entries,
            location,
        })
    }

    fn child(&self, name: &std::ffi::OsStr, location: Location) -> std::io::Result<Self> {
        let name = CString::new(name.as_bytes())?;
        // Never follow a descendant symlink, including a replacement during the scan.
        let fd = unsafe {
            libc::openat(
                self.file.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        Self::new(unsafe { File::from_raw_fd(fd) }, location)
    }
}

fn category(
    location: Location,
    name: &std::ffi::OsStr,
    owners: &HashMap<i64, i64>,
    selected_project: Option<i64>,
) -> Category {
    let Some(name) = name.to_str() else {
        return Category::Other;
    };
    match location {
        Location::Home
            if matches!(
                name,
                "acom.db" | "acom.db-wal" | "acom.db-shm" | "acom.db-journal"
            ) =>
        {
            Category::Database
        }
        Location::Logs => {
            if let Some((id, extension)) = name.rsplit_once('.')
                && matches!(extension, "jsonl" | "txt" | "err")
                && let Ok(agent) = id.parse::<i64>()
                && agent > 0
                && agent.to_string() == id
                && let Some(project) = owners.get(&agent)
            {
                return Category::Logs(Some(*project) == selected_project);
            }
            Category::Other
        }
        _ => Category::Other,
    }
}

struct Scan {
    project: Option<i64>,
    entries: usize,
    skipped: usize,
    limited: bool,
    inodes: HashMap<(u64, u64), (u64, Category)>,
}

impl Scan {
    fn insert(&mut self, metadata: &Metadata, category: Category) -> bool {
        let key = (metadata.dev(), metadata.ino());
        if let Some((_, existing)) = self.inodes.get_mut(&key) {
            *existing = existing.merged(category);
            false
        } else {
            self.inodes
                .insert(key, (metadata.blocks().saturating_mul(512), category));
            true
        }
    }

    fn view(&self, home: &Path, started_at: i64) -> Value {
        let (mut logs, mut project_logs, mut database, mut other) = (0_u64, 0_u64, 0_u64, 0_u64);
        for (bytes, category) in self.inodes.values() {
            match category {
                Category::Logs(selected) => {
                    logs = logs.saturating_add(*bytes);
                    if *selected {
                        project_logs = project_logs.saturating_add(*bytes);
                    }
                }
                Category::Database => database = database.saturating_add(*bytes),
                Category::Other => other = other.saturating_add(*bytes),
            }
        }
        json!({
            "home":home.to_string_lossy(),"project":self.project,"started_at":started_at,"completed_at":now().max(started_at),
            "complete":self.skipped==0 && !self.limited,"limited":self.limited,
            "entries":self.entries,"skipped":self.skipped,
            "bytes":{"project_logs":self.project.map(|_|project_logs),"all_project_logs":logs,
                "database":database,"other":other,"total":logs.saturating_add(database).saturating_add(other)}
        })
    }
}

fn scan(
    home: &Path,
    project: Option<i64>,
    owners: &HashMap<i64, i64>,
    max_entries: usize,
    max_duration: Duration,
) -> R<Value> {
    let started_at = now();
    let started = Instant::now();
    let root = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(home)
        .map_err(|e| Fail(500, format!("cannot inspect data directory: {e}")))?;
    let metadata = root
        .metadata()
        .map_err(|e| Fail(500, format!("cannot inspect data directory: {e}")))?;
    let mut directories = vec![
        Directory::new(root, Location::Home)
            .map_err(|e| Fail(500, format!("cannot read data directory: {e}")))?,
    ];
    let mut scan = Scan {
        project,
        entries: 1,
        skipped: 0,
        limited: false,
        inodes: HashMap::new(),
    };
    scan.insert(&metadata, Category::Other);
    while !directories.is_empty() {
        if scan.entries >= max_entries || started.elapsed() >= max_duration {
            scan.limited = true;
            break;
        }
        let directory = directories.last_mut().unwrap();
        let Some(entry) = directory.entries.next() else {
            directories.pop();
            continue;
        };
        scan.entries += 1;
        let Ok(entry) = entry else {
            scan.skipped += 1;
            continue;
        };
        let name = entry.file_name();
        let Ok(metadata) = fs::symlink_metadata(entry.path()) else {
            scan.skipped += 1;
            continue;
        };
        let class = if metadata.is_dir() {
            Category::Other
        } else {
            category(directory.location, &name, owners, project)
        };
        let first = scan.insert(&metadata, class);
        if metadata.is_dir() && first {
            let location = if matches!(directory.location, Location::Home) && name == "logs" {
                Location::Logs
            } else {
                Location::Other
            };
            match directory.child(&name, location) {
                Ok(child)
                    if child
                        .file
                        .metadata()
                        .is_ok_and(|m| m.dev() == metadata.dev() && m.ino() == metadata.ino()) =>
                {
                    directories.push(child)
                }
                _ => scan.skipped += 1,
            }
        }
    }
    Ok(scan.view(home, started_at))
}

impl App {
    pub fn storage_usage(&self, project: Option<i64>) -> R<Value> {
        let _scan = scan_guard(&SCAN)?;
        let owners = {
            let st = self.lock();
            if let Some(project) = project {
                st.project(project)?;
            }
            let mut statement = st
                .db
                .prepare("SELECT a.id,a.project FROM agents a JOIN projects p ON p.id=a.project")?;
            statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<Result<HashMap<i64, i64>, _>>()?
        };
        scan(&self.home, project, &owners, MAX_ENTRIES, MAX_DURATION)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let home = std::env::temp_dir()
                .join(format!("acom-storage-unit-{}", crate::harness::new_uuid()));
            fs::create_dir_all(home.join("logs")).unwrap();
            Self(home)
        }

        fn scan(&self, project: Option<i64>) -> Value {
            scan(
                &self.0,
                project,
                &HashMap::from([(1, 10), (2, 20)]),
                MAX_ENTRIES,
                MAX_DURATION,
            )
            .unwrap()
        }

        fn write(&self, path: &str, bytes: &[u8]) -> u64 {
            fs::write(self.0.join(path), bytes).unwrap();
            allocated(self.0.join(path))
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    fn allocated(path: impl AsRef<Path>) -> u64 {
        fs::symlink_metadata(path).unwrap().blocks() * 512
    }

    #[test]
    fn storage_splits_known_logs_shared_database_and_other_allocated_blocks() {
        let fixture = Fixture::new();
        let selected = fixture.write("logs/1.jsonl", b"first");
        let peer = fixture.write("logs/2.txt", b"second");
        let orphan = fixture.write("logs/999.jsonl", b"not an agent");
        let unexpected = fixture.write("logs/1.backup", b"not a captured log");
        let leading_zero = fixture.write("logs/01.txt", b"not a canonical ID");
        let port = fixture.write("port", b"7400");
        let database: u64 = ["acom.db", "acom.db-wal", "acom.db-shm", "acom.db-journal"]
            .iter()
            .map(|name| fixture.write(name, b"shared"))
            .sum();
        let other = orphan
            + unexpected
            + leading_zero
            + port
            + allocated(&fixture.0)
            + allocated(fixture.0.join("logs"));
        let report = fixture.scan(Some(10));
        assert_eq!(report["project"], 10);
        assert_eq!(report["bytes"]["project_logs"], selected);
        assert_eq!(report["bytes"]["all_project_logs"], selected + peer);
        assert_eq!(report["bytes"]["database"], database);
        assert_eq!(report["bytes"]["other"], other);
        assert_eq!(report["bytes"]["total"], selected + peer + database + other);
        assert_eq!(report["complete"], true);
        assert_eq!(report["limited"], false);
        assert_eq!(report["skipped"], 0);
        assert_eq!(report["entries"], 12);
        assert!(report["completed_at"].as_i64() >= report["started_at"].as_i64());
        assert_eq!(fixture.scan(None)["bytes"]["project_logs"], Value::Null);
        assert_eq!(fixture.scan(Some(30))["bytes"]["project_logs"], 0);
    }

    #[test]
    fn storage_uses_allocated_sparse_bytes_and_never_needs_file_contents() {
        let fixture = Fixture::new();
        let sparse = fixture.0.join("logs/1.jsonl");
        File::create(&sparse).unwrap().set_len(1 << 30).unwrap();
        fs::set_permissions(&sparse, fs::Permissions::from_mode(0o0)).unwrap();
        let report = fixture.scan(Some(10));
        assert!(allocated(&sparse) < fs::metadata(&sparse).unwrap().len());
        assert_eq!(report["bytes"]["project_logs"], allocated(&sparse));
        assert_eq!(report["complete"], true);
        assert_eq!(fs::metadata(&sparse).unwrap().len(), 1 << 30);
    }

    #[test]
    fn storage_counts_links_but_does_not_follow_them_or_nested_fake_logs() {
        let fixture = Fixture::new();
        let outside = Fixture::new();
        outside.write("external", &[b'x'; 32_768]);
        symlink(outside.0.join("external"), fixture.0.join("external-link")).unwrap();
        symlink(&outside.0, fixture.0.join("directory-link")).unwrap();
        symlink(outside.0.join("missing"), fixture.0.join("broken-link")).unwrap();
        fs::create_dir(fixture.0.join("nested")).unwrap();
        let nested = fixture.write("nested/1.txt", b"outside root logs directory");
        let expected_other = [
            fixture.0.clone(),
            fixture.0.join("logs"),
            fixture.0.join("nested"),
            fixture.0.join("external-link"),
            fixture.0.join("directory-link"),
            fixture.0.join("broken-link"),
        ]
        .into_iter()
        .map(allocated)
        .sum::<u64>()
            + nested;
        let report = fixture.scan(Some(10));
        assert_eq!(report["bytes"]["all_project_logs"], 0);
        assert_eq!(report["bytes"]["other"], expected_other);
        assert_eq!(report["bytes"]["total"], expected_other);
        assert_eq!(report["complete"], true);
        assert_eq!(report["entries"], 7);
    }

    #[test]
    fn storage_hardlinks_are_unique_with_order_independent_project_attribution() {
        let fixture = Fixture::new();
        let log = fixture.write("logs/1.jsonl", b"one inode");
        fs::hard_link(fixture.0.join("logs/1.jsonl"), fixture.0.join("logs/2.txt")).unwrap();
        fs::hard_link(fixture.0.join("logs/1.jsonl"), fixture.0.join("alias")).unwrap();
        let report = fixture.scan(Some(10));
        assert_eq!(report["bytes"]["project_logs"], log);
        assert_eq!(report["bytes"]["all_project_logs"], log);
        assert_eq!(fixture.scan(Some(20))["bytes"]["project_logs"], log);
        assert_eq!(
            report["bytes"]["total"],
            log + allocated(&fixture.0) + allocated(fixture.0.join("logs"))
        );
        assert_eq!(report["entries"], 5);
        fs::hard_link(fixture.0.join("alias"), fixture.0.join("acom.db")).unwrap();
        let report = fixture.scan(Some(10));
        assert_eq!(report["bytes"]["project_logs"], 0);
        assert_eq!(report["bytes"]["all_project_logs"], 0);
        assert_eq!(report["bytes"]["database"], log);
        for (first, second) in [
            (Category::Other, Category::Logs(true)),
            (Category::Logs(false), Category::Logs(true)),
            (Category::Database, Category::Logs(true)),
        ] {
            assert!(first.merged(second) == second.merged(first));
        }
    }

    #[test]
    fn storage_entry_and_elapsed_caps_return_explicit_partial_totals() {
        let fixture = Fixture::new();
        fixture.write("logs/1.txt", b"not reached");
        for (entries, duration) in [(1, MAX_DURATION), (MAX_ENTRIES, Duration::ZERO)] {
            let report = scan(&fixture.0, Some(10), &HashMap::new(), entries, duration).unwrap();
            assert_eq!(report["limited"], true);
            assert_eq!(report["complete"], false);
            assert_eq!(report["entries"], 1);
            assert_eq!(report["skipped"], 0);
            assert_eq!(report["bytes"]["total"], allocated(&fixture.0));
        }
    }

    #[test]
    fn storage_missing_or_non_directory_root_returns_error_not_zero() {
        let fixture = Fixture::new();
        fixture.write("file", b"not a directory");
        for name in ["missing", "file"] {
            let error = scan(
                &fixture.0.join(name),
                None,
                &HashMap::new(),
                MAX_ENTRIES,
                MAX_DURATION,
            )
            .unwrap_err();
            assert_eq!(error.0, 500);
            assert!(error.1.contains("cannot inspect data directory"));
        }
    }

    #[test]
    fn storage_unreadable_directory_is_partial_and_sibling_sizes_remain() {
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let fixture = Fixture::new();
        let inaccessible = fixture.0.join("unreadable");
        fs::create_dir(&inaccessible).unwrap();
        fs::write(inaccessible.join("hidden"), b"cannot inspect").unwrap();
        fixture.write("logs/1.txt", b"still visible");
        fs::set_permissions(&inaccessible, fs::Permissions::from_mode(0o0)).unwrap();
        let report = fixture.scan(Some(10));
        fs::set_permissions(&inaccessible, fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(report["complete"], false);
        assert_eq!(report["limited"], false);
        assert_eq!(report["skipped"], 1);
        assert_eq!(
            report["bytes"]["project_logs"],
            allocated(fixture.0.join("logs/1.txt"))
        );
    }

    #[test]
    fn storage_directory_descriptors_prevent_symlink_replacement_traversal() {
        let fixture = Fixture::new();
        let outside = Fixture::new();
        let child = fixture.0.join("child");
        fs::create_dir(&child).unwrap();
        let root = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
            .open(&fixture.0)
            .unwrap();
        let directory = Directory::new(root, Location::Home).unwrap();
        fs::rename(&child, fixture.0.join("old-child")).unwrap();
        symlink(&outside.0, &child).unwrap();
        assert!(directory.child("child".as_ref(), Location::Other).is_err());
        assert!(
            directory
                .child("old-child".as_ref(), Location::Other)
                .is_ok()
        );
    }

    #[test]
    fn storage_busy_scan_is_rejected_without_waiting() {
        let gate = Mutex::new(());
        let guard = scan_guard(&gate).unwrap();
        let error = scan_guard(&gate).unwrap_err();
        assert_eq!(error.0, 409);
        assert!(error.1.contains("already running"));
        drop(guard);
        assert!(scan_guard(&gate).is_ok());
    }

    #[test]
    fn storage_unreadable_root_is_error_instead_of_partial_zero() {
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let fixture = Fixture::new();
        fs::set_permissions(&fixture.0, fs::Permissions::from_mode(0o0)).unwrap();
        let result = scan(&fixture.0, None, &HashMap::new(), MAX_ENTRIES, MAX_DURATION);
        fs::set_permissions(&fixture.0, fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(result.unwrap_err().0, 500);
    }
}
