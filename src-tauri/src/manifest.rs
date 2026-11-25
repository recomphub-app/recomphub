//! Ports that describe themselves.
//!
//! Many recomps ship a `recomplauncher.json` at the top of their release: a public format, with a
//! schema at recomplauncher.com, written for launchers. It says which program to start and with
//! what, what copy of the game the player has to give, where the game keeps its saves and what its
//! exit codes mean. Black Flag reads the parts it can use. This is our own reader of that file
//! (no code of RecompLauncher, which is GPL); a file that does not fit is ignored as a whole.
//!
//! What is read: `inputs` (and the older `game`), `start`, `saves`, `exit_codes`. The rest
//! (`config`, `settings`, `prepare`, `dumps`, `games`, `mods`) is not used yet.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

pub const FILE: &str = "recomplauncher.json";
/// A bigger file is not a launcher file.
const MAX_BYTES: u64 = 512 * 1024;
/// Variables a game cannot set: they would change how Windows finds programs.
const SYSTEM_VARS: &[&str] = &[
    "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    "PROGRAMFILES", "PROGRAMDATA", "HOMEDRIVE", "HOMEPATH", "SYSTEMDRIVE", "PSMODULEPATH",
];

// ---- The file as written ----

#[derive(Deserialize, Default, Clone, Debug)]
struct Raw {
    #[serde(default)]
    inputs: Vec<RawInput>,
    /// The older way to write the copy (read as the input `game`).
    #[serde(default)]
    game: Option<RawInput>,
    #[serde(default)]
    start: Option<RawStart>,
    #[serde(default)]
    saves: Vec<String>,
    #[serde(default)]
    exit_codes: BTreeMap<String, String>,
    #[serde(default)]
    settings: Vec<serde_json::Value>,
    #[serde(default)]
    prepare: Option<serde_json::Value>,
}

#[derive(Deserialize, Default, Clone, Debug)]
struct RawInput {
    #[serde(default)]
    id: String,
    #[serde(default)]
    label: String,
    #[serde(default)]
    role: String,
    #[serde(default)]
    optional: bool,
    #[serde(default)]
    formats: Vec<RawFormat>,
    #[serde(default)]
    check: Option<RawCheck>,
    /// The older `game` object says file or folder here.
    #[serde(default)]
    kind: String,
}

#[derive(Deserialize, Default, Clone, Debug)]
struct RawFormat {
    #[serde(default, rename = "type")]
    kind: String,
    #[serde(default)]
    extensions: Vec<String>,
}

#[derive(Deserialize, Default, Clone, Debug)]
struct RawCheck {
    #[serde(default)]
    file: Option<String>,
    #[serde(default)]
    ids: Vec<String>,
    #[serde(default)]
    iso9660: Option<String>,
    #[serde(default)]
    xdvdfs: Option<String>,
}

#[derive(Deserialize, Default, Clone, Debug)]
struct RawStart {
    #[serde(default)]
    program: OneOrMany,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
}

#[derive(Deserialize, Default, Clone, Debug)]
#[serde(untagged)]
enum OneOrMany {
    One(String),
    Many(Vec<String>),
    #[default]
    None,
}

// ---- What Black Flag uses ----

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Input {
    pub id: String,
    pub label: String,
    pub optional: bool,
    pub file: bool,
    pub folder: bool,
    /// Lower case, without the dot; empty: any.
    pub extensions: Vec<String>,
    /// A file that must be inside a folder copy.
    pub must_have: Option<String>,
    /// The file also says how to tell the right game (disc serials, title IDs) and Black Flag does
    /// not check that.
    pub unchecked: bool,
}

#[derive(Clone, Debug, Default)]
pub struct Manifest {
    pub inputs: Vec<Input>,
    pub programs: Vec<String>,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub saves: Vec<String>,
    pub exit_codes: Vec<(i64, String)>,
    pub has_settings: bool,
    pub has_prepare: bool,
}

/// What the game page says about the file.
#[derive(Serialize, Clone, Debug)]
pub struct Support {
    /// Where the file is, or None when the port has none.
    pub file: Option<String>,
    /// The file is there but could not be read.
    pub broken: bool,
    pub start: bool,
    pub inputs: Vec<Input>,
    pub saves: usize,
    pub exit_codes: usize,
    /// Parts of the file Black Flag does not use yet.
    pub unused: Vec<&'static str>,
}

/// The file, at the top of the game's folder or beside its program.
pub fn locate(install: &Path, exe: Option<&str>) -> Option<PathBuf> {
    let top = install.join(FILE);
    if top.is_file() {
        return Some(top);
    }
    let beside = exe.and_then(|e| install.join(e).parent().map(|p| p.join(FILE)))?;
    beside.is_file().then_some(beside)
}

pub fn read(path: &Path) -> Result<Manifest, String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_BYTES {
        return Err("arquivo grande demais".into());
    }
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    parse(text.trim_start_matches('\u{feff}'))
}

pub fn parse(text: &str) -> Result<Manifest, String> {
    let raw: Raw = serde_json::from_str(text).map_err(|e| format!("não é um recomplauncher.json válido ({e})"))?;
    let mut inputs: Vec<Input> = Vec::new();
    let mut all = raw.inputs.clone();
    if let Some(mut g) = raw.game.clone() {
        if !all.iter().any(|i| i.id == "game") {
            g.id = "game".into();
            if g.formats.is_empty() {
                g.formats = vec![RawFormat { kind: if g.kind == "folder" { "folder".into() } else { "file".into() }, extensions: vec![] }];
            }
            all.insert(0, g);
        }
    }
    for i in all {
        let id = if i.id.is_empty() && (i.role.is_empty() || i.role == "game") { "game".to_string() } else { i.id.clone() };
        if !valid_id(&id) || inputs.iter().any(|x| x.id == id) {
            continue;
        }
        let file = i.formats.is_empty() || i.formats.iter().any(|f| f.kind != "folder");
        let folder = i.formats.iter().any(|f| f.kind == "folder");
        let extensions = i
            .formats
            .iter()
            .flat_map(|f| f.extensions.iter())
            .map(|e| e.trim_start_matches('.').to_lowercase())
            .filter(|e| !e.is_empty() && e.chars().all(|c| c.is_ascii_alphanumeric()))
            .collect();
        let check = i.check.clone().unwrap_or_default();
        let must_have = check.file.clone().filter(|f| safe_relative(f));
        let unchecked = !check.ids.is_empty() || check.iso9660.is_some() || check.xdvdfs.is_some();
        inputs.push(Input {
            label: if i.label.trim().is_empty() { "A sua cópia do jogo".into() } else { i.label.trim().chars().take(300).collect() },
            id,
            optional: i.optional,
            file,
            folder,
            extensions,
            must_have,
            unchecked,
        });
    }
    let (programs, args, env) = match raw.start {
        Some(s) => {
            let programs = match s.program {
                OneOrMany::One(p) => vec![p],
                OneOrMany::Many(v) => v,
                OneOrMany::None => vec![],
            };
            let programs: Vec<String> = programs.into_iter().filter(|p| safe_relative(p) && p.to_lowercase().ends_with(".exe")).collect();
            let env = s
                .env
                .into_iter()
                .filter(|(k, _)| crate::play::valid_env_name(k) && !SYSTEM_VARS.contains(&k.to_uppercase().as_str()) && !k.to_uppercase().starts_with("RECOMPLAUNCHER"))
                .collect();
            (programs, s.args.into_iter().take(64).collect(), env)
        }
        None => (vec![], vec![], vec![]),
    };
    let exit_codes = raw
        .exit_codes
        .into_iter()
        .filter_map(|(k, v)| Some((k.trim().parse::<i64>().ok()?, v.trim().chars().take(400).collect::<String>())))
        .filter(|(_, v)| !v.is_empty())
        .collect();
    Ok(Manifest {
        inputs,
        programs,
        args,
        env,
        saves: raw.saves.into_iter().take(16).collect(),
        exit_codes,
        has_settings: !raw.settings.is_empty(),
        has_prepare: raw.prepare.is_some(),
    })
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 40 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// A path inside the game's folder: relative, no `..`, no drive.
pub fn safe_relative(p: &str) -> bool {
    let path = Path::new(p);
    !p.trim().is_empty() && path.components().all(|c| matches!(c, Component::Normal(_) | Component::CurDir))
}

impl Manifest {
    pub fn support(path: Option<&Path>, read: Option<&Result<Manifest, String>>) -> Support {
        let file = path.map(|p| p.display().to_string());
        match read {
            Some(Ok(m)) => {
                let mut unused = Vec::new();
                if m.has_settings {
                    unused.push("ajustes do jogo");
                }
                if m.has_prepare {
                    unused.push("passo de preparo");
                }
                Support {
                    file,
                    broken: false,
                    start: !m.programs.is_empty(),
                    inputs: m.inputs.clone(),
                    saves: m.saves.len(),
                    exit_codes: m.exit_codes.len(),
                    unused,
                }
            }
            Some(Err(_)) => Support { file, broken: true, start: false, inputs: vec![], saves: 0, exit_codes: 0, unused: vec![] },
            None => Support { file: None, broken: false, start: false, inputs: vec![], saves: 0, exit_codes: 0, unused: vec![] },
        }
    }

    /// The first program of `start` that is in the folder.
    pub fn program(&self, install: &Path) -> Option<String> {
        self.programs.iter().find(|p| install.join(p).is_file()).cloned()
    }

    /// Inputs the game cannot start without, still to be picked.
    pub fn missing<'a>(&'a self, picked: &BTreeMap<String, String>) -> Vec<&'a Input> {
        self.inputs.iter().filter(|i| !i.optional && picked.get(&i.id).map(|p| !Path::new(p).exists()).unwrap_or(true)).collect()
    }

    /// The message the port gives for this exit code: Some("ok") for a normal quit.
    pub fn exit_message(&self, code: u32) -> Option<&str> {
        let signed = code as i32 as i64;
        let plain = code as i64;
        self.exit_codes.iter().find(|(c, _)| *c == signed || *c == plain).map(|(_, m)| m.as_str())
    }
}

// ---- Places ----

/// What `{…}` turns into for one game.
pub struct Places<'a> {
    pub install: &'a Path,
    pub picked: &'a BTreeMap<String, String>,
    pub pad: &'a str,
}

impl Places<'_> {
    pub fn data(&self) -> PathBuf {
        self.install.join("recompdata")
    }

    fn known(&self, name: &str) -> Option<String> {
        let env = |v: &str| std::env::var(v).ok().filter(|s| !s.is_empty());
        match name {
            "install" => Some(self.install.display().to_string()),
            "data" => Some(self.data().display().to_string()),
            "documents" => env("USERPROFILE").map(|h| format!("{h}\\Documents")),
            "local" => env("LOCALAPPDATA"),
            "config" => env("APPDATA"),
            "home" => env("USERPROFILE"),
            "pad" => Some(self.pad.to_string()),
            _ => name.strip_prefix("input:").and_then(|id| self.picked.get(id)).cloned(),
        }
    }

    /// Fills in every `{…}`; None when one of them is unknown (an input not picked).
    pub fn fill(&self, text: &str) -> Option<String> {
        let mut out = String::new();
        let mut rest = text;
        while let Some(open) = rest.find('{') {
            out.push_str(&rest[..open]);
            let close = rest[open..].find('}')? + open;
            out.push_str(&self.known(&rest[open + 1..close])?);
            rest = &rest[close + 1..];
        }
        out.push_str(rest);
        Some(out)
    }
}

/// Save folders the file names, made safe for the backup and the sync (which put a whole folder
/// back): never the game's folder itself, a drive or one of the user's base folders, and never
/// outside the game's folder and the user's own folders. Labelled by position (`rl-1`…), so a
/// later release that moves a folder keeps the same label. Files and `*` patterns are left out.
pub fn save_folders(m: &Manifest, places: &Places) -> Vec<(String, PathBuf)> {
    let env = |v: &str| std::env::var(v).ok().filter(|s| !s.is_empty()).map(PathBuf::from);
    let home = env("USERPROFILE");
    let bases: Vec<PathBuf> = [Some(places.install.to_path_buf()), home.clone(), env("APPDATA"), env("LOCALAPPDATA"), home.as_ref().map(|h| h.join("Documents"))]
        .into_iter()
        .flatten()
        .collect();
    let norm = |p: &Path| p.to_string_lossy().trim_end_matches(['\\', '/']).to_lowercase().replace('/', "\\");
    let mut out = Vec::new();
    for (i, raw) in m.saves.iter().enumerate() {
        if raw.contains('*') || raw.contains("..") {
            continue;
        }
        let Some(filled) = places.fill(raw) else { continue };
        let path = PathBuf::from(&filled);
        if !path.is_absolute() || path.parent().is_none() || path.is_file() {
            continue;
        }
        let p = norm(&path);
        let inside = |b: &PathBuf| p.starts_with(&format!("{}\\", norm(b)));
        let is_base = bases.iter().any(|b| norm(b) == p);
        let under_known = inside(&places.install.to_path_buf()) || home.as_ref().map(inside).unwrap_or(false);
        // The data folder's cache is never a save.
        if is_base || !under_known || p.ends_with("\\cache") {
            continue;
        }
        // A link or junction inside the game's folder may lead elsewhere: the real place must
        // still be under the game's folder or the user's own.
        if path.exists() {
            let real = std::fs::canonicalize(&path).ok();
            let roots: Vec<PathBuf> =
                [Some(places.install.to_path_buf()), home.clone()].into_iter().flatten().filter_map(|r| std::fs::canonicalize(r).ok()).collect();
            if !real.map(|r| roots.iter().any(|root| r.starts_with(root) && r != *root)).unwrap_or(false) {
                continue;
            }
        }
        out.push((format!("rl-{}", i + 1), path));
    }
    out
}

/// The program's arguments: each `{…}` filled in; an argument naming an input that was not picked
/// (an optional one) is left out whole.
pub fn start_args(m: &Manifest, places: &Places) -> Vec<String> {
    m.args.iter().filter_map(|a| places.fill(a)).collect()
}

/// A copy the player picked: Ok, or why it does not fit the input.
pub fn check_pick(input: &Input, path: &Path) -> Result<(), String> {
    if path.is_dir() {
        if !input.folder {
            return Err("Aqui vai um arquivo, não uma pasta.".into());
        }
        if let Some(f) = &input.must_have {
            if !path.join(f).exists() {
                return Err(format!("Esta pasta não tem o arquivo {f}. Escolha a pasta do jogo."));
            }
        }
        return Ok(());
    }
    if !path.is_file() {
        return Err("Não encontrei esse arquivo.".into());
    }
    if !input.file {
        return Err("Aqui vai a pasta do jogo, não um arquivo.".into());
    }
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if !input.extensions.is_empty() && !input.extensions.contains(&ext) {
        return Err(format!("O port pede um arquivo {}.", input.extensions.iter().map(|e| format!(".{e}")).collect::<Vec<_>>().join(", ")));
    }
    Ok(())
}

/// The variables every game started from its file gets, so it knows a launcher set it up:
/// `RECOMPLAUNCHER_MODE` (bigpicture in Modo TV), `RECOMPLAUNCHER_PAD` and the data folder.
/// `RECOMPLAUNCHER_VERSION` is left out on purpose: it is that launcher's version, not ours.
pub fn protocol_env(places: &Places, tv: bool) -> Vec<(String, String)> {
    let mut v = vec![
        ("RECOMPLAUNCHER".to_string(), "1".to_string()),
        ("RECOMPLAUNCHER_MODE".to_string(), if tv { "bigpicture" } else { "desktop" }.to_string()),
        ("RECOMPLAUNCHER_DATA".to_string(), places.data().display().to_string()),
        ("BLACKFLAG_VERSION".to_string(), env!("CARGO_PKG_VERSION").to_string()),
    ];
    if places.pad == "xbox" || places.pad == "playstation" {
        v.push(("RECOMPLAUNCHER_PAD".to_string(), places.pad.to_string()));
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
      "$schema": "https://recomplauncher.com/schema/recomplauncher.json",
      "format": 1,
      "inputs": [
        { "id": "game", "label": "Your disc image (.iso) of the USA release.", "formats": [{ "type": "file", "extensions": ["iso", ".CHD"] }], "check": { "iso9660": "SLUS_206.51" } },
        { "id": "dlc1", "label": "DLC", "role": "dlc", "optional": true, "formats": [{ "type": "file" }] },
        { "id": "../bad", "label": "x" }
      ],
      "start": { "program": ["bin/game.exe", "game.exe", "../evil.exe", "C:\\Windows\\x.exe"], "args": ["--iso", "{input:game}", "--dlc1={input:dlc1}", "--data", "{data}"],
                 "env": { "MYGAME_DATA": "{documents}/My Game", "PATH": "x", "RECOMPLAUNCHER_MODE": "x", "bad name": "x" } },
      "saves": ["{data}/saves", "{install}", "{home}/*.sav", "{data}/cache"],
      "exit_codes": { "252968961": "It couldn't find your copy.", "1": "ok", "-1": "Bad", "x": "no" },
      "settings": [{ "id": "res" }],
      "somethingNew": { "ignored": true }
    }"#;

    #[test]
    fn reads_what_it_can_use_and_drops_what_is_unsafe() {
        let m = parse(SAMPLE).unwrap();
        assert_eq!(m.inputs.len(), 2, "o input com caminho estranho sai");
        assert_eq!(m.inputs[0].extensions, vec!["iso", "chd"]);
        assert!(m.inputs[0].unchecked && !m.inputs[0].optional && m.inputs[0].file && !m.inputs[0].folder);
        assert_eq!(m.programs, vec!["bin/game.exe", "game.exe"], "nada fora da pasta do jogo");
        assert_eq!(m.env, vec![("MYGAME_DATA".to_string(), "{documents}/My Game".to_string())]);
        assert_eq!(m.exit_message(252968961), Some("It couldn't find your copy."));
        assert_eq!(m.exit_message(1), Some("ok"));
        assert_eq!(m.exit_message(u32::MAX), Some("Bad"), "-1 do Windows chega como 0xFFFFFFFF");
        assert!(m.has_settings && !m.has_prepare);
        assert!(parse("[1,2]").is_err());
        assert!(parse(r#"{ "start": { "program": "game.exe" } }"#).unwrap().programs == vec!["game.exe"]);
    }

    #[test]
    fn the_older_game_field_is_the_input_game() {
        let m = parse(r#"{ "game": { "kind": "folder", "label": "Your PS4 folder", "check": { "file": "eboot.bin" } } }"#).unwrap();
        assert_eq!(m.inputs.len(), 1);
        assert_eq!(m.inputs[0].id, "game");
        assert!(m.inputs[0].folder && !m.inputs[0].file);
        assert_eq!(m.inputs[0].must_have.as_deref(), Some("eboot.bin"));
    }

    #[test]
    fn arguments_with_an_input_not_picked_are_left_out() {
        let m = parse(SAMPLE).unwrap();
        let install = std::env::temp_dir().join("bf-manifest-args");
        let mut picked = BTreeMap::new();
        picked.insert("game".to_string(), "D:\\Jogos\\game.iso".to_string());
        let places = Places { install: &install, picked: &picked, pad: "xbox" };
        let args = start_args(&m, &places);
        assert_eq!(args[0], "--iso");
        assert_eq!(args[1], "D:\\Jogos\\game.iso");
        assert!(!args.iter().any(|a| a.starts_with("--dlc1")), "DLC não escolhido sai inteiro");
        assert!(args.last().unwrap().ends_with("recompdata"));
        assert_eq!(m.missing(&BTreeMap::new()).len(), 1, "só o jogo é obrigatório");
        let env = protocol_env(&places, true);
        assert!(env.contains(&("RECOMPLAUNCHER_MODE".to_string(), "bigpicture".to_string())));
        assert!(env.contains(&("RECOMPLAUNCHER_PAD".to_string(), "xbox".to_string())));
        assert!(!env.iter().any(|(k, _)| k == "RECOMPLAUNCHER_VERSION"));
    }

    #[test]
    fn save_folders_never_take_the_whole_game_or_a_base_folder() {
        let m = parse(SAMPLE).unwrap();
        let install = std::env::temp_dir().join("bf-manifest-saves").join("game");
        let picked = BTreeMap::new();
        let places = Places { install: &install, picked: &picked, pad: "" };
        let folders = save_folders(&m, &places);
        assert_eq!(folders.len(), 1, "{folders:?}");
        assert_eq!(folders[0].0, "rl-1");
        assert!(folders[0].1.ends_with("recompdata/saves") || folders[0].1.ends_with("recompdata\\saves"));
        let home = parse(r#"{ "saves": ["{home}", "{config}", "C:\\", "{local}/My Game/saves"] }"#).unwrap();
        let f = save_folders(&home, &places);
        assert_eq!(f.len(), 1, "{f:?}");
        assert_eq!(f[0].0, "rl-4", "o rótulo segue a posição no arquivo");
    }

    #[test]
    fn a_pick_must_fit_the_input() {
        let dir = std::env::temp_dir().join(format!("bf-manifest-pick-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("ps4")).unwrap();
        std::fs::write(dir.join("game.iso"), b"x").unwrap();
        std::fs::write(dir.join("game.zip"), b"x").unwrap();
        let m = parse(SAMPLE).unwrap();
        assert!(check_pick(&m.inputs[0], &dir.join("game.iso")).is_ok());
        assert!(check_pick(&m.inputs[0], &dir.join("game.zip")).is_err());
        assert!(check_pick(&m.inputs[0], &dir.join("ps4")).is_err());
        let ps4 = parse(r#"{ "inputs": [{ "id": "game", "formats": [{ "type": "folder" }], "check": { "file": "eboot.bin" } }] }"#).unwrap();
        assert!(check_pick(&ps4.inputs[0], &dir.join("ps4")).is_err());
        std::fs::write(dir.join("ps4").join("eboot.bin"), b"x").unwrap();
        assert!(check_pick(&ps4.inputs[0], &dir.join("ps4")).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
