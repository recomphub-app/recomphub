//! RetroAchievements, read only: with the player's own username and Web API key, the game
//! page shows what they earned in the ORIGINAL game, played in emulators RetroAchievements
//! approves. Black Flag never unlocks anything there (decision 32).
//!
//! The game is found by the ROM itself: RetroAchievements identifies N64 games by the MD5 of
//! the ROM in .z64 byte order, which is exactly how the ports store the player's ROM. The
//! console's game list (with hashes) is cached for a week, each game's progress for 6 hours,
//! and the badge pictures for good.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

const API: &str = "https://retroachievements.org/API/";
const MEDIA: &str = "https://media.retroachievements.org/Badge/";
pub const KEY_PAGE: &str = "https://retroachievements.org/settings";
pub const N64: u32 = 2;
pub const PS2: u32 = 21;
const LIST_MAX_AGE: u64 = 7 * 86_400;
pub const PROGRESS_MAX_AGE: u64 = 6 * 3600;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Achievement {
    pub id: u64,
    pub title: String,
    pub description: String,
    pub points: u32,
    pub badge: String,
    pub earned: Option<String>,
    pub earned_hardcore: Option<String>,
    pub order: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Progress {
    pub fetched_at: u64,
    pub game_id: u64,
    pub title: String,
    pub console: String,
    pub total: u32,
    pub earned: u32,
    pub earned_hardcore: u32,
    pub completion: String,
    pub achievements: Vec<Achievement>,
}

fn http() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .user_agent(concat!("BlackFlag/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .expect("http client")
}

fn get(params: &str, key: &str) -> Result<Value, String> {
    let resp = http()
        .get(format!("{API}{params}&y={}", crate::covers::encode(key)))
        .send()
        .map_err(|_| "sem conexão com o RetroAchievements.".to_string())?;
    match resp.status().as_u16() {
        200..=299 => resp.json().map_err(|_| "resposta ilegível do RetroAchievements.".to_string()),
        401 | 403 => Err("o usuário ou a chave de API foi recusado. Confira em Perfis.".into()),
        429 => Err("muitas consultas seguidas; tente daqui a pouco.".into()),
        s => Err(format!("o RetroAchievements respondeu com erro {s}.")),
    }
}

/// `true` when the username and key are accepted.
pub fn test(user: &str, key: &str) -> Result<String, String> {
    let v = get(&format!("API_GetUserProfile.php?u={}", crate::covers::encode(user)), key)?;
    v["User"].as_str().map(|u| format!("RetroAchievements: conectado como {u}.")).ok_or_else(|| "usuário não encontrado.".to_string())
}

/// MD5 of the ROM, lower case, as RetroAchievements lists it.
pub fn rom_md5(path: &Path) -> Option<String> {
    use md5::{Digest, Md5};
    let bytes = std::fs::read(path).ok()?;
    Some(format!("{:x}", Md5::digest(&bytes)))
}

/// The game whose hash list has `md5`, from a cached `API_GetGameList` answer.
pub fn find_by_hash(list: &Value, md5: &str) -> Option<(u64, String)> {
    list.as_array()?.iter().find_map(|g| {
        let hashes = g["Hashes"].as_array()?;
        hashes
            .iter()
            .any(|h| h.as_str().map(|h| h.eq_ignore_ascii_case(md5)).unwrap_or(false))
            .then(|| Some((g["ID"].as_u64()?, g["Title"].as_str()?.to_string())))
            .flatten()
    })
}

/// The console's games with their hashes, from the cache when it is under a week old.
pub fn game_list(dir: &Path, console: u32, key: &str) -> Result<Value, String> {
    let path = dir.join(format!("gamelist-{console}.json"));
    if let Ok(meta) = std::fs::metadata(&path) {
        let age = meta.modified().ok().and_then(|t| t.elapsed().ok()).map(|d| d.as_secs()).unwrap_or(u64::MAX);
        if age < LIST_MAX_AGE {
            if let Some(v) = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()) {
                return Ok(v);
            }
        }
    }
    let v = get(&format!("API_GetGameList.php?i={console}&h=1&f=1"), key)?;
    if !v.is_array() {
        return Err("lista de jogos ilegível.".into());
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let _ = std::fs::write(&path, serde_json::to_vec(&v).unwrap_or_default());
    Ok(v)
}

fn opt_date(v: &Value) -> Option<String> {
    v.as_str().filter(|s| !s.is_empty()).map(String::from)
}

pub fn parse_progress(v: &Value, now: u64) -> Option<Progress> {
    let mut achievements: Vec<Achievement> = v["Achievements"]
        .as_object()
        .map(|m| {
            m.values()
                .filter_map(|a| {
                    Some(Achievement {
                        id: a["ID"].as_u64()?,
                        title: a["Title"].as_str()?.to_string(),
                        description: a["Description"].as_str().unwrap_or("").to_string(),
                        points: a["Points"].as_u64().unwrap_or(0) as u32,
                        badge: a["BadgeName"].as_str().unwrap_or("").to_string(),
                        earned: opt_date(&a["DateEarned"]),
                        earned_hardcore: opt_date(&a["DateEarnedHardcore"]),
                        order: a["DisplayOrder"].as_i64().unwrap_or(0),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    achievements.sort_by(|a, b| a.order.cmp(&b.order).then(a.id.cmp(&b.id)));
    Some(Progress {
        fetched_at: now,
        game_id: v["ID"].as_u64()?,
        title: v["Title"].as_str().unwrap_or("").to_string(),
        console: v["ConsoleName"].as_str().unwrap_or("").to_string(),
        total: v["NumAchievements"].as_u64().unwrap_or(achievements.len() as u64) as u32,
        earned: v["NumAwardedToUser"].as_u64().unwrap_or(0) as u32,
        earned_hardcore: v["NumAwardedToUserHardcore"].as_u64().unwrap_or(0) as u32,
        completion: v["UserCompletion"].as_str().unwrap_or("").to_string(),
        achievements,
    })
}

pub fn progress(user: &str, key: &str, game_id: u64, now: u64) -> Result<Progress, String> {
    let v = get(&format!("API_GetGameInfoAndUserProgress.php?g={game_id}&u={}", crate::covers::encode(user)), key)?;
    parse_progress(&v, now).ok_or_else(|| "jogo não encontrado no RetroAchievements.".into())
}

fn valid_badge(name: &str) -> bool {
    !name.is_empty() && name.len() <= 32 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// The badge picture, downloaded once into `dir`.
pub fn badge(dir: &Path, name: &str) -> Option<PathBuf> {
    if !valid_badge(name) {
        return None;
    }
    let path = dir.join(format!("{name}.png"));
    if path.is_file() {
        return Some(path);
    }
    let bytes = http().get(format!("{MEDIA}{name}.png")).send().ok()?.bytes().ok()?;
    if !bytes.starts_with(&[0x89, b'P', b'N', b'G']) || bytes.len() > 512 * 1024 {
        return None;
    }
    std::fs::create_dir_all(dir).ok()?;
    std::fs::write(&path, &bytes).ok()?;
    Some(path)
}

/// "2026-10-25 16:06:27" (UTC), as RetroAchievements writes its dates.
pub fn date_text(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Days to a civil date (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// What PCSX2 writes in its log (pcsx2/Achievements.cpp) that Black Flag acts on.
#[derive(Debug, PartialEq)]
pub enum LogLine {
    /// "Hash for 'SLUS_212.42' (… bytes, … bytes hashed): <md5>", when a game starts.
    Hash(String),
    /// "Achievements: Achievement <title> (<id>) for game <game> unlocked".
    Unlock { title: String, id: u64, game: u64 },
    /// "Achievements: Game <game> complete".
    Complete(u64),
}

pub fn parse_log_line(line: &str) -> Option<LogLine> {
    let line = line.trim_end();
    if let Some(i) = line.find("Hash for '") {
        let hash = line[i..].rsplit(": ").next()?.trim();
        return (hash.len() == 32 && hash.chars().all(|c| c.is_ascii_hexdigit())).then(|| LogLine::Hash(hash.to_lowercase()));
    }
    if let Some(i) = line.find("Achievements: Achievement ") {
        let rest = line[i + "Achievements: Achievement ".len()..].strip_suffix(" unlocked")?;
        let (head, game) = rest.rsplit_once(" for game ")?;
        let (title, id) = head.rsplit_once(" (")?;
        return Some(LogLine::Unlock { title: title.to_string(), id: id.strip_suffix(')')?.parse().ok()?, game: game.trim().parse().ok()? });
    }
    if let Some(i) = line.find("Achievements: Game ") {
        let game = line[i + "Achievements: Game ".len()..].strip_suffix(" complete")?;
        return Some(LogLine::Complete(game.trim().parse().ok()?));
    }
    None
}

#[cfg(test)]
mod tests {
    #[test]
    fn pcsx2_log_lines() {
        use super::{parse_log_line, LogLine};
        assert_eq!(
            parse_log_line("[   12.3456] Achievements: Achievement Born (Again) (12345) for game 2911 unlocked"),
            Some(LogLine::Unlock { title: "Born (Again)".into(), id: 12345, game: 2911 })
        );
        assert_eq!(
            parse_log_line("[    3.0001] Hash for 'SLUS_212.42' (4096 bytes, 4096 bytes hashed): 0123456789ABCDEF0123456789abcdef"),
            Some(LogLine::Hash("0123456789abcdef0123456789abcdef".into()))
        );
        assert_eq!(parse_log_line("Achievements: Game 2911 complete"), Some(LogLine::Complete(2911)));
        assert_eq!(super::date_text(1_700_000_000), "2023-11-14 22:13:20");
        assert_eq!(super::date_text(951_782_400), "2000-02-29 00:00:00");
        assert_eq!(parse_log_line("Achievements: Attempting login with user 'x'..."), None);
    }

    use super::*;
    use serde_json::json;

    #[test]
    fn finds_the_game_by_rom_hash() {
        let list = json!([
            {"ID": 1, "Title": "Outro", "Hashes": ["aaa"]},
            {"ID": 10_101, "Title": "Banjo-Kazooie", "Hashes": ["0B15A7F5A1BB1B8CEA2DD5F4E24B4E6A", "bbb"]}
        ]);
        assert_eq!(find_by_hash(&list, "0b15a7f5a1bb1b8cea2dd5f4e24b4e6a"), Some((10_101, "Banjo-Kazooie".into())));
        assert_eq!(find_by_hash(&list, "ccc"), None);
    }

    #[test]
    fn reads_game_progress_in_display_order() {
        let v = json!({
            "ID": 10_101, "Title": "Banjo-Kazooie", "ConsoleName": "Nintendo 64",
            "NumAchievements": 2, "NumAwardedToUser": 1, "NumAwardedToUserHardcore": 0, "UserCompletion": "50.00%",
            "Achievements": {
                "2": {"ID": 2, "Title": "B", "Description": "d", "Points": 10, "BadgeName": "12345", "DisplayOrder": 2},
                "1": {"ID": 1, "Title": "A", "Description": "d", "Points": 5, "BadgeName": "12344", "DisplayOrder": 1,
                      "DateEarned": "2026-01-02 10:00:00"}
            }
        });
        let p = parse_progress(&v, 9).unwrap();
        assert_eq!(p.achievements[0].title, "A");
        assert_eq!(p.achievements[0].earned.as_deref(), Some("2026-01-02 10:00:00"));
        assert_eq!(p.achievements[1].earned, None);
        assert_eq!((p.total, p.earned), (2, 1));
    }

    #[test]
    fn badge_names_cannot_escape_the_folder() {
        assert!(valid_badge("12345"));
        assert!(valid_badge("12345_lock"));
        assert!(!valid_badge("../x"));
        assert!(!valid_badge(""));
    }
}
