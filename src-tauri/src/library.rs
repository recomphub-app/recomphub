//! The player's library: which games are installed where, and the play time. Saved as
//! library.json in Black Flag's data folder.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Copy, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    /// A game from the catalog, recognised by its port's files.
    #[default]
    Port,
    /// Any other PC game the player added by pointing at its program. Black Flag does not
    /// try to tell where it came from.
    PcGame,
    /// A community port installed from its GitHub release without Black Flag's checks
    /// (aba Comunidade, instalação experimental).
    Community,
    /// A console game opened by an emulator (emu.rs): `install_dir` is the folder of the game's
    /// file and `exe` the file (or the game's folder program, as EBOOT.BIN) inside it.
    Emulated,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Entry {
    #[serde(default)]
    pub kind: EntryKind,
    /// Port: the port's folder. PC game: the folder of its program.
    pub install_dir: String,
    /// PC game only: the program's file name inside `install_dir`.
    #[serde(default)]
    pub exe: Option<String>,
    /// PC game only: the name the player sees.
    #[serde(default)]
    pub title: Option<String>,
    /// Community port: GitHub "owner/name" it was installed from.
    #[serde(default)]
    pub repo: Option<String>,
    /// The player's own labels, for filtering the library.
    #[serde(default)]
    pub tags: Vec<String>,
    /// Release tag installed by Black Flag; None for a copy added from a folder.
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub total_seconds: u64,
    /// Unix time the last session ended.
    #[serde(default)]
    pub last_played: Option<u64>,
    /// No "versão nova" notice for this port (as Heroic's ignoreGameUpdates). Turned on when
    /// the player picks an older version, so it is not swapped back behind their back.
    #[serde(default)]
    pub ignore_updates: bool,
    /// "Pular esta versão": no notice for this release tag; the next one is shown again (as
    /// GithubLauncher's SkippedUpdateVersion). Cleared on install.
    #[serde(default)]
    pub skipped_version: Option<String>,
    /// Video drivers when the game last closed, to tell when the shader cache was made by
    /// another driver (pcinfo::driver_signature).
    #[serde(default)]
    pub shader_driver: Option<String>,
    /// Shown first in the library.
    #[serde(default)]
    pub favorite: bool,
    /// Left out of the library unless "Mostrar ocultos" is on.
    #[serde(default)]
    pub hidden: bool,
    /// Extra command-line arguments for the game's program (as Heroic's launcherArgs).
    #[serde(default)]
    pub launch_args: String,
    /// Extra environment variables for the game (as Heroic's enviromentOptions).
    #[serde(default)]
    pub env: Vec<EnvVar>,
    /// Where the player is with the game (as Playnite's completion status).
    #[serde(default)]
    pub completion: Completion,
    /// Sessions of at least history::MIN_SESSION_SECS.
    #[serde(default)]
    pub play_count: u32,
    /// The player's own notes about the game.
    #[serde(default)]
    pub notes: String,
    /// PC game: the title Ludusavi knows it by, once found (or set by the player).
    #[serde(default)]
    pub ludusavi_name: Option<String>,
    /// Open through Windows' administrator prompt (UAC). Turned on by itself when the
    /// program asks for it; the player can also turn it on or off.
    #[serde(default)]
    pub run_as_admin: bool,
    /// Game found in a PC store's files (stores.rs): "steam", "epic" or "gog".
    #[serde(default)]
    pub store: Option<String>,
    /// How the store opens the game ("steam://rungameid/…"); None: the program is started.
    #[serde(default)]
    pub launch_url: Option<String>,
    /// "Onde eu parei": the player's note to themselves when the game last closed.
    #[serde(default)]
    pub resume: Option<ResumeNote>,
    /// Emulated game: its console (emu::SYSTEMS id, as "ps2").
    #[serde(default)]
    pub system: Option<String>,
    /// Emulated game: the emulator the player chose for it; None uses the console's.
    #[serde(default)]
    pub emulator: Option<String>,
    /// Emulated PS1/PS2 disc: its serial ("SLUS-20946"), for covers.
    #[serde(default)]
    pub serial: Option<String>,
    /// Emulated game: its game on RetroAchievements, once found (by the disc's hash, or
    /// from the emulator's log while playing).
    #[serde(default)]
    pub ra_game: Option<u64>,
}

/// A note left when a session ends ("no chefe do trem"), shown when the player comes back.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ResumeNote {
    pub text: String,
    /// Unix time it was written.
    pub at: u64,
    /// How long the session it was written after lasted.
    #[serde(default)]
    pub seconds: u64,
}

/// As Playnite's completion statuses. `None`: not chosen; the page shows "Não jogado" or
/// "Jogando" from the play time, and the first session sets `Playing`.
#[derive(Serialize, Deserialize, Clone, Copy, Default, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Completion {
    #[default]
    None,
    NotPlayed,
    Planned,
    Playing,
    OnHold,
    Beaten,
    Completed,
    Abandoned,
}

impl Completion {
    pub fn parse(s: &str) -> Option<Self> {
        serde_json::from_value(serde_json::Value::String(s.to_string())).ok()
    }
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct EnvVar {
    pub name: String,
    pub value: String,
}

#[derive(Serialize, Deserialize, Default)]
pub struct Library {
    #[serde(default)]
    pub games: BTreeMap<String, Entry>,
    /// Play time kept for games removed from the library, so adding them back keeps it.
    #[serde(default)]
    pub removed: BTreeMap<String, Entry>,
    /// Store games the player removed: the next search leaves them out.
    #[serde(default)]
    pub excluded: std::collections::BTreeSet<String>,
}

impl Library {
    pub fn load(path: &Path) -> Self {
        std::fs::read(path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    /// Writes a temporary file first so a crash never leaves half a library.
    pub fn save(&self, path: &Path) -> Result<(), String> {
        let text = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, path).map_err(|e| e.to_string())
    }

    pub fn add(&mut self, id: &str, install_dir: &Path, version: Option<String>) {
        let mut entry = self.games.remove(id).or_else(|| self.removed.remove(id)).unwrap_or_default();
        entry.install_dir = install_dir.display().to_string();
        entry.version = version;
        entry.skipped_version = None;
        self.games.insert(id.to_string(), entry);
    }

    pub fn add_pc_game(&mut self, id: &str, exe: &Path, title: &str) {
        let mut entry = self.removed.remove(id).unwrap_or_default();
        entry.kind = EntryKind::PcGame;
        entry.install_dir = exe.parent().map(|p| p.display().to_string()).unwrap_or_default();
        entry.exe = exe.file_name().map(|n| n.to_string_lossy().to_string());
        entry.title = Some(title.to_string());
        entry.version = None;
        self.games.insert(id.to_string(), entry);
    }

    pub fn add_community(&mut self, id: &str, dir: &Path, repo: &str, title: &str, tag: &str, exe: Option<String>) {
        let mut entry = self.games.remove(id).or_else(|| self.removed.remove(id)).unwrap_or_default();
        entry.kind = EntryKind::Community;
        entry.install_dir = dir.display().to_string();
        entry.repo = Some(repo.to_string());
        entry.title = Some(title.to_string());
        entry.version = Some(tag.to_string());
        entry.skipped_version = None;
        // An update keeps the program the player chose, when it still exists.
        if entry.exe.as_ref().map(|e| !dir.join(e).is_file()).unwrap_or(true) {
            entry.exe = exe;
        }
        self.games.insert(id.to_string(), entry);
    }

    /// A console game found in a games folder: added (with what it had, if it was here before),
    /// or its file brought up to date. The player's own choices (name, emulator, tags...) stay.
    /// Returns whether it is new.
    pub fn upsert_emulated(&mut self, id: &str, system: &str, dir: &Path, file: &str, title: &str, serial: Option<&str>) -> bool {
        if self.excluded.contains(id) {
            return false;
        }
        let new = !self.games.contains_key(id);
        let mut entry = self.games.remove(id).or_else(|| self.removed.remove(id)).unwrap_or_default();
        entry.kind = EntryKind::Emulated;
        entry.install_dir = dir.display().to_string();
        entry.exe = Some(file.to_string());
        entry.system = Some(system.to_string());
        if let Some(s) = serial {
            entry.serial = Some(s.to_string());
        }
        if entry.title.is_none() {
            entry.title = Some(title.to_string());
        }
        self.games.insert(id.to_string(), entry);
        new
    }

    pub fn remove(&mut self, id: &str) {
        if let Some(e) = self.games.remove(id) {
            if e.store.is_some() || e.kind == EntryKind::Emulated {
                self.excluded.insert(id.to_string());
            }
            self.removed.insert(id.to_string(), e);
        }
    }

    /// A game found in a store: added (with the play time it had, if it was here before), or
    /// its folder, program and store address brought up to date. The player's own choices
    /// (name, tags, favorite, notes) are never touched. Returns whether it is new.
    pub fn upsert_store_game(&mut self, id: &str, store: &str, title: &str, dir: &Path, exe: Option<String>, launch_url: Option<String>) -> bool {
        if self.excluded.contains(id) {
            return false;
        }
        let new = !self.games.contains_key(id);
        let mut entry = self.games.remove(id).or_else(|| self.removed.remove(id)).unwrap_or_default();
        entry.kind = EntryKind::PcGame;
        entry.install_dir = dir.display().to_string();
        entry.exe = exe;
        entry.store = Some(store.to_string());
        entry.launch_url = launch_url;
        if entry.title.is_none() {
            entry.title = Some(title.to_string());
        }
        self.games.insert(id.to_string(), entry);
        new
    }

    /// Store games no longer installed (not found by the search and their folder gone) leave
    /// the library, keeping their play time for when they come back. Returns their names.
    /// Steam often leaves files behind (mods, configs, crash reports): there, the game's own
    /// appmanifest missing from its library says it is gone, folder or not.
    pub fn drop_uninstalled(&mut self, store: &str, found: &[String]) -> Vec<String> {
        let gone: Vec<String> = self
            .games
            .iter()
            .filter(|(id, e)| {
                e.store.as_deref() == Some(store)
                    && !found.contains(id)
                    && (!Path::new(&e.install_dir).is_dir() || steam_manifest_gone(id, Path::new(&e.install_dir)))
            })
            .map(|(id, _)| id.clone())
            .collect();
        gone.iter()
            .filter_map(|id| {
                let e = self.games.remove(id)?;
                let name = e.title.clone().unwrap_or_default();
                self.removed.insert(id.clone(), e);
                Some(name)
            })
            .collect()
    }

    pub fn install_dir(&self, id: &str) -> Option<PathBuf> {
        self.games.get(id).map(|e| PathBuf::from(&e.install_dir))
    }
}

/// A Steam game ("steam-<app>") in `...\steamapps\common\<folder>` whose
/// `...\steamapps\appmanifest_<app>.acf` is missing, while that steamapps folder is there (a
/// disconnected drive is not an uninstall).
fn steam_manifest_gone(id: &str, dir: &Path) -> bool {
    let Some(app) = id.strip_prefix("steam-").filter(|a| !a.is_empty() && a.bytes().all(|b| b.is_ascii_digit())) else { return false };
    let Some(steamapps) = dir.parent().filter(|c| c.file_name().is_some_and(|n| n.eq_ignore_ascii_case("common"))).and_then(Path::parent) else {
        return false;
    };
    steamapps.is_dir() && !steamapps.join(format!("appmanifest_{app}.acf")).is_file()
}

/// "2026-10-19" for a Unix time (UTC), for backup file names.
pub fn date(unix: u64) -> String {
    // Civil date from days (Howard Hinnant's algorithm).
    let z = (unix / 86_400) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}")
}

pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    #[test]
    fn dates() {
        assert_eq!(super::date(0), "1970-01-01");
        assert_eq!(super::date(1_760_832_000), "2025-10-19");
        assert_eq!(super::date(1_709_164_800), "2024-02-29");
    }

    #[test]
    fn store_games_keep_the_players_choices() {
        let mut lib = super::Library::default();
        let dir = std::env::temp_dir();
        assert!(lib.upsert_store_game("steam-620", "steam", "Portal 2", &dir, None, Some("steam://rungameid/620".into())));
        {
            let e = lib.games.get_mut("steam-620").unwrap();
            e.title = Some("Portal 2 (meu nome)".into());
            e.total_seconds = 3600;
            e.favorite = true;
        }
        // Found again: still the player's name, play time and favorite; the address is updated.
        assert!(!lib.upsert_store_game("steam-620", "steam", "Portal 2", &dir, None, Some("steam://rungameid/620".into())));
        let e = &lib.games["steam-620"];
        assert_eq!((e.title.as_deref(), e.total_seconds, e.favorite), (Some("Portal 2 (meu nome)"), 3600, true));
        // Removed by the player: the next search leaves it out, and the time is kept.
        lib.remove("steam-620");
        assert!(!lib.upsert_store_game("steam-620", "steam", "Portal 2", &dir, None, None));
        assert!(!lib.games.contains_key("steam-620"));
        assert_eq!(lib.removed["steam-620"].total_seconds, 3600);
    }

    #[test]
    fn uninstalled_store_games_leave() {
        let mut lib = super::Library::default();
        let gone = std::env::temp_dir().join("recomphub-nao-existe-9f3a");
        lib.upsert_store_game("epic-a", "epic", "A", &gone, None, None);
        lib.upsert_store_game("epic-b", "epic", "B", &std::env::temp_dir(), None, None);
        lib.upsert_store_game("gog-1", "gog", "C", &gone, None, None);
        assert_eq!(lib.drop_uninstalled("epic", &["epic-b".into()]), vec!["A".to_string()]);
        assert!(lib.games.contains_key("epic-b") && lib.games.contains_key("gog-1"));
        assert!(lib.removed.contains_key("epic-a") && !lib.excluded.contains("epic-a"));
    }

    #[test]
    fn steam_games_leave_even_with_files_left_behind() {
        let steamapps = std::env::temp_dir().join("recomphub-steamapps-5c1d").join("steamapps");
        let left = steamapps.join("common").join("Sobras");
        let kept = steamapps.join("common").join("Instalado");
        std::fs::create_dir_all(&left).unwrap();
        std::fs::create_dir_all(&kept).unwrap();
        std::fs::write(left.join("dinput8.dll"), b"mod").unwrap();
        std::fs::write(steamapps.join("appmanifest_20.acf"), b"\"AppState\" {}").unwrap();
        let mut lib = super::Library::default();
        lib.upsert_store_game("steam-10", "steam", "Desinstalado", &left, None, None);
        lib.upsert_store_game("steam-20", "steam", "Instalado", &kept, None, None);
        // Not found by the search, but its manifest is there (an update in progress, say): stays.
        assert_eq!(lib.drop_uninstalled("steam", &[]), vec!["Desinstalado".to_string()]);
        assert!(lib.games.contains_key("steam-20"));
        // A drive that is not connected: no steamapps folder, not an uninstall by this rule.
        assert!(!super::steam_manifest_gone("steam-30", &std::env::temp_dir().join("nao-existe-77").join("steamapps").join("common").join("X")));
        let _ = std::fs::remove_dir_all(steamapps.parent().unwrap());
    }
}
