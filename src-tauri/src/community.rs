//! Aba Comunidade: ports listed live from GitHub, outside Black Flag's verified catalog.
//!
//! Two sources, merged by repository:
//! - the curated list Sebastrion/awesome-unofficial-pc-ports (MIT), read from its README;
//! - GitHub topic searches (`pc-port`, `native-port`, `game-port`, the recompilers' topics...).
//!
//! Each topic is searched two ways: by stars (the popular ones, every 3 days) and by last update
//! (new ports and new versions, every 6 hours). A topic has hundreds of projects, so neither
//! search sees them all at once: the list keeps what earlier searches found and drops a port
//! only after 90 days unseen. GitHub allows 10 searches a minute without a token, so without
//! one a refresh does one of the two kinds; with a token, both. Nothing here is checked by
//! Black Flag: installing one of these ports is experimental, and the page says so.

use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::github;

const LIST_URL: &str = "https://raw.githubusercontent.com/Sebastrion/awesome-unofficial-pc-ports/main/README.md";
pub const LIST_PAGE: &str = "https://github.com/Sebastrion/awesome-unofficial-pc-ports";
/// GitHub topics searched and how many pages of 100 each: general PC ports, native ports, game
/// ports, and the games of the N64, Xbox 360, PS3 and PS2 recompilers. Eleven searches: without a
/// token GitHub allows ten a minute, so the last one can fail and keep its old entries.
const SEARCHES: &[(&str, u32)] = &[
    ("pc-port", 2),
    ("native-port", 1),
    ("game-port", 1),
    ("n64recomp", 1),
    ("xenonrecomp", 1),
    ("rexglue", 1),
    ("ps3recomp", 1),
    ("ps2recomp", 1),
    ("pc-ports", 1),
    ("unofficial-port", 1),
];
/// Searches by words in the name and description, run before the topics: many new ports never
/// get a topic (Hookshot, the Ocarina of Time remake recompilation, had none at 700 stars), and the
/// curated list takes days to add them. At least 5 stars, so a day-old copy or a lure does not get in.
const QUERIES: &[&str] = &[
    "recomp+in:name,description+stars:>=5",
    "recompilation+in:description+stars:>=5",
    "%22pc+port%22+in:name,description+stars:>=5",
    "%22native+port%22+in:name,description+stars:>=5",
    "%22static+recompilation%22+in:description+stars:>=5",
];
/// What a word search finds that is not a game: trackers, archives, launchers, tools.
const NOT_A_PORT: &[&str] = &[
    "tracker", "trackers", "tools", "status", "monitor", "benchmark", "archive", "icons", "wallpaper", "website", "mirror", "launcher", "map",
    "tool", "toolkit", "template", "guide", "awesome", "list of", "widget", "discord", "bot",
];
/// Release checks per refresh for ports whose state is unknown or old (each is one request).
const RELEASE_CHECKS_TOKEN: usize = 12;
const RELEASE_CHECKS: usize = 4;
/// Watched ports looked at per refresh; more wait for the next one.
const MAX_WATCHED_CHECKS: usize = 20;
/// A port with no release is looked at again after this long.
const RELEASE_RECHECK_SECS: u64 = 24 * 3600;
/// A fork is listed only when people use it as a project of its own (SpartanPort is a fork of
/// shadPS4), not a personal copy.
const MIN_FORK_STARS: u64 = 20;
const MAX_AGE_SECS: u64 = 6 * 3600;
/// How often the searches by stars run again.
const POPULAR_AGE_SECS: u64 = 3 * 86400;
/// A port no search or list has shown for this long leaves the list.
const KEEP_UNSEEN_SECS: u64 = 90 * 86400;

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Item {
    /// GitHub "owner/name".
    pub repo: String,
    pub name: String,
    /// The game, when the list says it.
    #[serde(default)]
    pub game: String,
    /// Console or family ("Nintendo", "PlayStation", "Nintendo 64"...).
    #[serde(default)]
    pub console: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub stars: Option<u64>,
    /// Unix time of the last push, when known.
    #[serde(default)]
    pub pushed: Option<u64>,
    /// Unix time the repository was created, when known.
    #[serde(default)]
    pub created: Option<u64>,
    /// Unix time a search or the list last showed it.
    #[serde(default)]
    pub seen: u64,
    /// Marked ⭐ ("most user-friendly version") in the awesome list.
    #[serde(default)]
    pub recommended: bool,
    /// "lista", "tópico" and/or "busca".
    #[serde(default)]
    pub sources: Vec<String>,
    /// Some(false): no release yet, only code (Em andamento). None: not looked at yet.
    #[serde(default)]
    pub released: Option<bool>,
    /// The newest release's tag when last looked at.
    #[serde(default)]
    pub latest_tag: Option<String>,
    /// When the releases were last looked at.
    #[serde(default)]
    pub release_checked: u64,
}

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct Cache {
    pub fetched_at: u64,
    pub items: Vec<Item>,
    /// Sources that could not be read on the last refresh.
    #[serde(default)]
    pub errors: Vec<String>,
    /// Which set of searches made it: a list from an older set is searched again at once.
    #[serde(default)]
    pub searches: u32,
    /// When the searches by stars last ran to the end.
    #[serde(default)]
    pub popular_at: u64,
    /// Ports the player asked to hear about ("Avisar quando sair").
    #[serde(default)]
    pub watching: Vec<String>,
    /// What changed for those on the last refresh, said once (not saved).
    #[serde(skip)]
    pub news: Vec<String>,
}

/// Bumped when SEARCHES changes (2: forks and more topics, in 0.33; 3: searches by last update).
const SEARCHES_VERSION: u32 = 4;

pub fn valid_repo(repo: &str) -> bool {
    let mut parts = repo.split('/');
    let ok = |p: Option<&str>| {
        p.map(|s| !s.is_empty() && s.len() <= 100 && s != "." && s != ".." && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)))
            .unwrap_or(false)
    };
    ok(parts.next()) && ok(parts.next()) && parts.next().is_none()
}

/// Library id for a community port: "gh-owner-name".
pub fn id_for(repo: &str) -> String {
    let s: String = repo.to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    format!("gh-{}", s.chars().take(60).collect::<String>())
}

fn github_repo(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://github.com/").or_else(|| url.strip_prefix("http://github.com/"))?;
    let mut parts = rest.split(|c| c == '/' || c == '#' || c == '?');
    let repo = format!("{}/{}", parts.next()?, parts.next()?.trim_end_matches(".git"));
    valid_repo(&repo).then_some(repo)
}

/// The awesome list's README: "## 🎮 Nintendo", "<summary><strong>Game</strong>", "### ⭐ [Port](url)".
pub fn parse_awesome(md: &str) -> Vec<Item> {
    let mut items = Vec::new();
    let (mut section, mut game) = (String::new(), String::new());
    for line in md.lines() {
        let line = line.trim();
        if let Some(h) = line.strip_prefix("## ") {
            section = h.trim_start_matches(|c: char| !c.is_alphanumeric()).trim().to_string();
        } else if let Some(rest) = line.strip_prefix("<summary><strong>") {
            game = rest.split("</strong>").next().unwrap_or("").trim().to_string();
        } else if let Some(rest) = line.strip_prefix("### ") {
            let recommended = rest.starts_with('⭐');
            let rest = rest.trim_start_matches('⭐').trim();
            let Some(rest) = rest.strip_prefix('[') else { continue };
            let Some((name, tail)) = rest.split_once("](") else { continue };
            let url = tail.split(')').next().unwrap_or("");
            let Some(repo) = github_repo(url) else { continue };
            if section.eq_ignore_ascii_case("Utilities") {
                continue; // launchers and tools, not games
            }
            items.push(Item {
                repo,
                name: name.to_string(),
                game: game.clone(),
                console: section.clone(),
                recommended,
                sources: vec!["lista".into()],
                ..Default::default()
            });
        }
    }
    items
}

fn console_from_topics(topics: &[String]) -> String {
    const MAP: &[(&str, &str)] = &[
        ("n64", "Nintendo 64"),
        ("nintendo-64", "Nintendo 64"),
        ("gamecube", "GameCube"),
        ("wii", "Wii"),
        ("snes", "Super Nintendo"),
        ("gba", "Game Boy Advance"),
        ("nintendo-ds", "Nintendo DS"),
        ("ps1", "PlayStation"),
        ("psx", "PlayStation"),
        ("playstation", "PlayStation"),
        ("ps2", "PlayStation 2"),
        ("ps3", "PlayStation 3"),
        ("ps3recomp", "PlayStation 3"),
        ("playstation-3", "PlayStation 3"),
        ("ps4", "PlayStation 4"),
        ("playstation-4", "PlayStation 4"),
        ("playstation-2", "PlayStation 2"),
        ("ps2recomp", "PlayStation 2"),
        ("psp", "PSP"),
        ("xbox-360", "Xbox 360"),
        ("xbox360", "Xbox 360"),
        ("xenonrecomp", "Xbox 360"),
        ("rexglue", "Xbox 360"),
        ("xbox", "Xbox"),
        ("dreamcast", "Dreamcast"),
        ("saturn", "Saturn"),
        ("sega-genesis", "Mega Drive"),
    ];
    MAP.iter().find(|(t, _)| topics.iter().any(|x| x == t)).map(|(_, c)| c.to_string()).unwrap_or_default()
}

#[derive(Deserialize)]
struct SearchResult {
    items: Vec<SearchRepo>,
}

#[derive(Deserialize)]
struct SearchRepo {
    full_name: String,
    name: String,
    #[serde(default)]
    description: Option<String>,
    stargazers_count: u64,
    #[serde(default)]
    pushed_at: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    topics: Vec<String>,
    #[serde(default)]
    archived: bool,
    #[serde(default)]
    fork: bool,
}

/// What a description calls the work ("port of X", "recompilation of X").
const GAME_KEYS: &[&str] = &["port", "recompilation", "recomp", "decompilation", "decomp", "reimplementation", "remake", "rewrite"];
/// Words that end a game's title inside a sentence.
const TITLE_STOPS: &[&str] = &[
    " for windows", " for pc", " for linux", " for the ", " using ", " via ", " with ", " built ", " focused ", " running ",
    " from ", " powered ", " to native", " into ", " on pc", " on windows", " and its ", " as a ", " done ", " on n64", " for nintendo",
];
const TITLE_ENDS: &[&str] = &["(", "[", "{", ",", ";", ". ", "|", "—", "–", " - "];
/// Openings of a sentence, not of a title.
const SENTENCE_STARTS: &[&str] = &[
    "a ", "an ", "the original", "the game", "the xbox", "your ", "native ", "unofficial", "experimental", "pc ", "play ", "how ",
    "library", "shared", "advanced", "moved", "here ", "matching", "this ", "my ", "fully", "community", "official", "static", "rt64",
    "n64modernruntime", "definitive",
];

fn cut_title(text: &str) -> String {
    // ASCII lowercase keeps every byte where it was, so positions found in it fit `text`.
    let lower = text.to_ascii_lowercase();
    let mut end = text.len();
    for e in TITLE_ENDS {
        if let Some(i) = text.find(e) {
            end = end.min(i);
        }
    }
    for s in TITLE_STOPS {
        if let Some(i) = lower.find(s) {
            end = end.min(i);
        }
    }
    text[..end].trim_end().trim_end_matches(['.', ':']).trim().to_string()
}

fn plausible_title(name: &str) -> bool {
    let l = name.to_ascii_lowercase();
    let platform_word = l.split(|c: char| !c.is_ascii_alphanumeric()).any(|w| matches!(w, "windows" | "linux" | "macos"));
    (2..=50).contains(&name.chars().count())
        && name.chars().any(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
        && !SENTENCE_STARTS.iter().any(|b| l.starts_with(b))
        && !GAME_KEYS.iter().any(|k| l.ends_with(k))
        && !platform_word
}

/// The game a repository ports, from its description: "Native PC port (Linux/Windows) of
/// inFAMOUS Second Son (PS4)" gives "inFAMOUS Second Son", "Gears of War 2 native PC port: ..."
/// gives "Gears of War 2". Topic results have no game name, and a card that only says "iss_pc"
/// is found by no one. Empty when the description does not say.
pub fn guess_game(description: &str) -> String {
    let d = description.split(['|', '\n']).next().unwrap_or("");
    let lower = d.to_ascii_lowercase();
    // "... port of X", "recompilation of X" (in the same clause).
    for key in GAME_KEYS {
        let Some(k) = lower.find(key) else { continue };
        let Some(o) = lower[k..].find(" of ").map(|i| k + i) else { continue };
        if o - k > 40 || ["—", "–", " - "].iter().any(|x| d[k..o].contains(x)) {
            continue;
        }
        let mut name = cut_title(&d[o + 4..]);
        // "of the Xbox 360 version of Need for Speed": the game comes after the version.
        if let Some(v) = name.to_ascii_lowercase().find(" version of ") {
            name = name[v + 12..].trim().to_string();
        }
        if plausible_title(&name) {
            return name;
        }
    }
    // A title at the start: "Gears of War 2 native PC port", "Silent Hill: Downpour — ...".
    const WORDS: &[&str] = &[" native", " pc port", " port", " static", " running", " as a ", " recomp", " decomp", ": a ", " (", " —", " –", " - ", ". "];
    let mut end = d.len();
    for w in WORDS {
        if let Some(i) = lower.find(w) {
            if i > 0 && i < end {
                end = i;
            }
        }
    }
    let title = d[..end].trim_end().trim_end_matches(['.', ':']).trim();
    if plausible_title(title) {
        return title.to_string();
    }
    String::new()
}

/// A port for another machine (3DS, Vita, Switch...) that never mentions PC, Windows or Linux.
pub fn not_for_pc(description: &str) -> bool {
    let d = format!(" {} ", description.to_lowercase());
    const OTHER: &[&str] = &["3ds", "ps vita", "psvita", "nintendo switch", "wii u", "android port", "for android", "dreamcast port", "gba port", "iphone", "ipad", " ios", "macos"];
    const PC: &[&str] = &[" pc", "pc ", "windows", "linux", "desktop", "steam deck"];
    OTHER.iter().any(|o| d.contains(o)) && !PC.iter().any(|p| d.contains(p))
}

/// Why a search failed, and whether it was GitHub's limit (then the next ones are not tried).
struct SearchError {
    text: String,
    limit: bool,
}

/// The ports found and whether GitHub had a full page (so there may be another).
/// `sort`: "stars" or "updated".
async fn search_topic(topic: &str, sort: &str, page: u32) -> Result<(Vec<Item>, bool), SearchError> {
    search(&format!("topic:{topic}+fork:true+archived:false"), sort, page, "tópico").await
}

/// A word search: only ports, not the trackers and tools around them.
async fn search_words(query: &str, sort: &str) -> Result<Vec<Item>, SearchError> {
    let (items, _) = search(&format!("{query}+archived:false"), sort, 1, "busca").await?;
    Ok(items.into_iter().filter(|i| !looks_like_a_tool(&i.name, &i.description) && about_a_game(&i.name, &i.description, &i.console)).collect())
}

/// Words that say a project is about a game: a console, a big series, "recomp" in the name. A word
/// search also matches software ports ("native port of Redis"), which never say any of these.
const GAME_WORDS: &[&str] = &[
    "nintendo", "switch", "n64", "gamecube", "wii", "snes", "nes ", "game boy", "gba", "3ds", "playstation", "ps1", "ps2", "ps3",
    "ps4", "ps5", "psp", "vita", "xbox", "x360", "dreamcast", "saturn", "sega", "genesis", "mega drive", "arcade", "zelda", "mario",
    "pokemon", "pokémon", "sonic", "halo", "gta", "grand theft", "metroid", "kirby", "crash", "spyro", "god of war", " game",
];

pub fn about_a_game(name: &str, description: &str, console: &str) -> bool {
    let n = name.to_lowercase();
    let d = format!(" {} ", description.to_lowercase());
    !console.is_empty() || n.contains("recomp") || n.contains("decomp") || GAME_WORDS.iter().any(|w| d.contains(w))
}

/// Trackers, archives, launchers and tools found by the words of a port.
pub fn looks_like_a_tool(name: &str, description: &str) -> bool {
    let n = name.to_lowercase().replace(['-', '_'], " ");
    let d = description.to_lowercase();
    // Whole words only: "bot" is not "botw", "mirror" is not "mirrors".
    NOT_A_PORT.iter().any(|w| n.split_whitespace().any(|x| x == *w) || d.starts_with(&format!("{w} ")))
        || d.contains("tracker")
        || d.contains("progress of")
        || d.contains("port status")
}

async fn search(q: &str, sort: &str, page: u32, source: &str) -> Result<(Vec<Item>, bool), SearchError> {
    let url = format!("https://api.github.com/search/repositories?q={q}&sort={sort}&order=desc&per_page=100&page={page}");
    let resp = github::api(&url).send().await.map_err(|e| SearchError { text: e.to_string(), limit: false })?;
    if !resp.status().is_success() {
        let limit = matches!(resp.status().as_u16(), 403 | 429);
        return Err(SearchError { text: github::status_error(resp.status()), limit });
    }
    let r: SearchResult = resp.json().await.map_err(|e| SearchError { text: e.to_string(), limit: false })?;
    let full = r.items.len() >= 100;
    let items = r.items
        .into_iter()
        .filter(|i| !i.archived && (!i.fork || i.stargazers_count >= MIN_FORK_STARS) && valid_repo(&i.full_name))
        // Lists and toolkits are not games.
        .filter(|i| !i.topics.iter().any(|t| t.starts_with("awesome")) && !i.name.to_lowercase().contains("awesome"))
        .filter(|i| !not_for_pc(i.description.as_deref().unwrap_or("")))
        .map(|i| Item {
            game: guess_game(i.description.as_deref().unwrap_or("")),
            console: console_from_topics(&i.topics),
            repo: i.full_name,
            name: i.name,
            description: i.description.unwrap_or_default(),
            stars: Some(i.stargazers_count),
            pushed: i.pushed_at.as_deref().and_then(github::parse_time),
            created: i.created_at.as_deref().and_then(github::parse_time),
            sources: vec![source.into()],
            ..Default::default()
        })
        .collect();
    Ok((items, full))
}

/// Joins the list and the searches: one item per repository, the list's game names kept.
pub fn merge(list: Vec<Item>, found: Vec<Item>) -> Vec<Item> {
    let mut out: Vec<Item> = Vec::new();
    for item in list.into_iter().chain(found) {
        match out.iter_mut().find(|o| o.repo.eq_ignore_ascii_case(&item.repo)) {
            Some(o) => {
                for s in item.sources {
                    if !o.sources.contains(&s) {
                        o.sources.push(s);
                    }
                }
                o.stars = o.stars.or(item.stars);
                o.pushed = o.pushed.or(item.pushed);
                o.created = o.created.or(item.created);
                o.recommended |= item.recommended;
                if o.description.is_empty() {
                    o.description = item.description;
                }
                if o.console.is_empty() {
                    o.console = item.console;
                }
                if o.game.is_empty() {
                    o.game = item.game;
                }
            }
            None => out.push(item),
        }
    }
    out
}

/// The saved list. Lists saved by older versions get the game names and the PC filter too.
pub fn load(path: &Path) -> Cache {
    let mut cache: Cache = std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    cache.items.retain(|i| i.recommended || !i.sources.iter().all(|s| s == "tópico") || !not_for_pc(&i.description));
    for i in cache.items.iter_mut().filter(|i| i.game.is_empty()) {
        i.game = guess_game(&i.description);
    }
    cache
}

/// Puts what a refresh found into the saved list: known ports get the new numbers, new ones
/// come in, and those unseen for 90 days leave. `list_read`: the awesome list was read, so a
/// port only it had, and that it no longer has, leaves at once.
pub fn absorb(old: Vec<Item>, fresh: Vec<Item>, now: u64, list_read: bool) -> Vec<Item> {
    let mut out = old;
    for f in fresh {
        match out.iter_mut().find(|o| o.repo.eq_ignore_ascii_case(&f.repo)) {
            Some(o) => {
                let from_list = f.sources.iter().any(|s| s == "lista");
                for s in &f.sources {
                    if !o.sources.contains(s) {
                        o.sources.push(s.clone());
                    }
                }
                o.stars = f.stars.or(o.stars);
                o.pushed = o.pushed.max(f.pushed);
                o.created = f.created.or(o.created);
                if from_list {
                    o.recommended = f.recommended;
                }
                if !f.description.is_empty() {
                    o.description = f.description;
                }
                // The list's game and console names win over the guesses from a description.
                if !f.console.is_empty() && (o.console.is_empty() || from_list) {
                    o.console = f.console;
                }
                if !f.game.is_empty() && (o.game.is_empty() || from_list) {
                    o.game = f.game;
                }
                o.seen = now;
            }
            None => out.push(Item { seen: now, ..f }),
        }
    }
    out.retain(|o| {
        let only_list = o.sources.iter().all(|s| s == "lista");
        !(list_read && only_list && o.seen < now) && now.saturating_sub(o.seen) < KEEP_UNSEEN_SECS
    });
    out
}

/// The cached list, refreshed from GitHub when older than 6 hours (or `force`).
pub async fn refresh(path: &Path, force: bool) -> Cache {
    let mut old = load(path);
    let now = crate::library::now();
    if !force && !old.items.is_empty() && old.searches == SEARCHES_VERSION && now.saturating_sub(old.fetched_at) < MAX_AGE_SECS {
        return old;
    }
    // Lists saved before 0.53 came from the searches by stars and had no dates of their own.
    if old.searches < 3 {
        if !old.items.is_empty() {
            old.popular_at = old.fetched_at;
        }
        for i in old.items.iter_mut() {
            i.seen = old.fetched_at;
        }
    }
    let mut errors = Vec::new();
    let list = match github::client().get(LIST_URL).send().await {
        Ok(r) if r.status().is_success() => parse_awesome(&r.text().await.unwrap_or_default()),
        Ok(r) => {
            errors.push(format!("lista awesome-unofficial-pc-ports: {}", r.status()));
            Vec::new()
        }
        Err(e) => {
            errors.push(format!("lista awesome-unofficial-pc-ports: {e}"));
            Vec::new()
        }
    };
    let list_read = !list.is_empty();
    // Without a token only one kind of search fits in GitHub's minute: the popular ones every
    // 3 days, the recent ones the rest of the time.
    let popular_due = old.items.is_empty() || now.saturating_sub(old.popular_at) >= POPULAR_AGE_SECS;
    let mut kinds: Vec<&str> = Vec::new();
    if popular_due {
        kinds.push("stars");
    }
    if !popular_due || github::has_token() {
        kinds.push("updated");
    }
    let mut found = Vec::new();
    let mut popular_done = false;
    // The word searches first: they find the new ports, and without a token only about ten
    // searches fit in GitHub's minute.
    'words: for q in QUERIES {
        match search_words(q, "updated").await {
            Ok(items) => found.extend(items),
            Err(e) => {
                errors.push(format!("busca {q}: {}", e.text));
                if e.limit {
                    break 'words;
                }
            }
        }
    }
    'searches: for sort in kinds {
        let mut all_read = true;
        for (t, pages) in SEARCHES {
            let pages = if sort == "stars" { *pages } else { 1 };
            for page in 1..=pages {
                match search_topic(t, sort, page).await {
                    Ok((items, full)) => {
                        found.extend(items);
                        if !full {
                            break;
                        }
                    }
                    Err(e) => {
                        errors.push(format!("tópico {t}: {}", e.text));
                        all_read = false;
                        if e.limit {
                            break 'searches;
                        }
                        break;
                    }
                }
            }
        }
        popular_done |= sort == "stars" && all_read;
    }
    let fresh = merge(list, found);
    if fresh.is_empty() {
        // Offline or rate-limited: keep what we had.
        return Cache { errors, ..old };
    }
    let watching = old.watching.clone();
    let mut cache = Cache {
        fetched_at: now,
        items: absorb(old.items, fresh, now, list_read),
        errors,
        searches: SEARCHES_VERSION,
        popular_at: if popular_done { now } else { old.popular_at },
        watching,
        news: Vec::new(),
    };
    check_releases(&mut cache, now).await;
    // A port watched or let go while GitHub was being asked stays as the player left it.
    cache.watching = load(path).watching;
    save(path, &cache);
    cache
}

fn save(path: &Path, cache: &Cache) {
    let _guard = WRITING.lock().unwrap();
    if let Ok(text) = serde_json::to_string(cache) {
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, path);
        }
    }
}

static WRITING: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Which ports get their releases looked at now: every watched one, then the ones never looked
/// at (newest first) and those still without a release, as many as `budget`.
pub fn release_candidates(items: &[Item], watching: &[String], now: u64, budget: usize) -> Vec<String> {
    let watched = |r: &str| watching.iter().any(|w| w.eq_ignore_ascii_case(r));
    // The watched ones looked at longest ago first, at most MAX_WATCHED_CHECKS a time.
    let mut mine: Vec<&Item> = items.iter().filter(|i| watched(&i.repo)).collect();
    mine.sort_by_key(|i| i.release_checked);
    let mut out: Vec<String> = mine.into_iter().take(MAX_WATCHED_CHECKS).map(|i| i.repo.clone()).collect();
    let mut rest: Vec<&Item> = items
        .iter()
        .filter(|i| !watched(&i.repo))
        .filter(|i| i.released.is_none() || (i.released == Some(false) && now.saturating_sub(i.release_checked) >= RELEASE_RECHECK_SECS))
        .collect();
    rest.sort_by_key(|i| std::cmp::Reverse(i.created.unwrap_or(0)));
    out.extend(rest.into_iter().take(budget).map(|i| i.repo.clone()));
    out
}

/// What a watched port's news is, when its releases changed: the first one, or a new one.
pub fn release_news(name: &str, before: Option<&str>, was_released: Option<bool>, now_tag: Option<&str>) -> Option<String> {
    let tag = now_tag?;
    if was_released == Some(false) {
        return Some(format!("Saiu a primeira versão de {name}: {tag}."));
    }
    match before {
        Some(b) if b != tag => Some(format!("{name} tem versão nova: {tag}.")),
        _ => None,
    }
}

async fn check_releases(cache: &mut Cache, now: u64) {
    let budget = if github::has_token() { RELEASE_CHECKS_TOKEN } else { RELEASE_CHECKS };
    for repo in release_candidates(&cache.items, &cache.watching, now, budget) {
        let Ok(found) = latest_release(&repo).await else { continue };
        let watched = cache.watching.iter().any(|w| w.eq_ignore_ascii_case(&repo));
        let Some(item) = cache.items.iter_mut().find(|i| i.repo.eq_ignore_ascii_case(&repo)) else { continue };
        let tag = found.as_ref().map(|r| r.tag.clone());
        if watched {
            let name = if item.game.is_empty() { item.name.clone() } else { format!("{} ({})", item.name, item.game) };
            if let Some(n) = release_news(&name, item.latest_tag.as_deref(), item.released, tag.as_deref()) {
                cache.news.push(n);
            }
        }
        item.released = Some(found.is_some());
        item.latest_tag = tag;
        item.release_checked = now;
    }
}

/// "Avisar quando sair": the port is watched (or no longer). Returns the watched list.
pub fn set_watching(path: &Path, repo: &str, on: bool) -> Vec<String> {
    let mut cache = load(path);
    cache.watching.retain(|w| !w.eq_ignore_ascii_case(repo));
    if on && valid_repo(repo) {
        cache.watching.push(repo.to_string());
    }
    save(path, &cache);
    cache.watching
}

// ---- Releases of a community port ----

#[derive(Serialize, Clone)]
pub struct Asset {
    pub name: String,
    pub size: u64,
}

#[derive(Serialize, Clone)]
pub struct CommunityRelease {
    pub tag: String,
    pub published: u64,
    pub prerelease: bool,
    /// Files Black Flag can install (.zip, .7z, a portable .exe) that look like a Windows
    /// build, the most likely first.
    pub assets: Vec<Asset>,
    /// Windows installers (Setup .exe, .msi): Black Flag does not run them; the player installs
    /// from the project's page and adds the game as a PC game.
    #[serde(default)]
    pub installers: Vec<Asset>,
}

#[derive(Deserialize)]
struct ApiRelease {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    assets: Vec<ApiAsset>,
}

#[derive(Deserialize)]
struct ApiAsset {
    name: String,
    size: u64,
    browser_download_url: String,
    #[serde(default)]
    digest: Option<String>,
}

fn other_platform(n: &str) -> bool {
    const OTHER: &[&str] = &[
        "linux", "macos", "mac-", "-mac", "_mac", "osx", "darwin", "android", "apk", "appimage", "flatpak", "-ios", "_ios",
        "arm64", "aarch64", "source", "src.zip", "symbols", "pdb", "debuginfo", "switch", "vita", "web", "wasm", "steamdeck",
    ];
    OTHER.iter().any(|o| n.contains(o))
}

/// A Windows installer: Black Flag never runs one.
pub fn is_installer(name: &str) -> bool {
    let n = name.to_lowercase();
    !other_platform(&n) && (n.ends_with(".msi") || (n.ends_with(".exe") && (n.contains("setup") || n.contains("install"))))
}

/// 0 = clearly Windows, 1 = archive with no platform named, 2 = a portable .exe, None = another
/// platform, an installer or a file Black Flag cannot install.
pub fn windows_rank(name: &str) -> Option<u8> {
    let n = name.to_lowercase();
    if is_installer(&n) {
        return None;
    }
    if n.ends_with(".exe") {
        return (!other_platform(&n)).then_some(2);
    }
    if !n.ends_with(".zip") && !n.ends_with(".7z") {
        return None;
    }
    if other_platform(&n) {
        return None;
    }
    let win = ["win", "windows", "x64", "x86_64", "amd64"].iter().any(|w| n.contains(w));
    Some(if win { 0 } else { 1 })
}

async fn api_releases(repo: &str) -> Result<Vec<ApiRelease>, String> {
    if !valid_repo(repo) {
        return Err("Repositório inválido.".into());
    }
    let resp = github::api(&format!("https://api.github.com/repos/{repo}/releases?per_page=10"))
        .send()
        .await
        .map_err(|e| format!("Sem conexão com o GitHub ({e})"))?;
    if resp.status().as_u16() == 200 {
        resp.json().await.map_err(|e| e.to_string())
    } else {
        Err(github::status_error(resp.status()))
    }
}

/// The newest release with something for Windows (a stable one when there is any).
fn pick(releases: Vec<ApiRelease>) -> Option<ApiRelease> {
    let usable = |r: &ApiRelease| !r.draft && r.assets.iter().any(|a| windows_rank(&a.name).is_some() || is_installer(&a.name));
    let mut list: Vec<ApiRelease> = releases.into_iter().filter(usable).collect();
    let i = list.iter().position(|r| !r.prerelease).unwrap_or(0);
    (!list.is_empty()).then(|| list.swap_remove(i))
}

/// None: the project has published no release at all (only its code). A release with empty
/// `assets` and `installers` has files for other systems only.
pub async fn latest_release(repo: &str) -> Result<Option<CommunityRelease>, String> {
    let releases = api_releases(repo).await?;
    let newest = releases.iter().find(|r| !r.draft).map(|r| (r.tag_name.clone(), r.published_at.clone(), r.prerelease));
    let Some(r) = pick(releases) else {
        return Ok(newest.map(|(tag, published, prerelease)| CommunityRelease {
            tag,
            published: published.as_deref().and_then(github::parse_time).unwrap_or(0),
            prerelease,
            assets: Vec::new(),
            installers: Vec::new(),
        }));
    };
    let installers: Vec<Asset> = r.assets.iter().filter(|a| is_installer(&a.name)).map(|a| Asset { name: a.name.clone(), size: a.size }).collect();
    let mut assets: Vec<(u8, Asset)> = r
        .assets
        .iter()
        .filter_map(|a| windows_rank(&a.name).map(|rank| (rank, Asset { name: a.name.clone(), size: a.size })))
        .collect();
    assets.sort_by_key(|(rank, a)| (*rank, a.name.clone()));
    Ok(Some(CommunityRelease {
        tag: r.tag_name,
        published: r.published_at.as_deref().and_then(github::parse_time).unwrap_or(0),
        prerelease: r.prerelease,
        assets: assets.into_iter().map(|(_, a)| a).collect(),
        installers,
    }))
}

/// The download for `asset` of the newest release, looked up again on GitHub (never a
/// link from the page) and only from that repository's release files.
pub async fn release_for(repo: &str, asset: &str) -> Result<github::Release, String> {
    let r = pick(api_releases(repo).await?).ok_or("Este port não tem mais uma versão para Windows.")?;
    let a = r.assets.iter().find(|a| a.name == asset).ok_or("Esse arquivo não está mais na versão atual.")?;
    let prefix = format!("https://github.com/{repo}/releases/download/");
    if !a.browser_download_url.to_lowercase().starts_with(&prefix.to_lowercase()) || windows_rank(&a.name).is_none() {
        return Err("Endereço de download inesperado; a instalação foi cancelada.".into());
    }
    let sha_name = format!("{}.sha256", a.name);
    Ok(github::Release {
        tag: r.tag_name.clone(),
        published: r.published_at.as_deref().and_then(github::parse_time).unwrap_or(0),
        asset_url: a.browser_download_url.clone(),
        asset_size: a.size,
        sha256_url: r.assets.iter().find(|x| x.name == sha_name).map(|x| x.browser_download_url.clone()),
        sha256: github::sha256_of_digest(a.digest.as_deref()),
    })
}

/// Programs in an unpacked port that the Play button could start, most likely first.
pub fn find_executables(dir: &Path) -> Vec<String> {
    const SKIP: &[&str] = &[
        "unins", "setup", "vc_redist", "vcredist", "dxsetup", "crash", "updater", "update.exe", "uninstall", "dotnet",
        "redist", "7z", "launcher_helper",
    ];
    let mut found: Vec<(usize, String)> = Vec::new();
    fn walk(dir: &Path, rel: &str, depth: usize, found: &mut Vec<(usize, String)>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let path = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            let Ok(kind) = e.file_type() else { continue };
            if kind.is_dir() && depth < 2 {
                walk(&e.path(), &path, depth + 1, found);
            } else if kind.is_file() && name.to_lowercase().ends_with(".exe") {
                let lower = name.to_lowercase();
                if !SKIP.iter().any(|s| lower.contains(s)) {
                    found.push((depth, path));
                }
            }
        }
    }
    walk(dir, "", 0, &mut found);
    found.sort();
    found.into_iter().map(|(_, p)| p).collect()
}

/// A relative program path chosen in the page: inside the folder and an .exe.
pub fn valid_exe(dir: &Path, rel: &str) -> bool {
    let p = Path::new(rel);
    rel.to_lowercase().ends_with(".exe")
        && p.components().all(|c| matches!(c, std::path::Component::Normal(_)))
        && dir.join(p).is_file()
}

#[cfg(test)]
mod tests {

    #[test]
    fn game_names_from_descriptions() {
        assert_eq!(super::guess_game("Native PC port (Linux/Windows) of inFAMOUS Second Son (PS4, CUSA00223) — in development"), "inFAMOUS Second Son");
        assert_eq!(super::guess_game("Unofficial static recompilation of the Xbox 360 version of Need for Speed"), "Need for Speed");
        assert_eq!(super::guess_game("Gears of War 2 native PC port: the Xbox 360 game statically recompiled"), "Gears of War 2");
        assert_eq!(super::guess_game("A static recompilation of Condemned 2: Bloodshot done with RexGlue."), "Condemned 2: Bloodshot");
        assert_eq!(super::guess_game("Def Jam: Fight for NY PC port — static recompilation of the original Xbox game"), "Def Jam: Fight for NY");
        assert_eq!(super::guess_game("Library simplifying running N64 software to PC"), "");
        assert_eq!(super::guess_game("Silent Hill: Downpour — native Windows PC port via static recompilation"), "Silent Hill: Downpour");
        assert_eq!(super::guess_game("Native port of Metroid Prime (GameCube) for Linux, Windows and Android"), "Metroid Prime");
        assert_eq!(super::guess_game("A tool for modders"), "");
        assert!(super::not_for_pc("Native Nintendo 3DS port of The Legend of Zelda: The Minish Cap"));
        assert!(!super::not_for_pc("Native port of Metroid Prime (GameCube) for Linux, Windows and Android"));
        assert!(super::not_for_pc("Diablo II: Resurrected on iPhone, iPad, Apple silicon Mac, Android"));
    }
    use super::*;

    const SAMPLE: &str = "## 📚 Table of Contents\n\n## 🎮 Nintendo\n\n<details>\n<summary><strong>Banjo-Kazooie</strong></summary>\n\n### ⭐ [BanjoRecomp](https://github.com/BanjoRecomp/BanjoRecomp)\n\ntext\n\n### [Lighthouse](https://github.com/HarbourMasters/Lighthouse#readme)\n\n### [sm64plus](https://www.mfgg.net/x)\n\n## 🔧 Utilities\n\n<summary><strong>N64 Recomp Launcher</strong></summary>\n\n### [N64RecompLauncher](https://github.com/SirDiabo/N64RecompLauncher)\n";

    #[test]
    fn awesome_list_is_read() {
        let items = parse_awesome(SAMPLE);
        assert_eq!(items.len(), 2, "só repositórios do GitHub, sem utilitários");
        assert_eq!(items[0].repo, "BanjoRecomp/BanjoRecomp");
        assert_eq!(items[0].game, "Banjo-Kazooie");
        assert_eq!(items[0].console, "Nintendo");
        assert!(items[0].recommended);
        assert_eq!(items[1].repo, "HarbourMasters/Lighthouse");
        assert!(!items[1].recommended);
    }

    #[test]
    fn list_and_search_merge_by_repo() {
        let list = parse_awesome(SAMPLE);
        let found = vec![Item {
            repo: "banjorecomp/banjorecomp".into(),
            stars: Some(2000),
            description: "PC port".into(),
            sources: vec!["tópico".into()],
            ..Default::default()
        }];
        let merged = merge(list, found);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].stars, Some(2000));
        assert_eq!(merged[0].sources, vec!["lista", "tópico"]);
    }

    #[test]
    fn new_ports_join_and_old_ones_stay() {
        let day = 86400;
        let now = 200 * day;
        let item = |repo: &str, seen: u64, src: &str| Item { repo: repo.into(), seen, sources: vec![src.into()], ..Default::default() };
        let old = vec![
            Item { stars: Some(500), ..item("a/popular", now - 2 * day, "tópico") },
            item("a/quiet", now - 30 * day, "tópico"),
            item("a/gone", now - 91 * day, "tópico"),
            item("a/off-list", now - day, "lista"),
        ];
        let fresh = vec![
            Item { stars: Some(510), pushed: Some(now), ..item("A/Popular", 0, "tópico") },
            Item { created: Some(now - day), ..item("b/brand-new", 0, "tópico") },
        ];
        let out = absorb(old, fresh, now, true);
        let repos: Vec<&str> = out.iter().map(|i| i.repo.as_str()).collect();
        assert_eq!(repos, vec!["a/popular", "a/quiet", "b/brand-new"]);
        assert_eq!(out[0].stars, Some(510));
        assert_eq!(out[0].pushed, Some(now));
        assert_eq!(out[2].seen, now);
    }

    #[test]
    fn windows_zips_are_recognised() {
        assert_eq!(windows_rank("BanjoRecompiled-v1.0.2-Windows.zip"), Some(0));
        assert_eq!(windows_rank("game-x64.zip"), Some(0));
        assert_eq!(windows_rank("release.zip"), Some(1));
        assert_eq!(windows_rank("BanjoRecompiled-v1.0.2-Linux-X64.tar.gz"), None);
        assert_eq!(windows_rank("game-macos.zip"), None);
        assert_eq!(windows_rank("game-android.zip"), None);
        assert_eq!(windows_rank("Setup.exe"), None);
        assert_eq!(windows_rank("ProjectMidas-v1.0.1-windows.7z"), Some(0));
        assert_eq!(windows_rank("ProjectMidas-v1.0.1-steamdeck.7z"), None);
        assert_eq!(windows_rank("Decomp.Buddy.0.30.5.Portable.exe"), Some(2));
        assert!(is_installer("DefJamSetup-0.10.6-windows-x64.exe"));
        assert!(is_installer("OpenRAC.Launcher_0.8.4_x64_en-US.msi"));
        assert!(!is_installer("Decomp.Buddy.0.30.5.Portable.exe"));
    }

    #[test]
    fn repos_and_ids() {
        assert!(valid_repo("HarbourMasters/Shipwright"));
        assert!(!valid_repo("../etc"));
        assert!(!valid_repo("a/b/c"));
        assert!(!valid_repo("a/.."));
        assert_eq!(id_for("HarbourMasters/2ship2harkinian"), "gh-harbourmasters-2ship2harkinian");
        assert_eq!(github_repo("https://github.com/a/b.git#x").as_deref(), Some("a/b"));
        assert_eq!(github_repo("https://gitlab.com/a/b"), None);
    }
    #[test]
    fn word_searches_leave_out_trackers_and_tools() {
        assert!(looks_like_a_tool("gta6-pc-port-tracker", "Live tracker: the race to run GTA VI natively on PC"));
        assert!(looks_like_a_tool("GTA6-PC-Port-Archive", "Archive of Leonida, xcl and VIctory"));
        assert!(looks_like_a_tool("i95-GTA6-PC-Launcher", "open-source GTA VI PC launcher"));
        assert!(looks_like_a_tool("zelda-pc-port-icons", "Custom-made Windows desktop icons for Zelda PC ports."));
        assert!(!looks_like_a_tool("Hookshot", "Hookshot Is A Native PC Recompilation Of The Switch 2 Ocarina Of Time Remake"));
        assert!(!looks_like_a_tool("cool_fox", "cool_fox: Leading CGBJ runtime continuation for GTA VI PC"));
        assert!(!looks_like_a_tool("botw-pc-port", "Breath of the Wild native PC port"));
        assert!(!looks_like_a_tool("mirrors-edge-recomp", "Mirror's Edge recompilation"));
        assert!(!about_a_game("redis", "Redis for Windows: a native port of the in-memory data store", ""));
        assert!(about_a_game("cool_fox", "cool_fox: Leading CGBJ runtime continuation for GTA VI PC", ""));
        assert!(about_a_game("Hookshot", "Hookshot Is A Native PC Recompilation Of The Switch 2 Ocarina Of Time Remake", ""));
        assert!(!looks_like_a_tool("HeyListen", "A Native Recompilation for The Legend of Zelda Ocarina of Time Remake on Switch 2"));
    }

    #[test]
    fn watched_ports_are_looked_at_first_and_news_is_said_once() {
        let item = |repo: &str, released: Option<bool>, created: u64, checked: u64| Item {
            repo: repo.into(), name: repo.into(), released, created: Some(created), release_checked: checked, ..Default::default()
        };
        let items = vec![item("a/old", Some(true), 10, 0), item("a/new", None, 900, 0), item("a/wip", Some(false), 500, 0), item("a/watched", Some(false), 1, 999_990)];
        let picked = release_candidates(&items, &["a/watched".to_string()], 1_000_000, 1);
        assert_eq!(picked, vec!["a/watched".to_string(), "a/new".to_string()]);
        let picked = release_candidates(&items, &[], 1_000_000, 5);
        assert!(picked.contains(&"a/wip".to_string()) && !picked.contains(&"a/old".to_string()));
        assert_eq!(release_news("Leonida", None, Some(false), Some("v0.1")).as_deref(), Some("Saiu a primeira versão de Leonida: v0.1."));
        assert_eq!(release_news("Hookshot", Some("v3.0.1"), Some(true), Some("v3.0.2")).as_deref(), Some("Hookshot tem versão nova: v3.0.2."));
        assert_eq!(release_news("Hookshot", Some("v3.0.2"), Some(true), Some("v3.0.2")), None);
        assert_eq!(release_news("Novo", None, None, Some("v1")), None, "o primeiro olhar não é novidade");
        assert_eq!(release_news("Sem nada", None, Some(false), None), None);
    }

}
