//! Games installed by the PC stores (Steam, Epic, GOG), found the way Playnite and LaunchBox
//! find them: only by reading each store's own files and registry keys. No sign-in, nothing
//! sent anywhere. Each game becomes a "Jogo de PC" that the store opens.

use std::path::{Path, PathBuf};

use crate::reg::{self, Root};

#[derive(Debug, Clone, PartialEq)]
pub struct Found {
    /// "steam", "epic" or "gog".
    pub store: &'static str,
    pub store_id: String,
    pub title: String,
    pub dir: PathBuf,
    /// The program inside `dir`, when the store says which one.
    pub exe: Option<String>,
    /// How the store opens the game; None: the program is started directly.
    pub launch_url: Option<String>,
    /// An image the store already keeps on this PC (Steam's library cache).
    pub cover: Option<PathBuf>,
}

impl Found {
    /// The library id: the store and its own id, so the same game is never added twice.
    pub fn id(&self) -> String {
        format!("{}-{}", self.store, id_safe(&self.store_id))
    }
}

pub fn id_safe(s: &str) -> String {
    s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c.to_ascii_lowercase() } else { '_' }).collect()
}

pub fn store_name(store: &str) -> &'static str {
    match store {
        "steam" => "Steam",
        "epic" => "Epic Games",
        "gog" => "GOG",
        _ => "Loja",
    }
}

// ---- Steam's text format (VDF / KeyValues) ----

#[derive(Debug, Clone, PartialEq)]
pub enum Vdf {
    Str(String),
    Obj(Vec<(String, Vdf)>),
}

impl Vdf {
    /// A child by key, ignoring case (Steam writes "AppState" and "appstate").
    pub fn get(&self, key: &str) -> Option<&Vdf> {
        match self {
            Vdf::Obj(items) => items.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v),
            Vdf::Str(_) => None,
        }
    }

    pub fn str(&self, key: &str) -> Option<&str> {
        match self.get(key) {
            Some(Vdf::Str(s)) => Some(s),
            _ => None,
        }
    }

    pub fn items(&self) -> &[(String, Vdf)] {
        match self {
            Vdf::Obj(items) => items,
            Vdf::Str(_) => &[],
        }
    }
}

/// Reads KeyValues text: quoted keys and values, braces for objects, // comments.
pub fn parse_vdf(text: &str) -> Option<Vdf> {
    let mut tokens = Vec::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                let mut s = String::new();
                while let Some(c) = chars.next() {
                    match c {
                        '\\' => match chars.next() {
                            Some('n') => s.push('\n'),
                            Some('t') => s.push('\t'),
                            Some(other) => s.push(other),
                            None => break,
                        },
                        '"' => break,
                        other => s.push(other),
                    }
                }
                tokens.push(Some(s));
            }
            '{' => tokens.push(None),
            '}' => tokens.push(Some("\u{0}}".into())),
            '/' if chars.peek() == Some(&'/') => {
                for c in chars.by_ref() {
                    if c == '\n' {
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    let mut pos = 0;
    let items = parse_items(&tokens, &mut pos, 0)?;
    Some(Vdf::Obj(items))
}

const CLOSE: &str = "\u{0}}";
const MAX_DEPTH: u32 = 32;

fn parse_items(tokens: &[Option<String>], pos: &mut usize, depth: u32) -> Option<Vec<(String, Vdf)>> {
    if depth > MAX_DEPTH {
        return None;
    }
    let mut items = Vec::new();
    while *pos < tokens.len() {
        let key = match &tokens[*pos] {
            Some(k) if k == CLOSE => {
                *pos += 1;
                return Some(items);
            }
            Some(k) => k.clone(),
            None => return None,
        };
        *pos += 1;
        match tokens.get(*pos)? {
            None => {
                *pos += 1;
                items.push((key, Vdf::Obj(parse_items(tokens, pos, depth + 1)?)));
            }
            Some(v) if v != CLOSE => {
                items.push((key, Vdf::Str(v.clone())));
                *pos += 1;
            }
            Some(_) => return None,
        }
    }
    Some(items)
}

// ---- Steam ----

/// Steam's own tools and runtimes, never games.
const STEAM_NOT_GAMES: &[&str] = &["228980", "1070560", "1391110", "1628350", "1493710", "2180100", "1826330", "1887720", "250820"];

/// The library folders listed in libraryfolders.vdf (both the current and the old layout).
pub fn steam_libraries(vdf: &Vdf) -> Vec<PathBuf> {
    let root = vdf.get("libraryfolders").or_else(|| vdf.get("LibraryFolders"));
    let Some(root) = root else { return Vec::new() };
    root.items()
        .iter()
        .filter(|(k, _)| k.chars().all(|c| c.is_ascii_digit()))
        .filter_map(|(_, v)| match v {
            Vdf::Str(p) => Some(PathBuf::from(p)),
            Vdf::Obj(_) => v.str("path").map(PathBuf::from),
        })
        .collect()
}

/// One appmanifest: a game fully installed (StateFlags bit 4), not a tool.
pub fn steam_game(manifest: &Vdf, library: &Path) -> Option<Found> {
    let app = manifest.get("AppState")?;
    let id = app.str("appid")?.trim().to_string();
    let name = app.str("name")?.trim().to_string();
    let dir_name = app.str("installdir")?.trim().to_string();
    let flags: u32 = app.str("StateFlags").and_then(|s| s.trim().parse().ok()).unwrap_or(0);
    if flags & 4 == 0 || STEAM_NOT_GAMES.contains(&id.as_str()) || dir_name.is_empty() || name.is_empty() {
        return None;
    }
    let lower = name.to_lowercase();
    if lower.starts_with("proton") || lower.starts_with("steam linux runtime") || lower.contains("redistributable") || lower.starts_with("steamvr") {
        return None;
    }
    if !id.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some(Found {
        store: "steam",
        launch_url: Some(format!("steam://rungameid/{id}")),
        store_id: id,
        title: name,
        dir: library.join("steamapps").join("common").join(dir_name),
        exe: None,
        cover: None,
    })
}

/// Steam keeps each game's library art on this PC (two layouts over the years).
fn steam_cover(root: &Path, id: &str) -> Option<PathBuf> {
    let cache = root.join("appcache").join("librarycache");
    [cache.join(format!("{id}_library_600x900.jpg")), cache.join(id).join("library_600x900.jpg"), cache.join(format!("{id}_header.jpg")), cache.join(id).join("header.jpg")]
        .into_iter()
        .find(|p| p.is_file())
}

/// The library art of a Steam game, by its app id.
pub fn steam_cover_for(app_id: &str) -> Option<PathBuf> {
    if !app_id.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    steam_cover(&crate::steam::steam_root()?, app_id)
}

pub fn steam() -> Vec<Found> {
    let Some(root) = crate::steam::steam_root() else { return Vec::new() };
    let mut libraries = std::fs::read_to_string(root.join("steamapps").join("libraryfolders.vdf"))
        .ok()
        .and_then(|t| parse_vdf(&t))
        .map(|v| steam_libraries(&v))
        .unwrap_or_default();
    if !libraries.iter().any(|l| same_dir(l, &root)) {
        libraries.insert(0, root.clone());
    }
    let mut out: Vec<Found> = Vec::new();
    for lib in libraries {
        let Ok(entries) = std::fs::read_dir(lib.join("steamapps")) else { continue };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_lowercase();
            if !(name.starts_with("appmanifest_") && name.ends_with(".acf")) {
                continue;
            }
            let Some(mut game) = std::fs::read_to_string(e.path()).ok().and_then(|t| parse_vdf(&t)).and_then(|v| steam_game(&v, &lib)) else { continue };
            // A game still downloading has a manifest but not its folder yet.
            if !game.dir.is_dir() || out.iter().any(|g| g.store_id == game.store_id) {
                continue;
            }
            game.cover = steam_cover(&root, &game.store_id);
            out.push(game);
        }
    }
    out
}

fn same_dir(a: &Path, b: &Path) -> bool {
    let n = |p: &Path| p.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_lowercase();
    n(a) == n(b)
}

// ---- Epic Games ----

/// One Epic manifest (.item, JSON): a whole game, fully installed.
pub fn epic_game(json: &str) -> Option<Found> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
    if v.get("bIsIncompleteInstall").and_then(|x| x.as_bool()).unwrap_or(false) {
        return None;
    }
    let app = s("AppName");
    let main = s("MainGameAppName");
    // DLC and add-ons have their own manifest pointing at the main game.
    if app.is_empty() || (!main.is_empty() && main != app) {
        return None;
    }
    let categories: Vec<String> = v
        .get("AppCategories")
        .and_then(|c| c.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_lowercase)).collect())
        .unwrap_or_default();
    if !categories.is_empty() && !categories.iter().any(|c| c == "games") {
        return None;
    }
    let (ns, item) = (s("CatalogNamespace"), s("CatalogItemId"));
    let dir = PathBuf::from(s("InstallLocation"));
    let title = s("DisplayName");
    if title.is_empty() || dir.as_os_str().is_empty() || ns.is_empty() || item.is_empty() {
        return None;
    }
    let exe = Some(s("LaunchExecutable")).filter(|e| !e.is_empty() && !e.contains(".."));
    Some(Found {
        store: "epic",
        launch_url: Some(format!("com.epicgames.launcher://apps/{ns}%3A{item}%3A{app}?action=launch&silent=true")),
        store_id: app,
        title,
        dir,
        exe,
        cover: None,
    })
}

pub fn epic() -> Vec<Found> {
    let data = std::env::var_os("ProgramData").map(PathBuf::from).unwrap_or_else(|| r"C:\ProgramData".into());
    let Ok(entries) = std::fs::read_dir(data.join("Epic").join("EpicGamesLauncher").join("Data").join("Manifests")) else { return Vec::new() };
    let mut out: Vec<Found> = Vec::new();
    for e in entries.flatten() {
        if !e.file_name().to_string_lossy().to_lowercase().ends_with(".item") {
            continue;
        }
        let Some(game) = std::fs::read_to_string(e.path()).ok().and_then(|t| epic_game(&t)) else { continue };
        if game.dir.is_dir() && !out.iter().any(|g| g.store_id == game.store_id) {
            out.push(game);
        }
    }
    out
}

// ---- GOG ----

/// The game's program relative to its folder, from GOG's full path.
pub fn relative_exe(dir: &Path, exe: &str) -> Option<String> {
    let exe = exe.trim().trim_matches('"');
    let rel = Path::new(exe).strip_prefix(dir).ok().map(|p| p.to_string_lossy().to_string()).or_else(|| {
        // GOG sometimes writes the folder with different case or a trailing slash.
        let (d, e) = (dir.to_string_lossy().to_lowercase(), exe.to_lowercase());
        let d = d.trim_end_matches('\\');
        e.strip_prefix(d).and_then(|_| exe.get(d.len()..)).map(|r| r.trim_start_matches('\\').to_string())
    })?;
    (!rel.is_empty() && !rel.contains("..") && rel.to_lowercase().ends_with(".exe")).then_some(rel)
}

pub fn gog() -> Vec<Found> {
    let mut out: Vec<Found> = Vec::new();
    for base in [r"SOFTWARE\WOW6432Node\GOG.com\Games", r"SOFTWARE\GOG.com\Games"] {
        for id in reg::subkeys(Root::Machine, base) {
            let key = format!(r"{base}\{id}");
            let get = |v: &str| reg::get_string(Root::Machine, &key, v).unwrap_or_default();
            let (title, path, exe) = (get("gameName"), get("path"), get("exe"));
            let dir = PathBuf::from(path.trim());
            if title.trim().is_empty() || !dir.is_dir() || !id.chars().all(|c| c.is_ascii_digit()) {
                continue;
            }
            let Some(rel) = relative_exe(&dir, &exe) else { continue };
            if out.iter().any(|g| g.store_id == id) {
                continue;
            }
            out.push(Found { store: "gog", store_id: id, title: title.trim().to_string(), dir, exe: Some(rel), launch_url: None, cover: None });
        }
    }
    out
}

/// Every store at once; a store that is not installed simply adds nothing.
pub fn all() -> Vec<Found> {
    let mut out = steam();
    out.extend(epic());
    out.extend(gog());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIBRARIES: &str = r#"
"libraryfolders"
{
	"0"
	{
		"path"		"C:\\Program Files (x86)\\Steam"
		"apps" { "228980" "0" "620" "123" }
	}
	"1"
	{
		"path"		"D:\\SteamLibrary"
	}
}"#;

    #[test]
    fn steam_libraries_both_layouts() {
        let v = parse_vdf(LIBRARIES).unwrap();
        assert_eq!(steam_libraries(&v), vec![PathBuf::from(r"C:\Program Files (x86)\Steam"), PathBuf::from(r"D:\SteamLibrary")]);
        let old = parse_vdf("\"LibraryFolders\" { \"TimeNextStatsReport\" \"1\" \"ContentStatsID\" \"2\" \"1\" \"E:\\\\Jogos\" } // fim").unwrap();
        assert_eq!(steam_libraries(&old), vec![PathBuf::from(r"E:\Jogos")]);
        assert!(parse_vdf("\"a\" { \"b\" ").is_none());
        assert!(parse_vdf("{").is_none());
    }

    fn manifest(id: &str, name: &str, flags: &str) -> Vdf {
        parse_vdf(&format!("\"AppState\" {{ \"appid\" \"{id}\" \"name\" \"{name}\" \"StateFlags\" \"{flags}\" \"installdir\" \"{name}\" }}")).unwrap()
    }

    #[test]
    fn steam_games_only_installed_and_real() {
        let lib = Path::new(r"D:\SteamLibrary");
        let g = steam_game(&manifest("620", "Portal 2", "4"), lib).unwrap();
        assert_eq!(g.id(), "steam-620");
        assert_eq!(g.launch_url.as_deref(), Some("steam://rungameid/620"));
        assert_eq!(g.dir, PathBuf::from(r"D:\SteamLibrary\steamapps\common\Portal 2"));
        // Still downloading (StateFlags without bit 4), Steam's redistributables, Proton.
        assert!(steam_game(&manifest("620", "Portal 2", "1026"), lib).is_none());
        assert!(steam_game(&manifest("228980", "Steamworks Common Redistributables", "4"), lib).is_none());
        assert!(steam_game(&manifest("1493710", "Proton Experimental", "4"), lib).is_none());
        assert!(steam_game(&manifest("abc", "Estranho", "4"), lib).is_none());
        assert!(steam_game(&manifest("70", "Half-Life", "6"), lib).is_some());
    }

    #[test]
    fn epic_games_without_dlc_or_half_installs() {
        let item = |extra: &str| {
            format!(
                r#"{{"DisplayName":"Hades","InstallLocation":"C:\\Jogos\\Hades","LaunchExecutable":"x64\\Hades.exe","AppName":"Min","MainGameAppName":"Min","CatalogNamespace":"ns1","CatalogItemId":"it1","AppCategories":["public","games","applications"]{extra}}}"#
            )
        };
        let g = epic_game(&item("")).unwrap();
        assert_eq!(g.id(), "epic-min");
        assert_eq!(g.exe.as_deref(), Some(r"x64\Hades.exe"));
        assert_eq!(g.launch_url.as_deref(), Some("com.epicgames.launcher://apps/ns1%3Ait1%3AMin?action=launch&silent=true"));
        assert!(epic_game(&item(r#","bIsIncompleteInstall":true"#)).is_none());
        let dlc = item("").replace(r#""MainGameAppName":"Min""#, r#""MainGameAppName":"Outro""#);
        assert!(epic_game(&dlc).is_none());
        let plugin = item("").replace(r#"["public","games","applications"]"#, r#"["plugins","engines"]"#);
        assert!(epic_game(&plugin).is_none());
        assert!(epic_game("não é json").is_none());
    }

    #[test]
    fn gog_program_inside_the_folder() {
        let dir = Path::new(r"C:\GOG Games\Witcher 3");
        assert_eq!(relative_exe(dir, r"C:\GOG Games\Witcher 3\bin\x64\witcher3.exe").as_deref(), Some(r"bin\x64\witcher3.exe"));
        assert_eq!(relative_exe(dir, r"c:\gog games\witcher 3\bin\x64\witcher3.exe").as_deref(), Some(r"bin\x64\witcher3.exe"));
        assert_eq!(relative_exe(dir, r"C:\Outro\jogo.exe"), None);
        assert_eq!(relative_exe(dir, r"C:\GOG Games\Witcher 3\..\x.exe"), None);
        assert_eq!(relative_exe(dir, r"C:\GOG Games\Witcher 3\leia.txt"), None);
    }

    #[test]
    fn ids_are_safe() {
        assert_eq!(id_safe("Fortnite:Main"), "fortnite_main");
        assert_eq!(store_name("gog"), "GOG");
    }
}
