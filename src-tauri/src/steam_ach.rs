//! Steam achievements, read only, from the files the Steam client keeps on this PC:
//! appcache/stats/UserGameStatsSchema_<app>.bin (every achievement: name, description in each
//! language, icon) and UserGameStats_<account>_<app>.bin (which are unlocked, and when). Both
//! are binary KeyValues, the format of shortcuts.vdf (steam.rs). Nothing is sent anywhere but
//! the icon download from Steam's own image server, and nothing is ever written there.
//!
//! In the schema, each stat of type ACHIEVEMENTS (written "ACHIEVEMENTS" or "4") is a block of
//! up to 32 achievements under "bits"; in the player's file the same stat has "data" (one bit
//! per achievement) and "AchievementTimes" (bit -> unix time).

use crate::steam::{self, Val};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const ICONS: &str = "https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/";

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Achievement {
    /// The game's own name for it ("ACH_WIN_ONE_GAME").
    pub api: String,
    pub title: String,
    pub description: String,
    pub hidden: bool,
    /// The icon's file name on Steam's image server.
    pub icon: String,
    pub unlocked_at: Option<u64>,
    #[serde(skip)]
    pub stat: u32,
    #[serde(skip)]
    pub bit: u32,
}

fn get<'a>(items: &'a [(Vec<u8>, Val)], key: &str) -> Option<&'a Val> {
    items.iter().find(|(k, _)| k.eq_ignore_ascii_case(key.as_bytes())).map(|(_, v)| v)
}

fn obj(v: Option<&Val>) -> Option<&[(Vec<u8>, Val)]> {
    match v {
        Some(Val::Obj(o)) => Some(o),
        _ => None,
    }
}

fn text(v: &Val) -> Option<String> {
    match v {
        Val::Str(s) => Some(String::from_utf8_lossy(s).trim().to_string()),
        Val::Int(n) => Some(n.to_string()),
        _ => None,
    }
}

fn number(v: Option<&Val>) -> Option<u32> {
    match v? {
        Val::Int(n) => Some(*n),
        v => text(v)?.parse().ok(),
    }
}

/// A text the schema gives either once or per language: Portuguese (Brazil) first.
fn localized(v: Option<&Val>) -> String {
    match v {
        Some(Val::Obj(langs)) => ["brazilian", "portuguese", "english"]
            .iter()
            .find_map(|l| get(langs, l).and_then(text).filter(|t| !t.is_empty()))
            .or_else(|| langs.iter().filter(|(k, _)| k != b"token").find_map(|(_, v)| text(v)))
            .unwrap_or_default(),
        Some(v) => text(v).unwrap_or_default(),
        None => String::new(),
    }
}

/// Every achievement in the schema, in its order.
pub fn parse_schema(bytes: &[u8]) -> Option<Vec<Achievement>> {
    let root = steam::parse(bytes).ok()?;
    let (_, Val::Obj(game)) = root.first()? else { return None };
    let mut out = Vec::new();
    for (id, stat) in obj(get(game, "stats"))? {
        let Val::Obj(stat) = stat else { continue };
        let kind = get(stat, "type").and_then(text).unwrap_or_default();
        if kind != "ACHIEVEMENTS" && kind != "4" {
            continue;
        }
        let Some(stat_id) = std::str::from_utf8(id).ok().and_then(|s| s.parse().ok()) else { continue };
        for (key, a) in obj(get(stat, "bits")).unwrap_or_default() {
            let Val::Obj(a) = a else { continue };
            let Some(bit) = number(get(a, "bit")).or_else(|| std::str::from_utf8(key).ok()?.parse().ok()) else { continue };
            let display = obj(get(a, "display")).unwrap_or_default();
            out.push(Achievement {
                api: get(a, "name").and_then(text).unwrap_or_default(),
                title: localized(get(display, "name")),
                description: localized(get(display, "desc")),
                hidden: number(get(display, "hidden")).unwrap_or(0) != 0,
                icon: get(display, "icon").and_then(text).unwrap_or_default(),
                unlocked_at: None,
                stat: stat_id,
                bit,
            });
        }
    }
    (!out.is_empty()).then_some(out)
}

/// The unlocked achievements in the player's file: (stat, bit) -> unix time (0 when Steam
/// kept no time).
pub fn parse_progress(bytes: &[u8]) -> BTreeMap<(u32, u32), u64> {
    let mut out = BTreeMap::new();
    let Ok(root) = steam::parse(bytes) else { return out };
    let Some(cache) = obj(get(&root, "cache")) else { return out };
    for (id, stat) in cache {
        let (Some(stat_id), Val::Obj(stat)) = (std::str::from_utf8(id).ok().and_then(|s| s.parse::<u32>().ok()), stat) else { continue };
        let Some(data) = number(get(stat, "data")) else { continue };
        let times = obj(get(stat, "AchievementTimes")).unwrap_or_default();
        for bit in 0..32 {
            if data & (1 << bit) != 0 {
                let when = get(times, &bit.to_string()).and_then(|v| number(Some(v))).unwrap_or(0);
                out.insert((stat_id, bit), u64::from(when));
            }
        }
    }
    out
}

pub fn stats_dir(root: &Path) -> PathBuf {
    root.join("appcache").join("stats")
}

/// The player's file for the game: the account that used Steam last, else the newest one.
pub fn progress_file(root: &Path, app: u32) -> Option<PathBuf> {
    let dir = stats_dir(root);
    let account = steam::account_config(root).and_then(|c| c.parent()?.file_name()?.to_str().map(String::from));
    if let Some(a) = account {
        let p = dir.join(format!("UserGameStats_{a}_{app}.bin"));
        if p.is_file() {
            return Some(p);
        }
    }
    let suffix = format!("_{app}.bin");
    std::fs::read_dir(&dir)
        .ok()?
        .flatten()
        .filter(|e| {
            let n = e.file_name().to_string_lossy().to_string();
            n.starts_with("UserGameStats_") && !n.starts_with("UserGameStatsSchema_") && n.ends_with(&suffix)
        })
        .max_by_key(|e| e.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH))
        .map(|e| e.path())
}

/// The game's achievements with what the player unlocked, or None when Steam has no schema
/// for it on this PC (the game has none, or was never opened here).
pub fn list(root: &Path, app: u32) -> Option<Vec<Achievement>> {
    let schema = std::fs::read(stats_dir(root).join(format!("UserGameStatsSchema_{app}.bin"))).ok()?;
    let mut list = parse_schema(&schema)?;
    let done = progress_file(root, app).and_then(|p| std::fs::read(p).ok()).map(|b| parse_progress(&b)).unwrap_or_default();
    for a in &mut list {
        a.unlocked_at = done.get(&(a.stat, a.bit)).copied();
    }
    Some(list)
}

fn valid_icon(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_') && !name.contains("..")
}

/// The icon, downloaded once from Steam's image server into `dir`.
pub fn icon(dir: &Path, app: u32, name: &str) -> Option<PathBuf> {
    if !valid_icon(name) {
        return None;
    }
    let path = dir.join(app.to_string()).join(name);
    if path.is_file() {
        return Some(path);
    }
    let resp = reqwest::blocking::Client::builder()
        .user_agent(concat!("BlackFlag/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .ok()?
        .get(format!("{ICONS}{app}/{name}"))
        .send()
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let bytes = resp.bytes().ok()?;
    let image = bytes.starts_with(&[0xFF, 0xD8]) || bytes.starts_with(&[0x89, b'P', b'N', b'G']);
    if !image || bytes.len() > 512 * 1024 {
        return None;
    }
    std::fs::create_dir_all(path.parent()?).ok()?;
    std::fs::write(&path, &bytes).ok()?;
    Some(path)
}

/// The Steam app of a library game ("steam-620" -> 620).
pub fn app_of(id: &str) -> Option<u32> {
    id.strip_prefix("steam-")?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(k: &str, v: &str) -> (Vec<u8>, Val) {
        (k.as_bytes().to_vec(), Val::Str(v.as_bytes().to_vec()))
    }
    fn i(k: &str, v: u32) -> (Vec<u8>, Val) {
        (k.as_bytes().to_vec(), Val::Int(v))
    }
    fn o(k: &str, v: Vec<(Vec<u8>, Val)>) -> (Vec<u8>, Val) {
        (k.as_bytes().to_vec(), Val::Obj(v))
    }

    #[test]
    fn schema_and_progress_are_read() {
        let ach = |name: &str, bit: Option<u32>, title: Vec<(Vec<u8>, Val)>, hidden: (Vec<u8>, Val)| {
            let mut a = vec![s("name", name), o("display", vec![o("name", title), o("desc", vec![s("english", "Do it.")]), hidden, s("icon", "abc123.jpg")])];
            if let Some(b) = bit {
                a.push(i("bit", b));
            }
            a
        };
        let schema = steam::write(&[o(
            "620",
            vec![
                o(
                    "stats",
                    vec![
                        o("1", vec![s("type", "INT"), s("name", "kills")]),
                        o(
                            "2",
                            vec![
                                o(
                                    "bits",
                                    vec![
                                        o("0", ach("ACH_A", None, vec![s("english", "First"), s("brazilian", "Primeira")], i("hidden", 0))),
                                        o("1", ach("ACH_B", Some(5), vec![s("token", "#x"), s("english", "Secret")], s("hidden", "1"))),
                                    ],
                                ),
                                s("type", "ACHIEVEMENTS"),
                            ],
                        ),
                    ],
                ),
                s("gamename", "Portal 2"),
            ],
        )]);
        let list = parse_schema(&schema).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!((list[0].title.as_str(), list[0].bit, list[0].hidden), ("Primeira", 0, false));
        assert_eq!((list[1].title.as_str(), list[1].bit, list[1].hidden), ("Secret", 5, true));
        assert_eq!(list[1].description, "Do it.");

        let progress = steam::write(&[o(
            "cache",
            vec![
                i("crc", 1),
                o("2", vec![i("data", 1 << 5 | 1 << 9), o("AchievementTimes", vec![i("5", 1_700_000_000)])]),
            ],
        )]);
        let done = parse_progress(&progress);
        assert_eq!(done.get(&(2, 5)), Some(&1_700_000_000));
        assert_eq!(done.get(&(2, 9)), Some(&0));
        assert_eq!(done.get(&(2, 0)), None);
        assert!(parse_schema(b"lixo").is_none());
    }

    #[test]
    fn icons_and_ids_are_checked() {
        assert!(valid_icon("4575d270deb285877c6b7b0728ee19af67c113b2.jpg"));
        assert!(!valid_icon("../x.jpg") && !valid_icon("a/b.jpg") && !valid_icon(""));
        assert_eq!(app_of("steam-2638890"), Some(2638890));
        assert_eq!(app_of("epic-x"), None);
    }
}
