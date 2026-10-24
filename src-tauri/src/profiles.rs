//! Several players on one PC. The library (what is installed where) is shared; each profile
//! has its own play time, last session, favorites, hidden games, completion, play count,
//! notes, history and (later) achievements.
//!
//! The active profile's progress always lives in library.json, so the rest of Black Flag
//! needs no change: switching profiles stores the current progress in
//! `profiles/<id>.json` and loads the other one's. Switching is refused while a game runs.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::library::{Completion, Entry, Library, ResumeNote};

pub const MAIN: &str = "principal";
pub const COLORS: &[&str] = &["#e0a32e", "#4cc38a", "#6aa7ff", "#e5675a", "#b07cf0", "#f08cc0", "#4cc3c3", "#9aa1ae"];

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub color: String,
    pub created: u64,
    /// RetroAchievements account (ra.rs), read only. The key never goes back to the page.
    #[serde(default)]
    pub ra_user: String,
    #[serde(default)]
    pub ra_key: String,
    /// Picture files in `art_dir` (profile picture and the wide picture on top of the profile).
    #[serde(default)]
    pub avatar: Option<String>,
    #[serde(default)]
    pub banner: Option<String>,
    /// The profile's color takes the place of the red accent everywhere.
    #[serde(default)]
    pub accent: bool,
    #[serde(default)]
    pub look: Look,
    /// The player's own pictures for games, by game id.
    #[serde(default)]
    pub art: BTreeMap<String, GameArt>,
}

/// How the program looks for this player (Perfil > Aparência).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Look {
    /// Library covers: "pequeno", "medio" or "grande".
    #[serde(default = "medium")]
    pub cards: String,
    #[serde(default)]
    pub big_text: bool,
    /// The library as a list instead of covers.
    #[serde(default)]
    pub list: bool,
    /// Library tab opened first ("all", "port", "pc_game", "discover", "community").
    #[serde(default = "all_tab")]
    pub home: String,
    /// Library tabs this player does not want to see.
    #[serde(default)]
    pub hidden_tabs: Vec<String>,
    /// Sounds and controller rumble in the Modo TV.
    #[serde(default = "yes")]
    pub sounds: bool,
    /// Slides and growing covers; off for a calmer screen.
    #[serde(default = "yes")]
    pub motion: bool,
    /// Open straight in the Modo TV.
    #[serde(default)]
    pub start_tv: bool,
    /// Which part of the wide profile picture shows when it is cut: "top", "center" or "bottom".
    #[serde(default = "center")]
    pub banner_pos: String,
    /// The wide profile picture on top of the library, with "Continuar jogando".
    #[serde(default = "yes")]
    pub banner_home: bool,
}

fn center() -> String {
    "center".into()
}

fn medium() -> String {
    "medio".into()
}

fn all_tab() -> String {
    "all".into()
}

impl Default for Look {
    fn default() -> Self {
        Self { cards: medium(), big_text: false, list: false, home: all_tab(), hidden_tabs: Vec::new(), sounds: true, motion: true, start_tv: false, banner_pos: center(), banner_home: true }
    }
}

pub const TABS: &[&str] = &["all", "port", "pc_game", "discover", "community"];

impl Look {
    /// Only known values are kept; the "Todos" tab can never be hidden.
    pub fn cleaned(mut self) -> Self {
        if !["pequeno", "medio", "grande"].contains(&self.cards.as_str()) {
            self.cards = medium();
        }
        if !TABS.contains(&self.home.as_str()) {
            self.home = all_tab();
        }
        self.hidden_tabs.retain(|t| TABS.contains(&t.as_str()) && t != "all");
        self.hidden_tabs.dedup();
        if !["top", "center", "bottom"].contains(&self.banner_pos.as_str()) {
            self.banner_pos = center();
        }
        if self.hidden_tabs.contains(&self.home) {
            self.home = all_tab();
        }
        self
    }
}

/// One picture the player keeps for a game, with an optional caption ("minha versão").
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ArtPicture {
    pub file: String,
    #[serde(default)]
    pub caption: String,
}

/// A player's own pictures for one game.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct GameArt {
    #[serde(default)]
    pub covers: Vec<ArtPicture>,
    /// The cover shown; None: the library's cover.
    #[serde(default)]
    pub active: Option<usize>,
    /// Picture behind the game in the Modo TV.
    #[serde(default)]
    pub background: Option<String>,
}

impl GameArt {
    pub fn active_cover(&self) -> Option<&str> {
        self.active.and_then(|i| self.covers.get(i)).map(|c| c.file.as_str())
    }
}

/// Where a profile's pictures live.
pub fn art_dir(dir: &Path, profile: &str) -> PathBuf {
    dir.join("arte").join(profile)
}

/// "#a1b2c3" only: the color goes into the page's style.
pub fn valid_color(c: &str) -> bool {
    c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|x| x.is_ascii_hexdigit())
}

/// A file name Black Flag itself gave to a picture ("avatar.png", "capa-banjo-3.jpg").
pub fn safe_file(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 120
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        && !name.starts_with('.')
        && !name.contains("..")
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Profiles {
    pub active: String,
    pub list: Vec<Profile>,
    /// Show "Quem vai jogar?" when Black Flag opens (with more than one profile).
    #[serde(default = "yes")]
    pub ask_on_start: bool,
    /// Games whose saves are kept apart for each profile (swapped when the profile changes).
    #[serde(default)]
    pub separate_saves: Vec<String>,
}

fn yes() -> bool {
    true
}

impl Default for Profiles {
    fn default() -> Self {
        Self {
            active: MAIN.into(),
            list: vec![Profile { id: MAIN.into(), name: "Principal".into(), color: COLORS[0].into(), ..Default::default() }],
            ask_on_start: true,
            separate_saves: Vec::new(),
        }
    }
}

/// What belongs to one player for one game.
#[derive(Serialize, Deserialize, Clone, Default, Debug, PartialEq)]
pub struct Progress {
    #[serde(default)]
    pub total_seconds: u64,
    #[serde(default)]
    pub last_played: Option<u64>,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub completion: Completion,
    #[serde(default)]
    pub play_count: u32,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub resume: Option<ResumeNote>,
}

impl Progress {
    fn of(e: &Entry) -> Self {
        Self {
            total_seconds: e.total_seconds,
            last_played: e.last_played,
            favorite: e.favorite,
            hidden: e.hidden,
            completion: e.completion,
            play_count: e.play_count,
            notes: e.notes.clone(),
            resume: e.resume.clone(),
        }
    }

    fn put(self, e: &mut Entry) {
        e.total_seconds = self.total_seconds;
        e.last_played = self.last_played;
        e.favorite = self.favorite;
        e.hidden = self.hidden;
        e.completion = self.completion;
        e.play_count = self.play_count;
        e.notes = self.notes;
        e.resume = self.resume;
    }
}

impl Profiles {
    pub fn load(path: &Path) -> Self {
        let mut p: Self = std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        if p.list.is_empty() {
            p = Self::default();
        }
        if !p.list.iter().any(|x| x.id == p.active) {
            p.active = p.list[0].id.clone();
        }
        p
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        let text = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(path, text).map_err(|e| e.to_string())
    }

    pub fn get(&self, id: &str) -> Option<&Profile> {
        self.list.iter().find(|p| p.id == id)
    }

    pub fn active(&self) -> &Profile {
        self.get(&self.active).unwrap_or(&self.list[0])
    }
}

/// A short id from the name, unique among the profiles.
pub fn new_id(profiles: &Profiles, name: &str, now: u64) -> String {
    let mut base: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    base.truncate(24);
    if base.is_empty() || base == MAIN {
        base = format!("perfil-{}", now % 100_000);
    }
    let mut id = base.clone();
    let mut n = 2;
    while profiles.get(&id).is_some() {
        id = format!("{base}-{n}");
        n += 1;
    }
    id
}

pub fn clean_name(name: &str) -> Result<String, String> {
    let name: String = name.trim().chars().filter(|c| !c.is_control()).collect();
    if name.is_empty() {
        return Err("Escreva um nome para o perfil.".into());
    }
    if name.chars().count() > 30 {
        return Err("Use um nome de até 30 letras.".into());
    }
    Ok(name)
}

fn progress_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.json"))
}

/// Everyone's progress in the library now (games and removed games).
pub fn extract(lib: &Library) -> BTreeMap<String, Progress> {
    lib.games.iter().chain(lib.removed.iter()).map(|(id, e)| (id.clone(), Progress::of(e))).collect()
}

/// Puts a profile's progress into the library; games it never played start from zero.
pub fn apply(lib: &mut Library, mut progress: BTreeMap<String, Progress>) {
    for (id, e) in lib.games.iter_mut().chain(lib.removed.iter_mut()) {
        progress.remove(id).unwrap_or_default().put(e);
    }
}

pub fn load_progress(dir: &Path, id: &str) -> BTreeMap<String, Progress> {
    std::fs::read(progress_path(dir, id)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

pub fn store_progress(dir: &Path, id: &str, p: &BTreeMap<String, Progress>) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(p).map_err(|e| e.to_string())?;
    let tmp = progress_path(dir, id).with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, progress_path(dir, id)).map_err(|e| e.to_string())
}

/// Stores the active profile's progress and loads `to`'s into the library.
pub fn switch(lib: &mut Library, profiles: &mut Profiles, dir: &Path, to: &str) -> Result<(), String> {
    if profiles.get(to).is_none() {
        return Err("Perfil não encontrado.".into());
    }
    if profiles.active == to {
        return Ok(());
    }
    store_progress(dir, &profiles.active, &extract(lib))?;
    apply(lib, load_progress(dir, to));
    profiles.active = to.to_string();
    Ok(())
}

/// Where a profile's own saves wait while another profile plays: `<dir>/saves/<profile>/<game>/<label>`.
pub fn stash(dir: &Path, profile: &str, game: &str, label: &str) -> PathBuf {
    dir.join("saves").join(profile).join(game).join(label)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lib_with(id: &str, secs: u64, fav: bool) -> Library {
        let mut lib = Library::default();
        lib.games.insert(id.into(), Entry { total_seconds: secs, favorite: fav, install_dir: "C:/x".into(), ..Default::default() });
        lib
    }

    #[test]
    fn each_profile_keeps_its_own_progress() {
        let dir = std::env::temp_dir().join(format!("recomphub-profiles-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut profiles = Profiles::default();
        let ana = Profile { id: "ana".into(), name: "Ana".into(), color: COLORS[1].into(), created: 1, ..Default::default() };
        profiles.list.push(ana);
        let mut lib = lib_with("banjo", 3600, true);

        switch(&mut lib, &mut profiles, &dir, "ana").unwrap();
        let e = &lib.games["banjo"];
        assert_eq!((e.total_seconds, e.favorite), (0, false), "a Ana começa do zero");
        assert_eq!(e.install_dir, "C:/x", "a instalação é a mesma");
        lib.games.get_mut("banjo").unwrap().total_seconds = 60;

        switch(&mut lib, &mut profiles, &dir, MAIN).unwrap();
        assert_eq!(lib.games["banjo"].total_seconds, 3600);
        assert!(lib.games["banjo"].favorite);
        switch(&mut lib, &mut profiles, &dir, "ana").unwrap();
        assert_eq!(lib.games["banjo"].total_seconds, 60);
        assert!(switch(&mut lib, &mut profiles, &dir, "ninguem").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ids_and_names() {
        let p = Profiles::default();
        assert_eq!(new_id(&p, "João Pedro!", 5), "jo-o-pedro");
        assert_eq!(new_id(&p, "Principal", 5), "perfil-5");
        assert!(clean_name("   ").is_err());
        assert!(clean_name(&"x".repeat(31)).is_err());
        assert_eq!(clean_name(" Ana ").unwrap(), "Ana");
    }

    #[test]
    fn looks_keep_only_known_values() {
        let l = Look { cards: "gigante".into(), home: "port".into(), banner_pos: "lado".into(), hidden_tabs: vec!["port".into(), "all".into(), "x".into()], ..Default::default() }.cleaned();
        assert_eq!(l.cards, "medio");
        assert_eq!(l.banner_pos, "center");
        assert_eq!(l.hidden_tabs, vec!["port".to_string()]);
        assert_eq!(l.home, "all", "a hidden tab is never the first one");
        let old: Profile = serde_json::from_str(r##"{"id":"a","name":"A","color":"#e0a32e","created":1}"##).unwrap();
        assert_eq!(old.look, Look::default(), "profiles from older versions get the default look");
        assert!(old.look.sounds && old.art.is_empty());
    }

    #[test]
    fn colors_and_file_names() {
        assert!(valid_color("#1A2b3C"));
        assert!(!valid_color("red") && !valid_color("#12345") && !valid_color("#12345g") && !valid_color("#123456;x"));
        assert!(safe_file("capa-banjo-3.jpg") && safe_file("avatar.png"));
        assert!(!safe_file("../x.png") && !safe_file("a/b.png") && !safe_file(".hidden") && !safe_file(""));
        let art = GameArt { covers: vec![ArtPicture { file: "a.png".into(), caption: String::new() }], active: Some(0), background: None };
        assert_eq!(art.active_cover(), Some("a.png"));
        assert_eq!(GameArt { active: Some(5), ..art.clone() }.active_cover(), None);
    }

    #[test]
    fn the_resume_note_belongs_to_the_profile() {
        let dir = std::env::temp_dir().join(format!("recomphub-resume-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut profiles = Profiles::default();
        profiles.list.push(Profile { id: "bia".into(), name: "Bia".into(), ..Default::default() });
        let mut lib = lib_with("gow3", 10, false);
        lib.games.get_mut("gow3").unwrap().resume = Some(ResumeNote { text: "no chefe".into(), at: 5, seconds: 600 });
        switch(&mut lib, &mut profiles, &dir, "bia").unwrap();
        assert!(lib.games["gow3"].resume.is_none());
        switch(&mut lib, &mut profiles, &dir, MAIN).unwrap();
        assert_eq!(lib.games["gow3"].resume.as_ref().unwrap().text, "no chefe");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
