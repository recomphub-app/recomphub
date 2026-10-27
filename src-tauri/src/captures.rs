//! Captures by game: the screenshots and clips already on this PC, found where Steam, the Xbox
//! Game Bar and the NVIDIA app keep them. Black Flag captures nothing itself; it only reads.
//!
//! - Steam: `userdata\<account>\760\remote\<app>\screenshots\*.jpg`, for the Steam game `app`.
//! - Xbox Game Bar: `Videos\Captures`, files named after the game's window and the date.
//! - NVIDIA app (and the older ShadowPlay): `Videos\NVIDIA\<game>` and `Videos\<game>`.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// The newest ones of a game; enough for a page.
const MAX: usize = 120;
const THUMB_WIDTH: u32 = 480;
/// A picture bigger than this is not opened (a capture is a few MB at most).
const MAX_PICTURE: u64 = 40 * 1024 * 1024;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Capture {
    pub path: String,
    pub video: bool,
    /// Unix time the file was last written.
    pub taken: u64,
    /// "Steam", "Xbox Game Bar" or "NVIDIA".
    pub source: &'static str,
}

/// The Videos folder, also when Windows moved it (OneDrive, another drive).
pub fn videos_dir() -> Option<PathBuf> {
    let raw = crate::reg::get_string(
        crate::reg::Root::User,
        r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders",
        "My Video",
    );
    let expanded = raw.map(|r| {
        let mut s = r;
        for var in ["USERPROFILE", "OneDrive", "OneDriveConsumer"] {
            if let Some(v) = std::env::var_os(var) {
                s = s.replace(&format!("%{var}%"), &v.to_string_lossy());
            }
        }
        PathBuf::from(s)
    });
    expanded
        .filter(|p| p.is_dir())
        .or_else(|| std::env::var_os("USERPROFILE").map(|u| PathBuf::from(u).join("Videos")).filter(|p| p.is_dir()))
}

/// The game's part of a Game Bar file name: "God of War III 2026-10-26 19-00-00" and the older
/// "Donkey Kong 64 10_26_2026 7_00_00 PM" both lose their date and time.
pub fn gamebar_title(stem: &str) -> String {
    let mut words: Vec<&str> = stem.split_whitespace().collect();
    let dated = |w: &str| {
        let up = w.to_ascii_uppercase();
        up == "AM" || up == "PM" || (w.contains(['-', '_', '.']) && w.chars().all(|c| c.is_ascii_digit() || matches!(c, '-' | '_' | '.')))
    };
    while words.last().is_some_and(|w| dated(w)) {
        words.pop();
    }
    words.join(" ")
}

/// Lowercase words, apostrophes dropped ("Majora's" and "Majoras" meet).
fn words(s: &str) -> Vec<String> {
    s.replace(['\'', '\u{2019}'], "")
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(|w| w.to_lowercase())
        .collect()
}

/// "II", "3", "IV": the next game of a series, not the same one with a subtitle.
fn sequel(word: &str) -> bool {
    word.chars().all(|c| c.is_ascii_digit()) || word.chars().all(|c| matches!(c, 'i' | 'v' | 'x'))
}

/// A capture's name (or folder) belongs to the game titled `title`: the same words, or one name
/// with a subtitle more ("Banjo-Kazooie" and "Banjo-Kazooie: Recompiled"), never a sequel
/// ("Hades" and "Hades II").
pub fn same_game(title: &str, name: &str) -> bool {
    let (a, b) = (words(title), words(name));
    if a.is_empty() || b.is_empty() {
        return false;
    }
    if a == b {
        return true;
    }
    let (short, long) = if a.len() <= b.len() { (&a, &b) } else { (&b, &a) };
    long.starts_with(short) && short.concat().len() >= 5 && !sequel(&long[short.len()])
}

fn kind(path: &Path) -> Option<bool> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "webp" => Some(false),
        "mp4" | "mkv" | "webm" | "mov" => Some(true),
        _ => None,
    }
}

fn take(dir: &Path, source: &'static str, keep: &dyn Fn(&Path) -> bool, out: &mut Vec<Capture>) {
    let Ok(read) = std::fs::read_dir(dir) else { return };
    for e in read.flatten() {
        let path = e.path();
        let Some(video) = kind(&path) else { continue };
        if !keep(&path) {
            continue;
        }
        let taken = e.metadata().ok().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
        out.push(Capture { path: path.display().to_string(), video, taken, source });
    }
}

/// The captures of a game, newest first. `steam_app`: its Steam app id, when it is a Steam game.
pub fn list(title: &str, steam_app: Option<u32>) -> Vec<Capture> {
    let mut out = Vec::new();
    if let (Some(app), Some(root)) = (steam_app, crate::steam::steam_root()) {
        if let Ok(accounts) = std::fs::read_dir(root.join("userdata")) {
            for a in accounts.flatten() {
                let shots = a.path().join("760").join("remote").join(app.to_string()).join("screenshots");
                take(&shots, "Steam", &|_| true, &mut out);
            }
        }
    }
    if let Some(videos) = videos_dir() {
        take(&videos.join("Captures"), "Xbox Game Bar", &|p| {
            p.file_stem().map(|s| same_game(title, &gamebar_title(&s.to_string_lossy()))).unwrap_or(false)
        }, &mut out);
        for base in [videos.join("NVIDIA"), videos.clone()] {
            let Ok(read) = std::fs::read_dir(&base) else { continue };
            for e in read.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if name.eq_ignore_ascii_case("Captures") || name.eq_ignore_ascii_case("NVIDIA") || !e.path().is_dir() {
                    continue;
                }
                if same_game(title, &name) {
                    take(&e.path(), "NVIDIA", &|_| true, &mut out);
                }
            }
        }
    }
    out.sort_by(|a, b| b.taken.cmp(&a.taken));
    out.dedup_by(|a, b| a.path == b.path);
    out.truncate(MAX);
    out
}

/// Only files inside the folders above are read or opened by the page.
pub fn allowed(path: &Path) -> bool {
    if kind(path).is_none() {
        return false;
    }
    let Ok(real) = path.canonicalize() else { return false };
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(v) = videos_dir() {
        roots.push(v);
    }
    if let Some(s) = crate::steam::steam_root() {
        roots.push(s.join("userdata"));
    }
    roots.iter().filter_map(|r| r.canonicalize().ok()).any(|r| real.starts_with(r))
}

/// A small JPEG of a picture, kept in `cache` (named after the file and when it was written).
pub fn thumbnail(cache: &Path, path: &Path) -> Option<Vec<u8>> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() > MAX_PICTURE {
        return None;
    }
    let stamp = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs();
    let key = xxhash_rust::xxh3::xxh3_64(format!("{}|{stamp}", path.display()).as_bytes());
    let file = cache.join(format!("{key:016x}.jpg"));
    if let Ok(b) = std::fs::read(&file) {
        return Some(b);
    }
    let img = image::ImageReader::open(path).ok()?.with_guessed_format().ok()?.decode().ok()?;
    let small = img.thumbnail(THUMB_WIDTH, THUMB_WIDTH * 2).to_rgb8();
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 80).encode_image(&small).ok()?;
    let bytes = bytes.into_inner();
    let _ = std::fs::create_dir_all(cache);
    let _ = std::fs::write(&file, &bytes);
    Some(bytes)
}

pub fn picture_bytes(path: &Path) -> Option<Vec<u8>> {
    let meta = std::fs::metadata(path).ok()?;
    (meta.len() <= MAX_PICTURE).then(|| std::fs::read(path).ok()).flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn game_bar_names_lose_the_date() {
        assert_eq!(gamebar_title("God of War III 2026-10-26 19-00-00"), "God of War III");
        assert_eq!(gamebar_title("Donkey Kong 64 10_26_2026 7_00_00 PM"), "Donkey Kong 64");
        assert_eq!(gamebar_title("Hades"), "Hades");
    }

    #[test]
    fn names_meet_the_game() {
        assert!(same_game("God of War III Remastered", "God of War III Remastered"));
        assert!(same_game("The Legend of Zelda: Majora's Mask", "The Legend of Zelda  Majoras Mask"));
        assert!(same_game("Banjo-Kazooie", "Banjo-Kazooie: Recompiled"));
        assert!(!same_game("Hades", "Hades II"));
        assert!(!same_game("God of War", "God of War III Remastered"));
        assert!(same_game("God of War III", "God of War III Remastered"));
        assert!(!same_game("Ori", "Origin"));
        assert!(!same_game("", "x"));
    }

    #[test]
    fn steam_and_folders_are_read() {
        let root = std::env::temp_dir().join("bf-capturas-teste");
        let _ = std::fs::remove_dir_all(&root);
        let shots = root.join("shots");
        std::fs::create_dir_all(&shots).unwrap();
        std::fs::write(shots.join("a.jpg"), b"x").unwrap();
        std::fs::write(shots.join("b.mp4"), b"x").unwrap();
        std::fs::write(shots.join("notas.txt"), b"x").unwrap();
        let mut out = Vec::new();
        take(&shots, "Steam", &|_| true, &mut out);
        out.sort_by(|a, b| a.path.cmp(&b.path));
        assert_eq!(out.len(), 2);
        assert!(!out[0].video && out[1].video);
        let _ = std::fs::remove_dir_all(&root);
    }
}
