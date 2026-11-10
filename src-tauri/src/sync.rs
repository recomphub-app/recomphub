//! Saves that follow the player from one PC to another.
//!
//! The player points Black Flag at a folder they already keep in sync (OneDrive, Google Drive,
//! Dropbox, a pen drive). When a game closes, this PC's newest backup of its saves (autosave.rs)
//! is copied there as `Black Flag saves/<game>/<this pc>.zip`. Another PC that sees a newer copy
//! from someone else offers to bring it in. There is no server and no account: the cloud is the
//! player's own.
//!
//! Nothing is ever overwritten without asking, and the saves this PC had are backed up first.

use crate::autosave;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const FOLDER: &str = "Black Flag saves";

/// Where the shared folder is (sync.json beside the settings).
#[derive(Serialize, Deserialize, Default, Clone)]
pub struct Config {
    #[serde(default)]
    pub dir: String,
}

impl Config {
    pub fn load(path: &Path) -> Self {
        std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        let text = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(path, text).map_err(|e| e.to_string())
    }

    /// The folder, when one is chosen and it is there right now (a pen drive may be out).
    pub fn folder(&self) -> Option<PathBuf> {
        let p = PathBuf::from(self.dir.trim());
        (!self.dir.trim().is_empty() && p.is_dir()).then_some(p)
    }
}

/// A name safe to use as a file name: letters, digits, `-` and `_`.
pub fn safe_name(s: &str) -> String {
    let out: String = s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' }).take(40).collect();
    if out.trim_matches('-').is_empty() {
        "pc".to_string()
    } else {
        out
    }
}

/// This PC, as the other PCs will see it.
pub fn pc_name() -> String {
    safe_name(&std::env::var("COMPUTERNAME").unwrap_or_default())
}

fn game_dir(shared: &Path, id: &str) -> Option<PathBuf> {
    (!id.is_empty() && safe_name(id) == id).then(|| shared.join(FOLDER).join(id))
}

/// One PC's copy of a game's saves in the shared folder.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Remote {
    pub pc: String,
    /// When that PC made the backup (its own clock).
    pub created: u64,
    pub files: usize,
    pub bytes: u64,
    #[serde(skip)]
    pub fingerprint: String,
}

/// Every PC's copy of the game, read from the shared folder.
pub fn copies(shared: &Path, id: &str) -> Vec<Remote> {
    let Some(dir) = game_dir(shared, id) else { return vec![] };
    let Ok(entries) = std::fs::read_dir(&dir) else { return vec![] };
    entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "zip").unwrap_or(false))
        .filter_map(|p| {
            let m = autosave::manifest_of(&p)?;
            if m.game != id {
                return None;
            }
            Some(Remote {
                pc: p.file_stem()?.to_string_lossy().to_string(),
                created: m.created,
                files: m.sources.iter().map(|s| s.files).sum(),
                bytes: m.bytes,
                fingerprint: m.fingerprint,
            })
        })
        .collect()
}

/// How this PC's saves stand against the other PCs'.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Status {
    /// "none": nobody else has a copy. "synced": the same saves here and there.
    /// "ahead": this PC's copy is the newest. "newer": another PC has newer saves and this PC
    /// changed nothing since its last copy. "conflict": another PC has newer saves and this PC
    /// also has saves that were never sent.
    pub state: &'static str,
    /// The newest copy made by another PC.
    pub other: Option<Remote>,
    /// This PC's own copy in the shared folder.
    pub mine: Option<Remote>,
}

/// `local` is the fingerprint of the saves on this PC right now (None: no saves yet).
pub fn status(shared: &Path, id: &str, pc: &str, local: Option<&str>) -> Status {
    let all = copies(shared, id);
    let mine = all.iter().find(|c| c.pc == pc).cloned();
    let other = all.iter().filter(|c| c.pc != pc).max_by_key(|c| c.created).cloned();
    let state = match (&other, &mine) {
        (None, _) => "none",
        (Some(o), _) if local == Some(o.fingerprint.as_str()) => "synced",
        (Some(o), Some(m)) if m.created >= o.created => "ahead",
        // Nothing here to lose: no saves at all, or exactly what this PC already sent.
        (Some(_), m) if local.is_none() || m.as_ref().map(|m| Some(m.fingerprint.as_str()) == local).unwrap_or(false) => "newer",
        _ => "conflict",
    };
    Status { state, other, mine }
}

/// Copies this PC's newest backup of the game to the shared folder. Ok(false) when there is no
/// backup yet or the copy there is already the same.
pub fn push(shared: &Path, auto_root: &Path, id: &str, pc: &str) -> Result<bool, String> {
    let dir = game_dir(shared, id).ok_or("Este jogo não pode ser sincronizado.")?;
    let Some(newest) = autosave::list(auto_root, id).into_iter().next() else { return Ok(false) };
    let src = autosave::backup_path(auto_root, id, &newest.file);
    let want = autosave::manifest_of(&src).ok_or("O backup mais novo está danificado.")?;
    let dst = dir.join(format!("{pc}.zip"));
    if autosave::manifest_of(&dst).map(|m| m.fingerprint == want.fingerprint).unwrap_or(false) {
        return Ok(false);
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("Não consegui usar a pasta de sincronização: {e}"))?;
    // Written under another name first: a sync program never sees half a file as the real one.
    let tmp = dir.join(format!("{pc}.zip.enviando"));
    std::fs::copy(&src, &tmp).map_err(|e| format!("Não consegui copiar o save para a pasta de sincronização: {e}"))?;
    // The sync program may be reading the old copy just now: a plain copy over it is the second try.
    let placed = std::fs::rename(&tmp, &dst).or_else(|_| std::fs::copy(&tmp, &dst).map(|_| ()));
    let _ = std::fs::remove_file(&tmp);
    placed.map_err(|e| format!("Não consegui gravar na pasta de sincronização: {e}"))?;
    Ok(true)
}

/// Brings another PC's copy into this PC's own backups and returns its file name there, ready
/// for autosave::restore.
pub fn fetch(shared: &Path, auto_root: &Path, id: &str, from_pc: &str) -> Result<String, String> {
    let dir = game_dir(shared, id).ok_or("Este jogo não pode ser sincronizado.")?;
    if from_pc.is_empty() || safe_name(from_pc) != from_pc {
        return Err("Nome de PC inválido.".into());
    }
    let src = dir.join(format!("{from_pc}.zip"));
    let m = autosave::manifest_of(&src).ok_or("O save do outro PC ainda não chegou inteiro. Espere a sincronização terminar e tente de novo.")?;
    if m.game != id {
        return Err("Esse arquivo é de outro jogo.".into());
    }
    let name = format!("de-{from_pc}-{}.zip", m.created);
    let dst = autosave::backup_path(auto_root, id, &name);
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::copy(&src, &dst).map_err(|e| format!("Não consegui trazer o save: {e}"))?;
    Ok(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("blackflag-sync-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// One PC: its saves folder and its own backups.
    fn pc(root: &Path, name: &str) -> (Vec<(String, PathBuf)>, PathBuf) {
        let saves = root.join(name).join("saves");
        std::fs::create_dir_all(&saves).unwrap();
        (vec![("saves".to_string(), saves)], root.join(name).join("backups"))
    }

    fn play(src: &[(String, PathBuf)], auto: &Path, text: &[u8], now: u64) {
        std::fs::write(src[0].1.join("slot1.sav"), text).unwrap();
        autosave::make(auto, "mm", src, "ao fechar o jogo", 10, now).unwrap();
    }

    #[test]
    fn a_save_goes_from_one_pc_to_the_other() {
        let root = temp("travel");
        let shared = root.join("nuvem");
        std::fs::create_dir_all(&shared).unwrap();
        let (sala, sala_auto) = pc(&root, "sala");
        let (quarto, quarto_auto) = pc(&root, "quarto");

        // Nobody has sent anything yet.
        assert_eq!(status(&shared, "mm", "SALA", None).state, "none");
        assert!(!push(&shared, &sala_auto, "mm", "SALA").unwrap(), "sem backup, nada vai");

        play(&sala, &sala_auto, b"templo 1", 100);
        assert!(push(&shared, &sala_auto, "mm", "SALA").unwrap());
        assert!(!push(&shared, &sala_auto, "mm", "SALA").unwrap(), "o mesmo save não vai duas vezes");

        // The other PC has no saves: the copy is news, with nothing to lose.
        let s = status(&shared, "mm", "QUARTO", autosave::fingerprint_now(&quarto).as_deref());
        assert_eq!(s.state, "newer");
        assert_eq!(s.other.as_ref().unwrap().pc, "SALA");

        let file = fetch(&shared, &quarto_auto, "mm", "SALA").unwrap();
        autosave::restore(&quarto_auto, "mm", &file, &quarto).unwrap();
        assert_eq!(std::fs::read(quarto[0].1.join("slot1.sav")).unwrap(), b"templo 1");
        assert_eq!(status(&shared, "mm", "QUARTO", autosave::fingerprint_now(&quarto).as_deref()).state, "synced");

        // Played on the second PC and sent: the first one sees news, the second is ahead.
        play(&quarto, &quarto_auto, b"templo 2", 200);
        assert!(push(&shared, &quarto_auto, "mm", "QUARTO").unwrap());
        assert_eq!(status(&shared, "mm", "QUARTO", autosave::fingerprint_now(&quarto).as_deref()).state, "ahead");
        assert_eq!(status(&shared, "mm", "SALA", autosave::fingerprint_now(&sala).as_deref()).state, "newer");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn saves_changed_on_both_sides_are_a_conflict() {
        let root = temp("conflict");
        let shared = root.join("nuvem");
        std::fs::create_dir_all(&shared).unwrap();
        let (sala, sala_auto) = pc(&root, "sala");
        let (quarto, quarto_auto) = pc(&root, "quarto");

        play(&sala, &sala_auto, b"a", 100);
        push(&shared, &sala_auto, "mm", "SALA").unwrap();
        // The second PC played on its own, without ever sending, and the first sent again later.
        std::fs::write(quarto[0].1.join("slot1.sav"), b"b").unwrap();
        play(&sala, &sala_auto, b"c", 300);
        push(&shared, &sala_auto, "mm", "SALA").unwrap();
        assert_eq!(status(&shared, "mm", "QUARTO", autosave::fingerprint_now(&quarto).as_deref()).state, "conflict");

        // It sent once, then changed its saves without sending: still a conflict.
        autosave::make(&quarto_auto, "mm", &quarto, "manual", 10, 150).unwrap();
        push(&shared, &quarto_auto, "mm", "QUARTO").unwrap();
        std::fs::write(quarto[0].1.join("slot1.sav"), b"d").unwrap();
        assert_eq!(status(&shared, "mm", "QUARTO", autosave::fingerprint_now(&quarto).as_deref()).state, "conflict");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn odd_names_never_leave_the_folder() {
        let root = temp("names");
        assert_eq!(safe_name("DESKTOP-AB12"), "DESKTOP-AB12");
        assert_eq!(safe_name("..\\x"), "---x");
        assert_eq!(safe_name(""), "pc");
        assert!(fetch(&root, &root.join("b"), "mm", "../outro").is_err());
        assert!(fetch(&root, &root.join("b"), "../mm", "SALA").is_err());
        assert!(push(&root, &root.join("b"), "a/b", "SALA").is_err());
        assert!(copies(&root, "..").is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }
}
