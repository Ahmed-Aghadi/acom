use crate::app::{Fail, R, bad, conflict, now};
use crate::workspace::Workspace;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::ffi::{CString, OsStr};
use std::fs::{self, File, Metadata, OpenOptions, ReadDir};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, TryLockError};
use std::time::{Duration, Instant};

const MAX_ENTRIES: usize = 100_000;
const MAX_DURATION: Duration = Duration::from_secs(10);
static SCAN: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Kind {
    Other,
    Trash,
    Native,
    Logs,
    Metrics,
    Core,
}
#[derive(Clone, Copy)]
struct Class {
    kind: Kind,
    selected: bool,
}

struct Directory {
    file: File,
    entries: ReadDir,
    relative: PathBuf,
}
impl Directory {
    fn new(file: File, relative: PathBuf) -> std::io::Result<Self> {
        let entries = fs::read_dir(format!("/proc/self/fd/{}", file.as_raw_fd()))?;
        Ok(Self {
            file,
            entries,
            relative,
        })
    }
    fn child(&self, name: &OsStr) -> std::io::Result<Self> {
        let component = CString::new(name.as_bytes())?;
        let fd = unsafe {
            libc::openat(
                self.file.as_raw_fd(),
                component.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        Self::new(unsafe { File::from_raw_fd(fd) }, self.relative.join(name))
    }
}

fn classify(relative: &Path, projects: &HashSet<String>, selected: Option<&str>) -> Class {
    let parts = relative
        .iter()
        .map(|v| v.to_str().unwrap_or(""))
        .collect::<Vec<_>>();
    let (project, local) = if parts.first() == Some(&"projects")
        && parts.get(1).is_some_and(|id| projects.contains(*id))
    {
        (parts.get(1).copied(), &parts[2..])
    } else if parts.first() == Some(&"global") {
        (None, &parts[1..])
    } else {
        (None, &parts[..])
    };
    let kind = if parts.first() == Some(&"trash")
        || (project.is_some() || parts.first() == Some(&"global"))
            && local.first() == Some(&"history-trash")
    {
        Kind::Trash
    } else if (project.is_some() || parts.first() == Some(&"global")) && local.len() == 1 {
        let base = local[0]
            .strip_suffix("-wal")
            .or_else(|| local[0].strip_suffix("-shm"))
            .or_else(|| local[0].strip_suffix("-journal"))
            .unwrap_or(local[0]);
        match base {
            "acom.db" | "shared.db" => Kind::Core,
            "metrics.db" => Kind::Metrics,
            _ => Kind::Other,
        }
    } else if project.is_some()
        && local.len() == 2
        && crate::archive::allowed(&format!("{}/{}", local[0], local[1]))
    {
        match local[0] {
            "logs" => Kind::Logs,
            "native" => Kind::Native,
            _ => Kind::Other,
        }
    } else {
        Kind::Other
    };
    Class {
        kind,
        selected: project.is_some() && project == selected,
    }
}

struct Scan {
    entries: usize,
    skipped: usize,
    limited: bool,
    inodes: HashMap<(u64, u64), (u64, Class)>,
}
impl Scan {
    fn insert(&mut self, metadata: &Metadata, class: Class) -> bool {
        let key = (metadata.dev(), metadata.ino());
        if let Some((_, previous)) = self.inodes.get_mut(&key) {
            // Count hard links once globally, regardless of traversal order.
            previous.kind = previous.kind.max(class.kind);
            previous.selected |= class.selected;
            false
        } else {
            self.inodes
                .insert(key, (metadata.blocks().saturating_mul(512), class));
            true
        }
    }
    fn report(&self, home: &Path, project: Option<&str>, started: i64) -> Value {
        let (mut all, mut chosen) = ([0_u64; 6], [0_u64; 6]);
        for (bytes, class) in self.inodes.values() {
            let index = class.kind as usize;
            all[index] = all[index].saturating_add(*bytes);
            if class.selected {
                chosen[index] = chosen[index].saturating_add(*bytes);
            }
        }
        json!({"home":home.to_string_lossy(),"project":project,"started_at":started,"completed_at":now().max(started),
            "complete":self.skipped==0 && !self.limited,"limited":self.limited,"entries":self.entries,"skipped":self.skipped,
            "bytes":{"project":project.map(|_|chosen.iter().sum::<u64>()),"project_core":project.map(|_|chosen[5]),"project_metrics":project.map(|_|chosen[4]),"project_logs":project.map(|_|chosen[3]),"project_native":project.map(|_|chosen[2]),
                "all_project_logs":all[3],"database":all[5],"metrics":all[4],"native":all[2],"trash":all[1],"other":all[0],"total":all.iter().sum::<u64>()}})
    }
}

fn scan(
    home: &Path,
    project: Option<&str>,
    projects: &HashSet<String>,
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
    let metadata = root.metadata().map_err(crate::archive::io)?;
    let mut scan = Scan {
        entries: 1,
        skipped: 0,
        limited: false,
        inodes: HashMap::new(),
    };
    scan.insert(
        &metadata,
        Class {
            kind: Kind::Other,
            selected: false,
        },
    );
    let mut directories = vec![Directory::new(root, PathBuf::new()).map_err(crate::archive::io)?];
    while let Some(directory) = directories.last_mut() {
        if scan.entries >= max_entries || started.elapsed() >= max_duration {
            scan.limited = true;
            break;
        }
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
        let class = classify(&directory.relative.join(&name), projects, project);
        let first = scan.insert(&metadata, class);
        if metadata.is_dir() && first {
            match directory.child(&name) {
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
    Ok(scan.report(home, project, started_at))
}

impl Workspace {
    pub fn storage_usage(&self, project: Option<&str>) -> R<Value> {
        let _scan = match SCAN.try_lock() {
            Ok(guard) => guard,
            Err(TryLockError::Poisoned(error)) => error.into_inner(),
            Err(TryLockError::WouldBlock) => {
                return Err(conflict(
                    "a storage calculation is already running; try again later",
                ));
            }
        };
        if let Some(project) = project {
            self.lookup(project)?;
        }
        let projects = self.engines().into_iter().map(|(id, _)| id).collect();
        scan(&self.home, project, &projects, MAX_ENTRIES, MAX_DURATION)
    }

    pub fn clean_logs(
        &self,
        project: &str,
        category: &str,
        confirm: bool,
        permanent: bool,
        by: &str,
    ) -> R<Value> {
        if !matches!(category, "logs" | "native") {
            return Err(bad(
                "cleanup category must be logs or native; core state cannot be deleted",
            ));
        }
        let engine = self.lookup(project)?;
        let st = engine.lock();
        if st.shutting_down || !st.procs.is_empty() || !st.stopping_agents.is_empty()
            || st.db.query_row("SELECT EXISTS(SELECT 1 FROM agents WHERE state IN ('working','idle') OR pid IS NOT NULL)",[],|r|r.get::<_,bool>(0))? {
            return Err(conflict("pause active agents and wait for cleanup before removing captured files"));
        }
        let directory = engine.home.join(category);
        let mut files = 0_u64;
        let mut bytes = 0_u64;
        if directory.try_exists().map_err(crate::archive::io)? {
            let pinned = OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(&directory)
                .map_err(crate::archive::io)?;
            let pinned = Directory::new(pinned, PathBuf::new()).map_err(crate::archive::io)?;
            for entry in pinned.entries {
                let entry = entry.map_err(crate::archive::io)?;
                let metadata = fs::symlink_metadata(entry.path()).map_err(crate::archive::io)?;
                if !metadata.is_file()
                    || !crate::archive::allowed(&format!(
                        "{category}/{}",
                        entry.file_name().to_string_lossy()
                    ))
                {
                    return Err(bad(
                        "captured directory has unexpected entries; nothing was removed",
                    ));
                }
                files += 1;
                bytes = bytes.saturating_add(metadata.blocks().saturating_mul(512));
                if files > MAX_ENTRIES as u64 {
                    return Err(bad("too many captured files for one cleanup"));
                }
            }
        }
        if !confirm {
            return Ok(
                json!({"preview":true,"project":project,"category":category,"files":files,"bytes":bytes,"permanent":permanent}),
            );
        }
        if files == 0 {
            return Ok(
                json!({"removed":true,"project":project,"category":category,"files":0,"bytes":0,"recoverable_at":null}),
            );
        }
        let trash = self.home.join("trash").join(format!(
            "{project}-{category}-{}",
            crate::harness::try_new_uuid().map_err(crate::archive::io)?
        ));
        fs::rename(&directory, &trash).map_err(crate::archive::io)?;
        let directory_warning=crate::app::private_directory(&directory).err().map(|error|format!("Captured files were moved, but recreating their empty directory failed: {error}. Restore the directory before resuming agents."));
        let mut result = json!({"removed":true,"project":project,"category":category,"files":files,"bytes":bytes,"recoverable_at":trash,
            "note":"Moved to acom trash; disk space is not reclaimed until the owner removes that trash. Core accounting, messages, history and delivery state are unchanged."});
        if permanent {
            match fs::remove_dir_all(&trash) {
                Ok(()) => {
                    result["recoverable_at"] = Value::Null;
                    result["deleted"] = json!(true);
                    result["note"] = json!(
                        "Captured files permanently deleted. Core accounting, messages, history and delivery state are unchanged."
                    );
                }
                Err(error) => {
                    result["deleted"] = json!(false);
                    result["warning"] =
                        json!(format!("Some captured files may remain in trash: {error}"));
                }
            }
        }
        if let Some(warning) = directory_warning {
            result["warning"] = json!(format!(
                "{} {}",
                warning,
                result["warning"].as_str().unwrap_or("")
            ));
        }
        if let Err(error) = st.log(Some(1), by, &format!("moved captured {category} to trash")) {
            result["audit_warning"] = json!(error.1);
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};
    const PROJECT: &str = "00000000-0000-4000-8000-000000000001";
    const PEER: &str = "00000000-0000-4000-8000-000000000002";
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir()
                .join(format!("acom-storage-test-{}", crate::harness::new_uuid()));
            fs::create_dir(&root).unwrap();
            Self(root)
        }
        fn write(&self, name: &str) -> u64 {
            let path = self.0.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, b"synthetic").unwrap();
            allocated(&path)
        }
        fn scan(&self) -> Value {
            scan(
                &self.0,
                Some(PROJECT),
                &HashSet::from([PROJECT.into(), PEER.into()]),
                MAX_ENTRIES,
                MAX_DURATION,
            )
            .unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn allocated(path: &Path) -> u64 {
        fs::symlink_metadata(path).unwrap().blocks() * 512
    }

    #[test]
    fn reports_separate_project_core_metrics_logs_native_global_and_trash() {
        let f = Fixture::new();
        let core = f.write(&format!("projects/{PROJECT}/acom.db"));
        let metrics = f.write(&format!("projects/{PROJECT}/metrics.db"));
        let logs = f.write(&format!("projects/{PROJECT}/logs/1.txt"));
        let native = f.write(&format!("projects/{PROJECT}/native/1.jsonl"));
        let peer = f.write(&format!("projects/{PEER}/logs/1.txt"));
        let global = f.write("global/shared.db");
        f.write("trash/removed/data");
        let report = f.scan();
        let bytes = &report["bytes"];
        assert_eq!(bytes["project_core"], core);
        assert_eq!(bytes["project_metrics"], metrics);
        assert_eq!(bytes["project_logs"], logs);
        assert_eq!(bytes["project_native"], native);
        assert_eq!(bytes["all_project_logs"], logs + peer);
        assert_eq!(bytes["database"], core + global);
        assert_eq!(
            bytes["total"].as_u64().unwrap(),
            [
                "all_project_logs",
                "database",
                "metrics",
                "native",
                "trash",
                "other"
            ]
            .iter()
            .map(|k| bytes[k].as_u64().unwrap())
            .sum::<u64>()
        );
        assert_eq!(report["complete"], true);
    }

    #[test]
    fn sparse_hardlinks_and_symlinks_are_not_overcounted_or_followed() {
        let f = Fixture::new();
        let outside = Fixture::new();
        outside.write("secret");
        let path = f.0.join(format!("projects/{PROJECT}/logs/1.txt"));
        f.write(&format!("projects/{PROJECT}/logs/1.txt"));
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(1 << 30)
            .unwrap();
        fs::hard_link(&path, f.0.join("alias")).unwrap();
        symlink(&outside.0, f.0.join("external")).unwrap();
        symlink(outside.0.join("missing"), f.0.join("broken")).unwrap();
        let report = f.scan();
        assert_eq!(report["bytes"]["all_project_logs"], allocated(&path));
        assert!(allocated(&path) < 1 << 30);
        assert_eq!(report["complete"], true);
    }

    #[test]
    fn limits_and_unreadable_paths_are_explicit_not_zero_success() {
        let f = Fixture::new();
        f.write("data");
        for (entries, duration) in [(1, MAX_DURATION), (MAX_ENTRIES, Duration::ZERO)] {
            let report = scan(&f.0, None, &HashSet::new(), entries, duration).unwrap();
            assert_eq!(report["limited"], true);
            assert_eq!(report["complete"], false);
        }
        assert!(
            scan(
                &f.0.join("missing"),
                None,
                &HashSet::new(),
                MAX_ENTRIES,
                MAX_DURATION
            )
            .is_err()
        );
        if unsafe { libc::geteuid() } != 0 {
            fs::create_dir(f.0.join("unreadable")).unwrap();
            fs::set_permissions(f.0.join("unreadable"), fs::Permissions::from_mode(0o0)).unwrap();
            let report = f.scan();
            fs::set_permissions(f.0.join("unreadable"), fs::Permissions::from_mode(0o700)).unwrap();
            assert_eq!(report["complete"], false);
            assert_eq!(report["skipped"], 1);
        }
    }

    #[test]
    fn descriptor_pinning_prevents_replaced_directory_traversal() {
        let f = Fixture::new();
        let outside = Fixture::new();
        fs::create_dir(f.0.join("child")).unwrap();
        let root = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
            .open(&f.0)
            .unwrap();
        let directory = Directory::new(root, PathBuf::new()).unwrap();
        fs::rename(f.0.join("child"), f.0.join("old")).unwrap();
        symlink(&outside.0, f.0.join("child")).unwrap();
        assert!(directory.child("child".as_ref()).is_err());
        assert!(directory.child("old".as_ref()).is_ok());
    }
}
