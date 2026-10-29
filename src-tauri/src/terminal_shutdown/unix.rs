use std::time::{Duration, Instant};

#[derive(Clone)]
pub(super) struct Target {
    pid: u32,
    birth: u64,
}

struct Stat {
    group: i32,
    session: u32,
    tty: i64,
    foreground: i32,
    birth: u64,
    zombie: bool,
}
fn stat(pid: u32) -> Result<Stat, String> {
    let text = std::fs::read_to_string(format!("/proc/{pid}/stat")).map_err(|e| e.to_string())?;
    let (_, rest) = text.rsplit_once(") ").ok_or("invalid process stat")?;
    let f = rest.split_whitespace().collect::<Vec<_>>();
    if f.len() < 20 {
        return Err("incomplete process stat".into());
    }
    Ok(Stat {
        group: f[2].parse::<i32>().map_err(|e| e.to_string())?,
        session: f[3].parse::<u32>().map_err(|e| e.to_string())?,
        tty: f[4].parse::<i64>().map_err(|e| e.to_string())?,
        foreground: f[5].parse::<i32>().map_err(|e| e.to_string())?,
        birth: f[19].parse::<u64>().map_err(|e| e.to_string())?,
        zombie: matches!(f[0], "Z" | "X"),
    })
}
impl Target {
    pub(super) fn new(pid: u32) -> Result<Self, String> {
        Ok(Self {
            pid,
            birth: stat(pid)?.birth,
        })
    }
    pub(super) fn request(&self) -> Result<(), String> {
        let Ok(root) = stat(self.pid) else {
            return Ok(());
        };
        if root.birth != self.birth || root.zombie || root.tty == 0 || root.foreground <= 1 {
            return Ok(());
        }
        let root_is_shell = std::fs::read_to_string(format!("/proc/{}/comm", self.pid))
            .is_ok_and(|s| matches!(s.trim(), "sh" | "bash" | "dash" | "ash" | "zsh" | "fish"));
        let jobs = std::fs::read_dir("/proc")
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().to_str()?.parse::<u32>().ok())
            .filter(|pid| !root_is_shell || *pid != self.pid)
            .filter_map(|pid| {
                stat(pid)
                    .ok()
                    .filter(|s| {
                        !s.zombie
                            && s.group == root.foreground
                            && s.tty == root.tty
                            && s.session == root.session
                    })
                    .map(|s| (pid, s.birth))
            })
            .collect::<Vec<_>>();
        if jobs.is_empty() {
            return Ok(());
        }
        let Ok(current) = stat(self.pid) else {
            return Ok(());
        };
        if current.birth != root.birth
            || current.foreground != root.foreground
            || current.tty != root.tty
        {
            return Ok(());
        }
        // SAFETY: a positive, freshly revalidated foreground group of this exact
        // PTY generation is negated to select only that process group.
        if unsafe { libc::kill(-root.foreground, libc::SIGTERM) } != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let deadline =
            Instant::now() + Duration::from_millis(crate::constants::TERMINAL_CLOSE_GRACE_MS);
        while jobs
            .iter()
            .any(|(pid, birth)| stat(*pid).is_ok_and(|s| !s.zombie && s.birth == *birth))
        {
            if Instant::now() >= deadline {
                return Err("foreground shutdown deadline expired".into());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Ok(())
    }
}
