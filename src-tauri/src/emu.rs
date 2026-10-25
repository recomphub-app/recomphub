//! Emuladores: the consoles Black Flag knows, the emulators that play them, where each one is
//! downloaded from (only the project's own pages), how it opens a game, and what the player
//! must bring (BIOS, firmware, keys), which Black Flag only looks for and never downloads.
//!
//! Two levels, decided with Codex (Desktop\calude\emuladores-consenso.md): a "completo"
//! emulator is installed by Black Flag in a folder of its own, in the emulator's documented
//! portable mode, and prepared before its first use (BIOS folder, controller on player 1, the
//! first-run assistant marked done with the key the assistant itself writes); a "básico" one
//! is installed or found and opened, and its needs are explained. An emulator the player
//! already had is never written to: it only gets arguments for each run.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use crate::github::{self, Release};

// ---- Consoles ----

/// What a console asks of the player, beyond the game.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Needs {
    Nothing,
    /// A PlayStation BIOS (512 KB), dumped from the player's console.
    Ps1Bios,
    /// A PlayStation 2 BIOS (4 MB, with "ROMVER" inside).
    Ps2Bios,
    /// The PS3 system software (PS3UPDAT.PUP), installed inside RPCS3.
    Ps3Firmware,
    /// MCPX boot ROM, flash BIOS and a hard disk image for xemu.
    XboxFiles,
    /// keys.txt, only for encrypted Wii U discs (WUD/WUX).
    WiiUKeys,
    /// prod.keys and firmware, kept by Ryujinx itself.
    SwitchKeys,
}

pub struct System {
    pub id: &'static str,
    pub name: &'static str,
    /// Extensions of its game files (lowercase, with the dot).
    pub extensions: &'static [&'static str],
    /// Emulators that play it, best first.
    pub emulators: &'static [&'static str],
    pub needs: Needs,
}

pub const SYSTEMS: &[System] = &[
    System { id: "ps1", name: "PlayStation", extensions: &[".cue", ".chd", ".pbp", ".m3u", ".iso"], emulators: &["duckstation"], needs: Needs::Ps1Bios },
    System { id: "ps2", name: "PlayStation 2", extensions: &[".iso", ".chd", ".cso", ".zso", ".gz", ".cue"], emulators: &["pcsx2"], needs: Needs::Ps2Bios },
    System { id: "ps3", name: "PlayStation 3", extensions: &[".iso"], emulators: &["rpcs3"], needs: Needs::Ps3Firmware },
    System { id: "ps4", name: "PlayStation 4", extensions: &[], emulators: &["shadps4"], needs: Needs::Nothing },
    System { id: "psp", name: "PSP", extensions: &[".iso", ".cso", ".pbp", ".chd"], emulators: &["ppsspp"], needs: Needs::Nothing },
    System { id: "gc", name: "GameCube", extensions: &[".rvz", ".gcm", ".iso", ".gcz", ".ciso", ".wia"], emulators: &["dolphin"], needs: Needs::Nothing },
    System { id: "wii", name: "Wii", extensions: &[".wbfs", ".rvz", ".iso", ".wia", ".wad", ".gcz", ".ciso"], emulators: &["dolphin"], needs: Needs::Nothing },
    System { id: "wiiu", name: "Wii U", extensions: &[".wua", ".wud", ".wux", ".rpx"], emulators: &["cemu"], needs: Needs::WiiUKeys },
    System { id: "switch", name: "Nintendo Switch", extensions: &[".nsp", ".xci"], emulators: &["ryujinx"], needs: Needs::SwitchKeys },
    System { id: "xbox", name: "Xbox", extensions: &[".iso"], emulators: &["xemu"], needs: Needs::XboxFiles },
    System { id: "x360", name: "Xbox 360", extensions: &[".iso", ".xex", ".zar"], emulators: &["xenia"], needs: Needs::Nothing },
    System { id: "n64", name: "Nintendo 64", extensions: &[".n64", ".z64", ".v64"], emulators: &["rmg", "ares"], needs: Needs::Nothing },
    System { id: "nes", name: "NES", extensions: &[".nes"], emulators: &["ares"], needs: Needs::Nothing },
    System { id: "snes", name: "Super Nintendo", extensions: &[".sfc", ".smc"], emulators: &["ares"], needs: Needs::Nothing },
    System { id: "gb", name: "Game Boy", extensions: &[".gb"], emulators: &["mgba", "ares"], needs: Needs::Nothing },
    System { id: "gbc", name: "Game Boy Color", extensions: &[".gbc"], emulators: &["mgba", "ares"], needs: Needs::Nothing },
    System { id: "gba", name: "Game Boy Advance", extensions: &[".gba"], emulators: &["mgba"], needs: Needs::Nothing },
    System { id: "nds", name: "Nintendo DS", extensions: &[".nds", ".dsi"], emulators: &["melonds"], needs: Needs::Nothing },
    System { id: "3ds", name: "Nintendo 3DS", extensions: &[".3ds", ".cci", ".cxi", ".3dsx", ".z3ds"], emulators: &["azahar"], needs: Needs::Nothing },
    System { id: "md", name: "Mega Drive", extensions: &[".md", ".gen", ".smd"], emulators: &["ares"], needs: Needs::Nothing },
    System { id: "sms", name: "Master System", extensions: &[".sms"], emulators: &["ares"], needs: Needs::Nothing },
    System { id: "gg", name: "Game Gear", extensions: &[".gg"], emulators: &["ares"], needs: Needs::Nothing },
    System { id: "pce", name: "PC Engine", extensions: &[".pce"], emulators: &["ares"], needs: Needs::Nothing },
    System { id: "dc", name: "Dreamcast", extensions: &[".gdi", ".cdi", ".chd"], emulators: &["flycast"], needs: Needs::Nothing },
];

pub fn system(id: &str) -> Option<&'static System> {
    SYSTEMS.iter().find(|s| s.id == id)
}

// ---- Emulators ----

/// Where an emulator comes from. Only the project's own pages.
pub enum Source {
    /// The newest release on the project's GitHub page; the Windows file is the one whose name
    /// has every `must` piece and none of the `not` ones.
    GitHub { repo: &'static str, must: &'static [&'static str], not: &'static [&'static str] },
    /// Dolphin's own update service (dolphin-emu.org), which lists the Windows x64 build.
    Dolphin,
    /// Not downloaded by Black Flag: the player installs it from the official page.
    Manual,
}

pub struct Emulator {
    pub id: &'static str,
    pub name: &'static str,
    /// Prepared by Black Flag before its first use (nível completo).
    pub full: bool,
    pub source: Source,
    /// Its program; a name ending in '*' is a prefix (DuckStation's name carries the build).
    pub exes: &'static [&'static str],
    /// Files or folders (ending in '/') that turn on the emulator's own portable mode, as its
    /// code looks for them: portable.txt (PCSX2 QtHost, DuckStation qthost, Dolphin), portable.ini
    /// (mGBA mCoreConfigIsPortable), portable/ (Cemu), user/ (Azahar, shadPS4).
    pub portable: &'static [&'static str],
    /// The player's data inside the emulator's folder, kept by an update.
    pub keep: &'static [&'static str],
    /// The project's page, opened by "Página oficial".
    pub page: &'static str,
    /// How it is called in folder names and in Windows' list of programs.
    pub detect: &'static [&'static str],
}

pub const EMULATORS: &[Emulator] = &[
    Emulator {
        id: "duckstation", name: "DuckStation", full: true,
        source: Source::GitHub { repo: "stenzek/duckstation", must: &["windows-x64-release.zip"], not: &["sse2", "symbols", "arm64"] },
        exes: &["duckstation-qt*"], portable: &["portable.txt"],
        keep: &["portable.txt", "settings.ini", "bios/", "memcards/", "savestates/", "cache/", "covers/", "screenshots/", "gamesettings/", "inputprofiles/", "cheats/", "patches/", "shaders/", "textures/"],
        page: "https://github.com/stenzek/duckstation", detect: &["DuckStation"],
    },
    Emulator {
        id: "pcsx2", name: "PCSX2", full: true,
        source: Source::GitHub { repo: "PCSX2/pcsx2", must: &["windows-x64-Qt.7z"], not: &["symbols"] },
        exes: &["pcsx2-qt.exe", "pcsx2-qtx64-avx2.exe", "pcsx2-qtx64.exe"], portable: &["portable.txt"],
        keep: &["portable.txt", "inis/", "bios/", "memcards/", "sstates/", "cache/", "covers/", "cheats/", "patches/", "snaps/", "logs/", "gamesettings/", "inputprofiles/", "textures/", "videos/"],
        page: "https://pcsx2.net", detect: &["PCSX2"],
    },
    Emulator {
        id: "dolphin", name: "Dolphin", full: true, source: Source::Dolphin,
        exes: &["Dolphin.exe"], portable: &["portable.txt"], keep: &["portable.txt", "User/"],
        page: "https://dolphin-emu.org", detect: &["Dolphin", "Dolphin-x64"],
    },
    Emulator {
        id: "ppsspp", name: "PPSSPP", full: true,
        source: Source::GitHub { repo: "hrydgard/ppsspp", must: &["Windows-x64.zip"], not: &[] },
        exes: &["PPSSPPWindows64.exe"], portable: &[], keep: &["memstick/"],
        page: "https://www.ppsspp.org", detect: &["PPSSPP"],
    },
    Emulator {
        id: "mgba", name: "mGBA", full: true,
        source: Source::GitHub { repo: "mgba-emu/mgba", must: &["-win64.7z"], not: &["installer"] },
        exes: &["mGBA.exe"], portable: &["portable.ini"], keep: &["portable.ini", "config.ini", "qt.ini", "saves/", "states/", "screenshots/"],
        page: "https://mgba.io", detect: &["mGBA"],
    },
    Emulator {
        id: "melonds", name: "melonDS", full: false,
        source: Source::GitHub { repo: "melonDS-emu/melonDS", must: &["windows-x86_64.zip"], not: &[] },
        exes: &["melonDS.exe"], portable: &[], keep: &["melonDS.toml", "melonDS.ini", "bios7.bin", "bios9.bin", "firmware.bin"],
        page: "https://melonds.kuribo64.net", detect: &["melonDS"],
    },
    Emulator {
        id: "rmg", name: "Rosalie's Mupen GUI (RMG)", full: true,
        source: Source::GitHub { repo: "Rosalie241/RMG", must: &["Portable-Windows64", ".zip"], not: &[] },
        exes: &["RMG.exe"], portable: &[], keep: &["Config/", "Save/", "Screenshots/", "Data/"],
        page: "https://github.com/Rosalie241/RMG", detect: &["RMG", "Rosalie's Mupen GUI"],
    },
    Emulator {
        id: "rpcs3", name: "RPCS3", full: true,
        source: Source::GitHub { repo: "RPCS3/rpcs3-binaries-win", must: &["win64_msvc.7z"], not: &[".sha256"] },
        exes: &["rpcs3.exe"], portable: &[],
        keep: &["dev_flash/", "dev_hdd0/", "dev_hdd1/", "dev_usb000/", "config/", "cache/", "GuiConfigs/", "Icons/", "patches/", "savestates/", "captures/", "config.yml"],
        page: "https://rpcs3.net", detect: &["RPCS3"],
    },
    Emulator {
        id: "xemu", name: "xemu", full: true,
        source: Source::GitHub { repo: "xemu-project/xemu", must: &["xemu-win-x86_64-release.zip"], not: &[] },
        exes: &["xemu.exe"], portable: &[], keep: &["xemu.toml", "eeprom.bin"],
        page: "https://xemu.app", detect: &["xemu"],
    },
    Emulator {
        id: "cemu", name: "Cemu", full: false,
        source: Source::GitHub { repo: "cemu-project/Cemu", must: &["windows-x64.zip"], not: &[] },
        exes: &["Cemu.exe"], portable: &["portable/"], keep: &["portable/", "keys.txt", "settings.xml", "mlc01/", "gameProfiles/", "graphicPacks/", "shaderCache/"],
        page: "https://cemu.info", detect: &["Cemu"],
    },
    Emulator {
        id: "xenia", name: "Xenia Canary", full: false,
        source: Source::GitHub { repo: "xenia-canary/xenia-canary-releases", must: &["windows", ".zip"], not: &[] },
        exes: &["xenia_canary.exe"], portable: &[], keep: &["content/", "cache/", "config/", "xenia-canary.config.toml", "portable.txt"],
        page: "https://xenia.jp", detect: &["Xenia", "xenia_canary"],
    },
    Emulator {
        id: "azahar", name: "Azahar", full: false,
        source: Source::GitHub { repo: "azahar-emu/azahar", must: &["windows-msvc", ".zip"], not: &["installer", "libretro"] },
        exes: &["azahar.exe", "azahar-qt.exe"], portable: &["user/"], keep: &["user/"],
        page: "https://azahar-emu.org", detect: &["Azahar"],
    },
    Emulator {
        id: "flycast", name: "Flycast", full: false,
        source: Source::GitHub { repo: "flyinghead/flycast", must: &["win64", ".zip"], not: &[] },
        exes: &["flycast.exe"], portable: &[], keep: &["emu.cfg", "data/", "mappings/"],
        page: "https://github.com/flyinghead/flycast", detect: &["Flycast"],
    },
    Emulator {
        id: "shadps4", name: "shadPS4", full: false,
        source: Source::GitHub { repo: "shadps4-emu/shadPS4", must: &["win64", ".zip"], not: &["qt"] },
        exes: &["shadPS4.exe"], portable: &["user/"], keep: &["user/"],
        page: "https://shadps4.net", detect: &["shadPS4"],
    },
    Emulator {
        id: "ares", name: "ares", full: false,
        source: Source::GitHub { repo: "ares-emulator/ares", must: &["windows-x64.zip"], not: &["PDBs"] },
        exes: &["ares.exe"], portable: &[], keep: &["settings.bml", "Saves/"],
        page: "https://ares-emu.net", detect: &["ares"],
    },
    Emulator {
        id: "ryujinx", name: "Ryujinx", full: false, source: Source::Manual,
        exes: &["Ryujinx.exe"], portable: &[], keep: &[],
        page: "https://ryujinx.app", detect: &["Ryujinx", "Ryubing"],
    },
];

pub fn emulator(id: &str) -> Option<&'static Emulator> {
    EMULATORS.iter().find(|e| e.id == id)
}

/// The emulators' own pages, which "Página oficial" may open.
pub fn known_page(url: &str) -> bool {
    EMULATORS.iter().any(|e| e.page == url) || url == RYUJINX_DOWNLOAD
}

pub const RYUJINX_DOWNLOAD: &str = "https://ryujinx.app/download";

// ---- What Black Flag remembers (emulators.json) ----

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Installed {
    pub version: String,
    /// The emulator's folder (kept where it is if the player moves Black Flag's folder).
    pub dir: String,
    /// The program, relative to `dir`.
    pub exe: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct GameFolder {
    pub path: String,
    /// The console of every game in it; None: told apart file by file.
    #[serde(default)]
    pub system: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct State {
    /// Folder holding Emuladores, BIOS and Jogos; None: %USERPROFILE%\Black Flag.
    #[serde(default)]
    pub root: Option<String>,
    /// Emulators Black Flag installed, by id.
    #[serde(default)]
    pub installed: BTreeMap<String, Installed>,
    /// Emulators the player pointed at ("Já tenho"), by id: the program's full path.
    #[serde(default)]
    pub own: BTreeMap<String, String>,
    /// The emulator chosen for a console, when it has more than one.
    #[serde(default)]
    pub chosen: BTreeMap<String, String>,
    /// Games folders besides Jogos\<console>.
    #[serde(default)]
    pub folders: Vec<GameFolder>,
    /// Newest version seen on each emulator's page ("Procurar atualizações").
    #[serde(default)]
    pub latest: BTreeMap<String, String>,
    /// Where each emulator was last found on this PC, so a game opens without searching.
    #[serde(default)]
    pub detected: BTreeMap<String, String>,
}

impl State {
    pub fn load(path: &Path) -> Self {
        std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        let text = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, path).map_err(|e| e.to_string())
    }

    pub fn root(&self) -> PathBuf {
        match &self.root {
            Some(r) if !r.is_empty() => PathBuf::from(r),
            _ => default_root(),
        }
    }
}

/// Outside Documentos, which OneDrive may keep only in the cloud.
pub fn default_root() -> PathBuf {
    std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("C:\\")).join("Black Flag")
}

pub fn emulators_dir(root: &Path) -> PathBuf {
    root.join("Emuladores")
}

pub fn emulator_dir(root: &Path, id: &str) -> PathBuf {
    emulators_dir(root).join(id)
}

pub fn bios_dir(root: &Path, system: &str) -> PathBuf {
    root.join("BIOS").join(system)
}

pub fn games_dir(root: &Path, system: &str) -> PathBuf {
    root.join("Jogos").join(system)
}

/// Jogos\<console> for every console and BIOS\<console> for those that need something, each
/// BIOS folder with a note saying what goes in it. Existing folders and notes are left alone.
pub fn make_folders(root: &Path) -> Result<(), String> {
    for s in SYSTEMS {
        std::fs::create_dir_all(games_dir(root, s.id)).map_err(|e| format!("Não consegui criar as pastas em {}: {e}", root.display()))?;
        if s.needs != Needs::Nothing && s.needs != Needs::SwitchKeys {
            let dir = bios_dir(root, s.id);
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let note = dir.join("O que colocar aqui.txt");
            if !note.exists() {
                let _ = std::fs::write(&note, bios_note(s.needs).replace('\n', "\r\n"));
            }
        }
    }
    std::fs::create_dir_all(emulators_dir(root)).map_err(|e| e.to_string())
}

fn bios_note(needs: Needs) -> &'static str {
    match needs {
        Needs::Ps1Bios => "Coloque aqui a BIOS do PlayStation tirada do seu console (um arquivo de 512 KB, como SCPH-1001.bin ou scph5501.bin).\nO Black Flag nunca baixa BIOS: ela precisa vir do seu console.\n",
        Needs::Ps2Bios => "Coloque aqui a BIOS do PlayStation 2 tirada do seu console (um arquivo de 4 MB, como SCPH-70012.bin).\nO Black Flag nunca baixa BIOS: ela precisa vir do seu console.\n",
        Needs::Ps3Firmware => "Coloque aqui o PS3UPDAT.PUP, o arquivo oficial de atualização do sistema do PS3 (no site da PlayStation).\nO Black Flag mostra um botão para instalar no RPCS3.\n",
        Needs::XboxFiles => "Coloque aqui os arquivos do seu Xbox:\n- a boot ROM do MCPX (512 bytes, como mcpx_1.0.bin);\n- a BIOS (flash) de 256 KB ou 1 MB;\n- a imagem do disco rígido (.qcow2).\nO Black Flag nunca baixa esses arquivos.\n",
        Needs::WiiUKeys => "Só para discos criptografados (.wud ou .wux): coloque aqui o keys.txt com as chaves do seu console.\nJogos em .wua ou já descriptografados não precisam de nada.\n",
        Needs::Nothing | Needs::SwitchKeys => "",
    }
}

// ---- Finding an emulator ----

/// An emulator on this PC and how Black Flag knows of it.
#[derive(Clone, Serialize, Debug)]
pub struct Found {
    pub exe: PathBuf,
    /// Installed by Black Flag (its folder is Black Flag's, and may be prepared).
    pub managed: bool,
    /// "pointed": chosen by the player; "detected": found in a usual place.
    pub how: &'static str,
    pub version: Option<String>,
}

fn name_matches(file: &str, pattern: &str) -> bool {
    let f = file.to_lowercase();
    match pattern.strip_suffix('*') {
        Some(prefix) => f.starts_with(&prefix.to_lowercase()) && f.ends_with(".exe"),
        None => f == pattern.to_lowercase(),
    }
}

/// Whether a program's file name is this emulator's.
pub fn is_program(emu: &Emulator, file: &str) -> bool {
    emu.exes.iter().any(|p| name_matches(file, p))
}

/// The emulator's program inside `dir`, looking a few folders down (archives often wrap
/// everything in one folder).
pub fn find_exe(dir: &Path, emu: &Emulator) -> Option<PathBuf> {
    let mut level = vec![dir.to_path_buf()];
    for _ in 0..3 {
        let mut next = Vec::new();
        for d in &level {
            let Ok(list) = std::fs::read_dir(d) else { continue };
            let mut entries: Vec<_> = list.flatten().collect();
            entries.sort_by_key(|e| e.file_name());
            for pattern in emu.exes {
                if let Some(e) = entries.iter().find(|e| e.path().is_file() && name_matches(&e.file_name().to_string_lossy(), pattern)) {
                    return Some(e.path());
                }
            }
            next.extend(entries.iter().filter(|e| e.path().is_dir()).map(|e| e.path()));
        }
        level = next;
    }
    None
}

/// Folders Windows' list of installed programs gives for each name (DisplayName contains it).
pub fn installed_programs() -> Vec<(String, PathBuf)> {
    use crate::reg::{self, Root};
    const KEYS: &[&str] = &[
        r"Software\Microsoft\Windows\CurrentVersion\Uninstall",
        r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
    ];
    let mut out = Vec::new();
    for (root, key) in [(0, KEYS[0]), (1, KEYS[0]), (1, KEYS[1])] {
        let r = || if root == 0 { Root::User } else { Root::Machine };
        for sub in reg::subkeys(r(), key) {
            let path = format!(r"{key}\{sub}");
            let Some(name) = reg::get_string(r(), &path, "DisplayName") else { continue };
            let dir = reg::get_string(r(), &path, "InstallLocation")
                .filter(|d| !d.trim().is_empty())
                .map(|d| PathBuf::from(d.trim().trim_matches('"')))
                .or_else(|| {
                    reg::get_string(r(), &path, "DisplayIcon")
                        .map(|i| i.split(',').next().unwrap_or("").trim().trim_matches('"').to_string())
                        .and_then(|i| Path::new(&i).parent().map(Path::to_path_buf))
                });
            if let Some(dir) = dir {
                out.push((name.to_lowercase(), dir));
            }
        }
    }
    out
}

/// The usual places an emulator lands when the player installs it: Program Files, the
/// user's Programs folder, Scoop, and what Windows' list of programs says.
fn usual_places(emu: &Emulator, programs: &[(String, PathBuf)]) -> Vec<PathBuf> {
    let env = |v: &str| std::env::var_os(v).map(PathBuf::from);
    let mut bases: Vec<PathBuf> = Vec::new();
    for name in emu.detect {
        for base in [env("ProgramFiles"), env("ProgramFiles(x86)"), env("LOCALAPPDATA").map(|p| p.join("Programs"))].into_iter().flatten() {
            bases.push(base.join(name));
        }
        if let Some(home) = env("USERPROFILE") {
            bases.push(home.join("scoop").join("apps").join(name.to_lowercase()).join("current"));
        }
        let lower = name.to_lowercase();
        bases.extend(programs.iter().filter(|(n, _)| n.contains(&lower)).map(|(_, d)| d.clone()));
    }
    bases
}

/// Where the emulator is: installed by Black Flag, pointed at by the player, or found.
pub fn locate(state: &State, emu: &Emulator, programs: &[(String, PathBuf)]) -> Option<Found> {
    if let Some(i) = state.installed.get(emu.id) {
        let exe = Path::new(&i.dir).join(&i.exe);
        if exe.is_file() {
            return Some(Found { exe, managed: true, how: "installed", version: Some(i.version.clone()) });
        }
    }
    if let Some(p) = state.own.get(emu.id) {
        let exe = PathBuf::from(p);
        if exe.is_file() {
            return Some(Found { exe, managed: false, how: "pointed", version: None });
        }
    }
    if let Some(p) = state.detected.get(emu.id) {
        let exe = PathBuf::from(p);
        if exe.is_file() {
            return Some(Found { exe, managed: false, how: "detected", version: None });
        }
    }
    usual_places(emu, programs)
        .iter()
        .filter(|d| d.is_dir())
        .find_map(|d| find_exe(d, emu))
        .map(|exe| Found { exe, managed: false, how: "detected", version: None })
}

/// The emulator a console uses: the one the player chose, else the first one on this PC,
/// else the first one Black Flag can install.
pub fn pick(state: &State, system: &System, programs: &[(String, PathBuf)]) -> (&'static Emulator, Option<Found>) {
    let options: Vec<&'static Emulator> = system.emulators.iter().filter_map(|id| emulator(id)).collect();
    if let Some(chosen) = state.chosen.get(system.id).and_then(|id| options.iter().find(|e| e.id == id)) {
        return (chosen, locate(state, chosen, programs));
    }
    for e in &options {
        if let Some(f) = locate(state, e, programs) {
            return (e, Some(f));
        }
    }
    (options[0], None)
}

// ---- Downloading ----

#[derive(Deserialize)]
struct ApiRelease {
    tag_name: String,
    #[serde(default)]
    draft: bool,
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
}

#[derive(Deserialize)]
struct DolphinLatest {
    shortrev: String,
    #[serde(default)]
    artifacts: Vec<DolphinArtifact>,
}

#[derive(Deserialize)]
struct DolphinArtifact {
    system: String,
    url: String,
}

const DOLPHIN_LATEST: &str = "https://dolphin-emu.org/update/latest/beta/";

pub fn asset_matches(name: &str, must: &[&str], not: &[&str]) -> bool {
    let n = name.to_lowercase();
    must.iter().all(|m| n.contains(&m.to_lowercase())) && !not.iter().any(|x| n.contains(&x.to_lowercase()))
}

/// The newest Windows build on the emulator's official page.
pub async fn latest(emu: &Emulator) -> Result<Release, String> {
    match &emu.source {
        Source::GitHub { repo, must, not } => {
            let url = format!("https://api.github.com/repos/{repo}/releases?per_page=6");
            let resp = github::api(&url).send().await.map_err(|e| format!("Sem conexão com o GitHub ({e})"))?;
            if !resp.status().is_success() {
                return Err(github::status_error(resp.status()));
            }
            let list: Vec<ApiRelease> = resp.json().await.map_err(|e| e.to_string())?;
            for r in list.into_iter().filter(|r| !r.draft) {
                let Some(asset) = r.assets.iter().find(|a| asset_matches(&a.name, must, not)) else { continue };
                let sha_name = format!("{}.sha256", asset.name);
                return Ok(Release {
                    tag: r.tag_name.clone(),
                    published: r.published_at.as_deref().and_then(github::parse_time).unwrap_or(0),
                    asset_url: asset.browser_download_url.clone(),
                    asset_size: asset.size,
                    sha256_url: r.assets.iter().find(|a| a.name == sha_name).map(|a| a.browser_download_url.clone()),
                });
            }
            Err(format!("A página do {} no GitHub não tem uma versão para Windows agora.", emu.name))
        }
        Source::Dolphin => {
            let resp = github::client().get(DOLPHIN_LATEST).send().await.map_err(|e| format!("Sem conexão com o site do Dolphin ({e})"))?;
            if !resp.status().is_success() {
                return Err(format!("O site do Dolphin respondeu {}.", resp.status()));
            }
            let d: DolphinLatest = resp.json().await.map_err(|e| e.to_string())?;
            let a = d
                .artifacts
                .iter()
                .find(|a| a.system == "Windows x64" && a.url.starts_with("https://dl.dolphin-emu.org/") && a.url.ends_with(".7z"))
                .ok_or("O site do Dolphin não listou a versão para Windows.")?;
            Ok(Release { tag: d.shortrev, published: 0, asset_url: a.url.clone(), asset_size: 0, sha256_url: None })
        }
        Source::Manual => Err(format!("O Black Flag não baixa o {}: instale pela página oficial e use \"Já tenho\".", emu.name)),
    }
}

/// After unpacking: the emulator's own portable switch, so its data stays in its folder and
/// nothing of a copy the player may have elsewhere is touched.
pub fn make_portable(dir: &Path, emu: &Emulator) -> Result<(), String> {
    let base = find_exe(dir, emu).and_then(|e| e.parent().map(Path::to_path_buf)).unwrap_or_else(|| dir.to_path_buf());
    for p in emu.portable {
        let path = base.join(p.trim_end_matches('/'));
        let made = if p.ends_with('/') { std::fs::create_dir_all(&path) } else if path.exists() { Ok(()) } else { std::fs::write(&path, "") };
        made.map_err(|e| format!("Não consegui ligar o modo portable do {}: {e}", emu.name))?;
    }
    Ok(())
}

// ---- Preparing an emulator Black Flag installed ----

/// Sets `key = value` in `[section]` of an INI text, keeping everything else (comments,
/// other keys, order). Keys and sections compare without case, as the emulators read them.
pub fn ini_set(text: &str, section: &str, key: &str, value: &str) -> String {
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    let header = |l: &str| l.trim().strip_prefix('[').and_then(|r| r.strip_suffix(']')).map(|s| s.trim().to_string());
    let start = lines.iter().position(|l| header(l).map(|h| h.eq_ignore_ascii_case(section)).unwrap_or(false));
    let new_line = format!("{key} = {value}");
    match start {
        None => {
            if lines.last().map(|l| !l.trim().is_empty()).unwrap_or(false) {
                lines.push(String::new());
            }
            lines.push(format!("[{section}]"));
            lines.push(new_line);
        }
        Some(s) => {
            let end = lines[s + 1..].iter().position(|l| header(l).is_some()).map(|p| s + 1 + p).unwrap_or(lines.len());
            let found = (s + 1..end).find(|&i| {
                let l = lines[i].trim();
                !l.starts_with(';') && !l.starts_with('#') && l.split('=').next().map(|k| k.trim().eq_ignore_ascii_case(key)).unwrap_or(false)
            });
            match found {
                Some(i) => lines[i] = new_line,
                None => {
                    // After the section's last non-empty line.
                    let mut at = end;
                    while at > s + 1 && lines[at - 1].trim().is_empty() {
                        at -= 1;
                    }
                    lines.insert(at, new_line);
                }
            }
        }
    }
    let mut out = lines.join("\n");
    out.push('\n');
    out
}

fn write_keys(path: &Path, keys: &[(&str, &str, String)]) -> Result<(), String> {
    let mut text = std::fs::read_to_string(path).unwrap_or_default();
    if path.exists() {
        // One copy of how it was before Black Flag first touched it.
        let backup = path.with_extension("antes-do-black-flag");
        if !backup.exists() {
            let _ = std::fs::copy(path, &backup);
        }
    }
    for (section, key, value) in keys {
        text = ini_set(&text, section, key, value);
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, text).map_err(|e| format!("Não consegui gravar {}: {e}", path.display()))
}

/// Player 1 on the first controller, with the names DuckStation and PCSX2 use for SDL pads
/// (read from their code: SDLInputSource and the controllers' binding lists).
fn sony_pad(motor: bool) -> Vec<(&'static str, &'static str, String)> {
    let mut keys: Vec<(&str, &str, String)> = [
        ("Up", "DPadUp"), ("Right", "DPadRight"), ("Down", "DPadDown"), ("Left", "DPadLeft"),
        ("Triangle", "Y"), ("Circle", "B"), ("Cross", "A"), ("Square", "X"),
        ("Select", "Back"), ("Start", "Start"), ("L1", "LeftShoulder"), ("R1", "RightShoulder"),
        ("L2", "+LeftTrigger"), ("R2", "+RightTrigger"), ("L3", "LeftStick"), ("R3", "RightStick"),
        ("LLeft", "-LeftX"), ("LRight", "+LeftX"), ("LUp", "-LeftY"), ("LDown", "+LeftY"),
        ("RLeft", "-RightX"), ("RRight", "+RightX"), ("RUp", "-RightY"), ("RDown", "+RightY"),
    ]
    .iter()
    .map(|(k, v)| ("Pad1", *k, format!("SDL-0/{v}")))
    .collect();
    if motor {
        keys.push(("Pad1", "LargeMotor", "SDL-0/LargeMotor".into()));
        keys.push(("Pad1", "SmallMotor", "SDL-0/SmallMotor".into()));
    }
    keys
}

/// The program's folder (portable data lives next to it).
fn base_of(exe: &Path) -> PathBuf {
    exe.parent().map(Path::to_path_buf).unwrap_or_default()
}

/// Gets an emulator Black Flag installed ready before a game: the BIOS folder every time
/// (the player may move Black Flag's folder), and on the first run the controller and the
/// first-run assistant. Only when the emulator's portable switch is on, so the settings
/// written are the ones it reads, inside its own folder.
pub fn prepare(emu: &Emulator, exe: &Path, root: &Path) -> Result<(), String> {
    let base = base_of(exe);
    let portable_on = emu.portable.iter().all(|p| base.join(p.trim_end_matches('/')).exists());
    if !portable_on {
        return Ok(());
    }
    let path_text = |p: PathBuf| p.display().to_string();
    match emu.id {
        "pcsx2" => {
            let ini = base.join("inis").join("PCSX2.ini");
            let first = !ini.exists();
            let mut keys = vec![("Folders", "Bios", path_text(bios_dir(root, "ps2")))];
            if first {
                // SettingsVersion as PCSX2 checks it (VMManager::Internal::CheckSettingsVersion),
                // else it offers to reset everything.
                keys.extend([
                    ("UI", "SettingsVersion", "1".to_string()),
                    ("UI", "SetupWizardIncomplete", "false".into()),
                    ("UI", "ConfirmShutdown", "false".into()),
                    ("InputSources", "SDL", "true".into()),
                    ("Pad1", "Type", "DualShock2".into()),
                    ("Hotkeys", "OpenPauseMenu", "Keyboard/Escape".into()),
                    ("Hotkeys", "ToggleFullscreen", "Keyboard/Alt & Keyboard/Return".into()),
                ]);
                keys.extend(sony_pad(true));
            }
            write_keys(&ini, &keys)
        }
        "duckstation" => {
            let ini = base.join("settings.ini");
            let first = !ini.exists();
            let mut keys = vec![("BIOS", "SearchDirectory", path_text(bios_dir(root, "ps1")))];
            if first {
                keys.extend([
                    ("Main", "SetupWizardIncomplete", "false".to_string()),
                    ("Main", "ConfirmPowerOff", "false".into()),
                    ("InputSources", "SDL", "true".into()),
                    ("Pad1", "Type", "AnalogController".into()),
                    ("Hotkeys", "OpenPauseMenu", "Keyboard/Escape".into()),
                ]);
                keys.extend(sony_pad(true));
            }
            write_keys(&ini, &keys)
        }
        "dolphin" => {
            let config = base.join("User").join("Config");
            if !config.join("Dolphin.ini").exists() {
                write_keys(
                    &config.join("Dolphin.ini"),
                    &[
                        ("Analytics", "PermissionAsked", "True".into()),
                        ("Analytics", "Enabled", "False".into()),
                        ("Interface", "ConfirmStop", "False".into()),
                    ],
                )?;
            }
            if !config.join("GCPadNew.ini").exists() {
                write_keys(&config.join("GCPadNew.ini"), &dolphin_gc_pad())?;
            }
            if !config.join("WiimoteNew.ini").exists() {
                write_keys(&config.join("WiimoteNew.ini"), &dolphin_wiimote())?;
            }
            Ok(())
        }
        "xemu" => xemu_files(&base.join("xemu.toml"), &bios_dir(root, "xbox")),
        // PPSSPP, mGBA, RMG and RPCS3 already use the first controller out of the box, ask for no
        // BIOS, and have no first-run assistant; PPSSPP and RPCS3 keep their data next to the
        // program by default. Nothing to write.
        _ => Ok(()),
    }
}

/// Dolphin's GameCube pad on the first XInput controller, with Dolphin's names for it.
fn dolphin_gc_pad() -> Vec<(&'static str, &'static str, String)> {
    [
        ("Device", "XInput/0/Gamepad"),
        ("Buttons/A", "`Button A`"), ("Buttons/B", "`Button B`"), ("Buttons/X", "`Button X`"), ("Buttons/Y", "`Button Y`"),
        ("Buttons/Z", "`Shoulder R`"), ("Buttons/Start", "Start"),
        ("Main Stick/Up", "`Left Y+`"), ("Main Stick/Down", "`Left Y-`"), ("Main Stick/Left", "`Left X-`"), ("Main Stick/Right", "`Left X+`"),
        ("C-Stick/Up", "`Right Y+`"), ("C-Stick/Down", "`Right Y-`"), ("C-Stick/Left", "`Right X-`"), ("C-Stick/Right", "`Right X+`"),
        ("Triggers/L", "`Trigger L`"), ("Triggers/R", "`Trigger R`"), ("Triggers/L-Analog", "`Trigger L`"), ("Triggers/R-Analog", "`Trigger R`"),
        ("D-Pad/Up", "`Pad N`"), ("D-Pad/Down", "`Pad S`"), ("D-Pad/Left", "`Pad W`"), ("D-Pad/Right", "`Pad E`"),
        ("Rumble/Motor", "`Motor L` | `Motor R`"),
    ]
    .iter()
    .map(|(k, v)| ("GCPad1", *k, v.to_string()))
    .collect()
}

/// An emulated Wii Remote with a Nunchuk, on the first XInput controller; the right stick aims.
fn dolphin_wiimote() -> Vec<(&'static str, &'static str, String)> {
    [
        ("Source", "1"), ("Device", "XInput/0/Gamepad"), ("Extension", "Nunchuk"),
        ("Buttons/A", "`Button A`"), ("Buttons/B", "`Trigger R`"), ("Buttons/1", "`Button X`"), ("Buttons/2", "`Button Y`"),
        ("Buttons/-", "Back"), ("Buttons/+", "Start"), ("Buttons/Home", "`Thumb R`"),
        ("D-Pad/Up", "`Pad N`"), ("D-Pad/Down", "`Pad S`"), ("D-Pad/Left", "`Pad W`"), ("D-Pad/Right", "`Pad E`"),
        ("IR/Up", "`Right Y+`"), ("IR/Down", "`Right Y-`"), ("IR/Left", "`Right X-`"), ("IR/Right", "`Right X+`"),
        ("Shake/X", "`Thumb L`"), ("Shake/Y", "`Thumb L`"), ("Shake/Z", "`Thumb L`"),
        ("Nunchuk/Buttons/C", "`Shoulder L`"), ("Nunchuk/Buttons/Z", "`Trigger L`"),
        ("Nunchuk/Stick/Up", "`Left Y+`"), ("Nunchuk/Stick/Down", "`Left Y-`"), ("Nunchuk/Stick/Left", "`Left X-`"), ("Nunchuk/Stick/Right", "`Left X+`"),
        ("Rumble/Motor", "`Motor L` | `Motor R`"),
    ]
    .iter()
    .map(|(k, v)| ("Wiimote1", *k, v.to_string()))
    .collect()
}

/// xemu.toml's [sys.files], pointed at the player's files in BIOS\xbox. xemu writes its toml
/// when it closes, so this runs only before a game, never while it is open.
fn xemu_files(toml: &Path, dir: &Path) -> Result<(), String> {
    let files = xbox_files(dir);
    let mut text = std::fs::read_to_string(toml).unwrap_or_default();
    if text.trim().is_empty() {
        text = "[general]\nshow_welcome = false\n".into();
    }
    let quote = |p: &Path| format!("'{}'", p.display());
    for (key, file) in [("bootrom_path", &files.bootrom), ("flashrom_path", &files.flash), ("hdd_path", &files.hdd)] {
        if let Some(f) = file {
            text = ini_set(&text, "sys.files", key, &quote(f));
        }
    }
    std::fs::write(toml, text).map_err(|e| format!("Não consegui gravar {}: {e}", toml.display()))
}

// ---- What the player must bring ----

#[derive(Default)]
pub struct XboxFiles {
    pub bootrom: Option<PathBuf>,
    pub flash: Option<PathBuf>,
    pub hdd: Option<PathBuf>,
}

fn files_in(dir: &Path) -> Vec<(PathBuf, u64)> {
    std::fs::read_dir(dir)
        .map(|l| {
            l.flatten()
                .filter_map(|e| {
                    let m = e.metadata().ok()?;
                    m.is_file().then(|| (e.path(), m.len()))
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn xbox_files(dir: &Path) -> XboxFiles {
    let mut f = XboxFiles::default();
    for (path, size) in files_in(dir) {
        let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        if ext == "qcow2" {
            f.hdd.get_or_insert(path);
        } else if size == 512 {
            f.bootrom.get_or_insert(path);
        } else if size == 262_144 || size == 1_048_576 {
            f.flash.get_or_insert(path);
        }
    }
    f
}

/// A file that looks like a PS1 BIOS: 512 KB with Sony's name near the start.
fn looks_ps1_bios(path: &Path, size: u64) -> bool {
    if size != 524_288 {
        return false;
    }
    let mut buf = Vec::new();
    std::fs::File::open(path).and_then(|f| f.take(4096).read_to_end(&mut buf)).is_ok()
        && buf.windows(27).any(|w| w == b"Sony Computer Entertainment")
}

/// A file that looks like a PS2 BIOS: 4 to 8 MB with "ROMVER" in it (as PCSX2 tells them).
fn looks_ps2_bios(path: &Path, size: u64) -> bool {
    if !(4 * 1024 * 1024..=8 * 1024 * 1024).contains(&size) {
        return false;
    }
    let mut buf = Vec::new();
    std::fs::File::open(path).and_then(|f| f.take(size).read_to_end(&mut buf)).is_ok() && buf.windows(6).any(|w| w == b"ROMVER")
}

fn rpcs3_firmware(exe: &Path) -> bool {
    base_of(exe).join("dev_flash").join("vsh").join("module").join("vsh.self").is_file()
}

/// A PS3 system update the player put in BIOS\ps3 (it starts with "SCEUF").
pub fn ps3_pup(dir: &Path) -> Option<PathBuf> {
    files_in(dir).into_iter().map(|(p, _)| p).find(|p| {
        p.extension().map(|e| e.eq_ignore_ascii_case("pup")).unwrap_or(false)
            && std::fs::File::open(p).ok().and_then(|mut f| {
                let mut magic = [0u8; 5];
                f.read_exact(&mut magic).ok().map(|_| &magic == b"SCEUF")
            }) == Some(true)
    })
}

/// Whether a console's needs are met, in the player's words.
#[derive(Serialize, Clone, Debug)]
pub struct NeedStatus {
    /// Something is asked of the player at all.
    pub asks: bool,
    pub ok: bool,
    /// Without it the game does not open (a "completo" emulator Black Flag prepared).
    pub blocks: bool,
    pub text: String,
    /// The folder where the player puts the files.
    pub folder: Option<String>,
    /// A button that solves it: "install-firmware".
    pub action: Option<&'static str>,
}

pub fn needs_status(system: &System, root: &Path, found: Option<&Found>) -> NeedStatus {
    let dir = bios_dir(root, system.id);
    let folder = Some(dir.display().to_string());
    let managed = found.map(|f| f.managed).unwrap_or(true);
    let st = |ok: bool, blocks: bool, text: String| NeedStatus { asks: true, ok, blocks: blocks && !ok, text, folder: folder.clone(), action: None };
    match system.needs {
        Needs::Nothing => NeedStatus { asks: false, ok: true, blocks: false, text: String::new(), folder: None, action: None },
        Needs::Ps1Bios => {
            let file = files_in(&dir).into_iter().find(|(p, s)| looks_ps1_bios(p, *s)).map(|(p, _)| p);
            match (file, managed) {
                (Some(p), _) => st(true, false, format!("BIOS do PlayStation encontrada: {}.", file_name(&p))),
                (None, true) => st(false, true, "Falta a BIOS do PlayStation (um arquivo de 512 KB tirado do seu console). Coloque-a na pasta BIOS\\ps1.".into()),
                (None, false) => st(true, false, "O seu DuckStation usa a pasta de BIOS que você configurou nele.".into()),
            }
        }
        Needs::Ps2Bios => {
            let file = files_in(&dir).into_iter().find(|(p, s)| looks_ps2_bios(p, *s)).map(|(p, _)| p);
            match (file, managed) {
                (Some(p), _) => st(true, false, format!("BIOS do PlayStation 2 encontrada: {}.", file_name(&p))),
                (None, true) => st(false, true, "Falta a BIOS do PlayStation 2 (um arquivo de 4 MB tirado do seu console). Coloque-a na pasta BIOS\\ps2.".into()),
                (None, false) => st(true, false, "O seu PCSX2 usa a pasta de BIOS que você configurou nele.".into()),
            }
        }
        Needs::Ps3Firmware => {
            let installed = found.map(|f| rpcs3_firmware(&f.exe)).unwrap_or(false);
            if installed {
                return st(true, false, "Firmware do PS3 instalado no RPCS3.".into());
            }
            match ps3_pup(&dir) {
                Some(p) => NeedStatus {
                    action: found.map(|_| "install-firmware"),
                    ..st(false, true, format!("Encontrei {}. Falta instalar no RPCS3: é um clique.", file_name(&p)))
                },
                None => st(false, true, "Falta o firmware do PS3. Baixe o PS3UPDAT.PUP no site oficial da PlayStation e coloque na pasta BIOS\\ps3.".into()),
            }
        }
        Needs::XboxFiles => {
            let f = xbox_files(&dir);
            let mut missing = Vec::new();
            if f.bootrom.is_none() {
                missing.push("a boot ROM do MCPX (512 bytes)");
            }
            if f.flash.is_none() {
                missing.push("a BIOS (256 KB ou 1 MB)");
            }
            if f.hdd.is_none() {
                missing.push("a imagem do disco rígido (.qcow2)");
            }
            if missing.is_empty() {
                st(true, false, "Arquivos do Xbox encontrados.".into())
            } else if managed {
                st(false, true, format!("Faltam {} do seu Xbox, na pasta BIOS\\xbox.", missing.join(", ")))
            } else {
                st(true, false, "O seu xemu usa os arquivos que você configurou nele.".into())
            }
        }
        Needs::WiiUKeys => {
            let has = dir.join("keys.txt").is_file() || found.map(|f| base_of(&f.exe).join("keys.txt").is_file() || base_of(&f.exe).join("portable").join("keys.txt").is_file()).unwrap_or(false);
            NeedStatus { asks: true, ok: true, blocks: false, text: if has { "keys.txt encontrado.".into() } else { "Só discos .wud/.wux criptografados precisam do keys.txt; .wua e jogos descriptografados abrem sem ele.".into() }, folder, action: None }
        }
        Needs::SwitchKeys => NeedStatus {
            asks: true,
            ok: true,
            blocks: false,
            text: "O Ryujinx precisa das chaves (prod.keys) e do firmware do seu console, instalados nele mesmo.".into(),
            folder: None,
            action: None,
        },
    }
}

fn file_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
}

// ---- Opening a game ----

fn ares_system(system: &str) -> &'static str {
    match system {
        "nes" => "Famicom",
        "snes" => "Super Famicom",
        "n64" => "Nintendo 64",
        "md" => "Mega Drive",
        "sms" => "Master System",
        "gg" => "Game Gear",
        "pce" => "PC Engine",
        "gb" => "Game Boy",
        "gbc" => "Game Boy Color",
        _ => "",
    }
}

/// The emulator's arguments to open `game` in full screen and close with it, as a list (never
/// one line put together by hand), from each emulator's own argument parser
/// (clay/emuladores/cli-referencia-rapida.md).
pub fn launch_args(emu: &str, system: &str, game: &Path) -> Vec<String> {
    let g = game.display().to_string();
    let v = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<String>>();
    let mut args = match emu {
        // "--" before the path: both join loose words into one path otherwise.
        "pcsx2" | "duckstation" => v(&["-batch", "-nogui", "-fullscreen", "--"]),
        "dolphin" => {
            let mut a = v(&["-b", "-C", "Dolphin.Display.Fullscreen=True", "-e"]);
            a.push(g);
            return a;
        }
        "ppsspp" => v(&["--fullscreen", "--escape-exit"]),
        "mgba" | "melonds" | "azahar" => v(&["-f"]),
        "rmg" => v(&["--fullscreen", "--nogui", "--quit-after-emulation"]),
        "rpcs3" => v(&["--no-gui", "--fullscreen"]),
        "xemu" => v(&["-full-screen", "-dvd_path"]),
        "cemu" => v(&["-f", "-g"]),
        "xenia" => v(&["--fullscreen"]),
        "flycast" => v(&["-config", "window:fullscreen=yes"]),
        "shadps4" => v(&["-f", "true", "-g"]),
        "ares" => {
            let mut a = v(&["--fullscreen"]);
            let name = ares_system(system);
            if !name.is_empty() {
                a.push("--system".into());
                a.push(name.into());
            }
            a
        }
        "ryujinx" => v(&["-f"]),
        _ => Vec::new(),
    };
    args.push(g);
    args
}

// ---- Small helpers for the disc readers (roms.rs) ----

pub fn read_at(f: &mut std::fs::File, offset: u64, len: usize) -> Option<Vec<u8>> {
    f.seek(SeekFrom::Start(offset)).ok()?;
    let mut buf = vec![0u8; len];
    f.read_exact(&mut buf).ok()?;
    Some(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_console_has_known_emulators() {
        for s in SYSTEMS {
            assert!(!s.emulators.is_empty(), "{}", s.id);
            for e in s.emulators {
                assert!(emulator(e).is_some(), "{} -> {e}", s.id);
            }
        }
        for e in EMULATORS {
            assert!(SYSTEMS.iter().any(|s| s.emulators.contains(&e.id)), "{} plays nothing", e.id);
        }
    }

    #[test]
    fn windows_builds_are_picked_by_name() {
        let pick = |id: &str, name: &str| match &emulator(id).unwrap().source {
            Source::GitHub { must, not, .. } => asset_matches(name, must, not),
            _ => false,
        };
        assert!(pick("pcsx2", "pcsx2-v2.8.2-windows-x64-Qt.7z"));
        assert!(!pick("pcsx2", "pcsx2-v2.8.2-windows-x64-Qt-symbols.7z"));
        assert!(pick("duckstation", "duckstation-windows-x64-release.zip"));
        assert!(!pick("duckstation", "duckstation-windows-x64-sse2-release.zip"));
        assert!(!pick("duckstation", "duckstation-windows-arm64-release.zip"));
        assert!(pick("rpcs3", "rpcs3-v0.0.43-20397-8b9ee605_win64_msvc.7z"));
        assert!(!pick("rpcs3", "rpcs3-v0.0.43-20397-8b9ee605_win64_msvc.7z.sha256"));
        assert!(pick("azahar", "azahar-windows-msvc-2126.2.zip"));
        assert!(!pick("azahar", "azahar-windows-msvc-2126.2-installer.exe"));
        assert!(!pick("azahar", "azahar-libretro-windows-x86_64-2126.2.zip"));
        assert!(pick("mgba", "mGBA-0.10.5-win64.7z"));
        assert!(!pick("mgba", "mGBA-0.10.5-win64-installer.exe"));
        assert!(pick("xemu", "xemu-win-x86_64-release.zip"));
        assert!(pick("rmg", "RMG-Portable-Windows64-v0.9.0.zip"));
        assert!(!pick("rmg", "RMG-Setup-Windows64-v0.9.0.exe"));
        assert!(pick("ares", "ares-windows-x64.zip"));
        assert!(!pick("ares", "ares-windows-x64-PDBs.zip"));
        assert!(pick("xenia", "xenia_canary_windows_.zip"));
        assert!(pick("shadps4", "shadps4-win64-sdl-2026-0.20.0.zip"));
        assert!(pick("ppsspp", "PPSSPP-v1.20.4-Windows-x64.zip"));
        assert!(!pick("ppsspp", "PPSSPP-v1.20.4-Windows-ARM64.zip"));
    }

    #[test]
    fn ini_keeps_what_it_does_not_know() {
        let text = "; comment\n[UI]\nTheme = dark\n\n[Pad1]\nType = None\n";
        let out = ini_set(text, "pad1", "type", "DualShock2");
        assert!(out.contains("type = DualShock2") && !out.contains("Type = None"));
        assert!(out.contains("; comment") && out.contains("Theme = dark"));
        let out = ini_set(&out, "UI", "SetupWizardIncomplete", "false");
        assert!(out.find("SetupWizardIncomplete").unwrap() < out.find("[Pad1]").unwrap());
        let out = ini_set(&out, "Folders", "Bios", "C:\\BF\\BIOS\\ps2");
        assert!(out.ends_with("[Folders]\nBios = C:\\BF\\BIOS\\ps2\n"));
    }

    #[test]
    fn games_open_full_screen_with_the_path_last_and_whole() {
        let game = Path::new(r"D:\Jogos\ps2\God of War (USA).iso");
        let a = launch_args("pcsx2", "ps2", game);
        assert_eq!(a, vec!["-batch", "-nogui", "-fullscreen", "--", r"D:\Jogos\ps2\God of War (USA).iso"]);
        let a = launch_args("dolphin", "gc", game);
        assert_eq!(a.last().unwrap(), r"D:\Jogos\ps2\God of War (USA).iso");
        assert_eq!(a[a.len() - 2], "-e");
        let a = launch_args("ares", "md", game);
        assert_eq!(&a[..3], ["--fullscreen", "--system", "Mega Drive"]);
        let a = launch_args("xemu", "xbox", game);
        assert_eq!(a[a.len() - 2], "-dvd_path");
    }

    #[test]
    fn program_names() {
        assert!(name_matches("duckstation-qt-x64-ReleaseLTCG.exe", "duckstation-qt*"));
        assert!(!name_matches("duckstation-qt-x64-ReleaseLTCG.pdb", "duckstation-qt*"));
        assert!(name_matches("Dolphin.exe", "dolphin.exe"));
    }

    #[test]
    fn xbox_files_by_size() {
        let dir = std::env::temp_dir().join(format!("bf-xbox-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("mcpx_1.0.bin"), vec![0u8; 512]).unwrap();
        std::fs::write(dir.join("Complex_4627.bin"), vec![0u8; 262_144]).unwrap();
        std::fs::write(dir.join("xbox_hdd.qcow2"), b"QFI").unwrap();
        let f = xbox_files(&dir);
        assert!(f.bootrom.is_some() && f.flash.is_some() && f.hdd.is_some());
        let toml = dir.join("xemu.toml");
        xemu_files(&toml, &dir).unwrap();
        let text = std::fs::read_to_string(&toml).unwrap();
        assert!(text.contains("[sys.files]") && text.contains("bootrom_path = '") && text.contains("show_welcome = false"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
