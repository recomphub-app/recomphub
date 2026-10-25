//! Finding console games in the player's folders: by the folder's console, the file's
//! extension and, for the ambiguous ones (.iso, .cue, .chd, .rvz...), a look at the file's own
//! header. A guess is only a suggestion (consensus with Codex): nothing is moved or renamed,
//! and a file that stays unclear goes to a list where the player picks the console.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::emu::{self, read_at, SYSTEMS};

/// A game found in a folder.
#[derive(Debug, Clone)]
pub struct Found {
    pub id: String,
    pub system: &'static str,
    /// The folder holding the game's file (or the game's own folder, for PS3, PS4, Wii U).
    pub dir: PathBuf,
    /// The file Black Flag hands to the emulator, relative to `dir`.
    pub file: String,
    pub title: String,
    /// PS1/PS2 disc serial ("SLUS-20946"), for covers.
    pub serial: Option<String>,
}

/// A file that looks like a game of more than one console (or of none Black Flag can tell).
#[derive(Debug, Clone, serde::Serialize)]
pub struct Unknown {
    pub path: String,
    /// The most likely console, offered first.
    pub guess: Option<&'static str>,
    pub options: Vec<&'static str>,
}

#[derive(Default)]
pub struct Scan {
    pub found: Vec<Found>,
    pub unknown: Vec<Unknown>,
}

/// Extensions read to tell consoles apart.
const SNIFFED: &[&str] = &[".iso", ".gcm", ".cue", ".chd", ".rvz", ".wia", ".gcz", ".wbfs", ".pbp"];
/// At most this many folders are looked at in one search.
const MAX_DIRS: usize = 20_000;

pub fn game_id(system: &str, path: &Path) -> String {
    // FNV-1a over the path without case: the same file keeps its id (and its play time).
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in path.to_string_lossy().to_lowercase().bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("emu-{system}-{h:016x}")
}

fn ext_of(p: &Path) -> String {
    p.extension().map(|e| format!(".{}", e.to_string_lossy().to_lowercase())).unwrap_or_default()
}

fn consoles_for(ext: &str) -> Vec<&'static str> {
    SYSTEMS.iter().filter(|s| s.extensions.contains(&ext)).map(|s| s.id).collect()
}

/// Looks through `folder` (and the folders under it). `system`: every game in it is of this
/// console; None tells them apart one by one.
pub fn scan(folder: &Path, system: Option<&str>) -> Scan {
    let mut out = Scan::default();
    let mut stack = vec![(folder.to_path_buf(), 0usize)];
    let mut seen = 0usize;
    while let Some((dir, depth)) = stack.pop() {
        seen += 1;
        if seen > MAX_DIRS {
            break;
        }
        if let Some(f) = folder_game(&dir, system) {
            out.found.push(f);
            continue;
        }
        let Ok(list) = std::fs::read_dir(&dir) else { continue };
        let mut files = Vec::new();
        for e in list.flatten() {
            let p = e.path();
            if p.is_dir() {
                if depth < 6 {
                    stack.push((p, depth + 1));
                }
            } else {
                files.push(p);
            }
        }
        files.sort();
        // Tracks of a .cue and discs of a .m3u are not games of their own.
        let mut taken: HashSet<String> = HashSet::new();
        for f in &files {
            match ext_of(f).as_str() {
                ".cue" => taken.extend(cue_files(f).into_iter().map(|n| n.to_lowercase())),
                ".m3u" => taken.extend(m3u_files(f).into_iter().map(|n| n.to_lowercase())),
                ".gdi" => taken.extend(gdi_files(f).into_iter().map(|n| n.to_lowercase())),
                _ => {}
            }
        }
        let mut discs_seen: HashSet<String> = HashSet::new();
        for f in &files {
            let name = f.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            if taken.contains(&name.to_lowercase()) {
                continue;
            }
            let ext = ext_of(f);
            let options = consoles_for(&ext);
            if options.is_empty() {
                continue;
            }
            let console = match system {
                Some(s) => options.iter().copied().find(|o| *o == s),
                None if SNIFFED.contains(&ext.as_str()) => sniff(f).filter(|s| options.contains(s)).or_else(|| (options.len() == 1).then(|| options[0])),
                None => (options.len() == 1).then(|| options[0]),
            };
            match console {
                Some(c) => {
                    // Disc 2, 3... of a game already found are the same game.
                    let stem = f.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                    let title = clean_title(&stem);
                    if disc_number(&stem).is_some() && !discs_seen.insert(format!("{c}/{}", title.to_lowercase())) {
                        continue;
                    }
                    let serial = if c == "ps1" || c == "ps2" { disc_serial(f) } else { None };
                    out.found.push(Found { id: game_id(c, f), system: c, dir: dir.clone(), file: name, title, serial });
                }
                None if system.is_none() => out.unknown.push(Unknown {
                    path: f.display().to_string(),
                    guess: guess(f, &ext),
                    options,
                }),
                None => {}
            }
        }
    }
    out
}

/// The likeliest console for a file that could not be told apart.
fn guess(path: &Path, ext: &str) -> Option<&'static str> {
    match ext {
        ".chd" => match chd_kind(path) {
            Some(ChdKind::Cd) => Some("ps1"),
            Some(ChdKind::Gd) => Some("dc"),
            Some(ChdKind::Dvd) => Some("ps2"),
            None => None,
        },
        ".cso" | ".zso" => Some("psp"),
        ".iso" => Some("ps2"),
        _ => None,
    }
}

/// Games that are a folder: PS3 (PS3_GAME\USRDIR\EBOOT.BIN), PS4 (eboot.bin and
/// sce_sys\param.sfo), Wii U (code\*.rpx and meta\meta.xml) and Xbox 360 (default.xex).
fn folder_game(dir: &Path, system: Option<&str>) -> Option<Found> {
    let allowed = |s: &str| system.map(|x| x == s).unwrap_or(true);
    let make = |sys: &'static str, file: &str, title: Option<String>| {
        let title = title.filter(|t| !t.trim().is_empty()).unwrap_or_else(|| clean_title(&dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()));
        Some(Found { id: game_id(sys, &dir.join(file)), system: sys, dir: dir.to_path_buf(), file: file.to_string(), title, serial: None })
    };
    if allowed("ps3") {
        if dir.join("PS3_GAME").join("USRDIR").join("EBOOT.BIN").is_file() {
            return make("ps3", "PS3_GAME\\USRDIR\\EBOOT.BIN", sfo_title(&dir.join("PS3_GAME").join("PARAM.SFO")));
        }
        if dir.join("USRDIR").join("EBOOT.BIN").is_file() && dir.join("PARAM.SFO").is_file() {
            return make("ps3", "USRDIR\\EBOOT.BIN", sfo_title(&dir.join("PARAM.SFO")));
        }
    }
    if allowed("ps4") && dir.join("eboot.bin").is_file() && dir.join("sce_sys").join("param.sfo").is_file() {
        return make("ps4", "eboot.bin", sfo_title(&dir.join("sce_sys").join("param.sfo")));
    }
    if allowed("wiiu") && dir.join("meta").join("meta.xml").is_file() {
        let rpx = std::fs::read_dir(dir.join("code"))
            .ok()?
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .find(|n| n.to_lowercase().ends_with(".rpx"))?;
        let title = std::fs::read_to_string(dir.join("meta").join("meta.xml")).ok().and_then(|x| xml_value(&x, "longname_en"));
        return make("wiiu", &format!("code\\{rpx}"), title);
    }
    if allowed("x360") && dir.join("default.xex").is_file() {
        return make("x360", "default.xex", None);
    }
    None
}

fn xml_value(xml: &str, tag: &str) -> Option<String> {
    let start = xml.find(&format!("<{tag}"))?;
    let open_end = xml[start..].find('>')? + start + 1;
    let close = xml[open_end..].find(&format!("</{tag}>"))? + open_end;
    Some(xml[open_end..close].replace(['\n', '\r'], " ").trim().to_string())
}

/// TITLE from a PlayStation PARAM.SFO.
pub fn sfo_title(path: &Path) -> Option<String> {
    let b = std::fs::read(path).ok()?;
    if b.len() < 20 || &b[0..4] != b"\0PSF" {
        return None;
    }
    let u32_at = |o: usize| b.get(o..o + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]) as usize);
    let u16_at = |o: usize| b.get(o..o + 2).map(|s| u16::from_le_bytes([s[0], s[1]]) as usize);
    let (keys, data, count) = (u32_at(8)?, u32_at(12)?, u32_at(16)?);
    for i in 0..count.min(256) {
        let e = 20 + i * 16;
        let key_start = keys + u16_at(e)?;
        let key_end = b.get(key_start..)?.iter().position(|c| *c == 0)? + key_start;
        if &b[key_start..key_end] != b"TITLE" {
            continue;
        }
        let len = u32_at(e + 4)?;
        let at = data + u32_at(e + 12)?;
        let raw = b.get(at..at + len)?;
        let text = String::from_utf8_lossy(raw).trim_end_matches('\0').replace(['\n', '\r'], " ");
        return Some(text.trim().to_string());
    }
    None
}

fn cue_files(cue: &Path) -> Vec<String> {
    std::fs::read_to_string(cue)
        .map(|t| {
            t.lines()
                .filter_map(|l| {
                    let l = l.trim();
                    if !l.to_uppercase().starts_with("FILE") {
                        return None;
                    }
                    let rest = l[4..].trim();
                    let name = if let Some(r) = rest.strip_prefix('"') { r.split('"').next()? } else { rest.split_whitespace().next()? };
                    Path::new(name).file_name().map(|n| n.to_string_lossy().to_string())
                })
                .collect()
        })
        .unwrap_or_default()
}

fn m3u_files(m3u: &Path) -> Vec<String> {
    std::fs::read_to_string(m3u)
        .map(|t| {
            t.lines()
                .map(str::trim)
                .filter(|l| !l.is_empty() && !l.starts_with('#'))
                .filter_map(|l| Path::new(l).file_name().map(|n| n.to_string_lossy().to_string()))
                .collect()
        })
        .unwrap_or_default()
}

fn gdi_files(gdi: &Path) -> Vec<String> {
    std::fs::read_to_string(gdi)
        .map(|t| {
            t.lines()
                .skip(1)
                .filter_map(|l| {
                    let l = l.trim();
                    let name = if let Some(q) = l.find('"') { l[q + 1..].split('"').next() } else { l.split_whitespace().nth(4) };
                    name.map(str::to_string)
                })
                .collect()
        })
        .unwrap_or_default()
}

// ---- Reading the discs ----

/// The console of a disc image, from its header; None when it cannot tell.
pub fn sniff(path: &Path) -> Option<&'static str> {
    match ext_of(path).as_str() {
        ".iso" | ".gcm" => sniff_disc(path),
        ".cue" => {
            let first = cue_files(path).into_iter().next()?;
            sniff_disc(&path.parent()?.join(first))
        }
        ".wbfs" => Some("wii"),
        ".rvz" | ".wia" => {
            let mut f = std::fs::File::open(path).ok()?;
            let head = read_at(&mut f, 0, 0x4C)?;
            if &head[0..3] != b"RVZ" && &head[0..3] != b"WIA" {
                return None;
            }
            match u32::from_be_bytes([head[0x48], head[0x49], head[0x4A], head[0x4B]]) {
                1 => Some("gc"),
                2 => Some("wii"),
                _ => None,
            }
        }
        ".gcz" => {
            let mut f = std::fs::File::open(path).ok()?;
            let head = read_at(&mut f, 0, 8)?;
            if head[0..4] != [0x01, 0xC0, 0x0B, 0xB1] {
                return None;
            }
            match u32::from_le_bytes([head[4], head[5], head[6], head[7]]) {
                0 => Some("gc"),
                1 => Some("wii"),
                _ => None,
            }
        }
        ".pbp" => {
            // PS1 games sold for the PSP carry a "PSISOIMG" (or "PSTITLEI") data part.
            let mut f = std::fs::File::open(path).ok()?;
            let head = read_at(&mut f, 0, 0x28)?;
            if &head[0..4] != b"\0PBP" {
                return None;
            }
            let psar = u32::from_le_bytes([head[0x24], head[0x25], head[0x26], head[0x27]]) as u64;
            let magic = read_at(&mut f, psar, 8)?;
            Some(if &magic == b"PSISOIMG" || &magic == b"PSTITLEI" { "ps1" } else { "psp" })
        }
        ".chd" => match chd_kind(path)? {
            ChdKind::Gd => Some("dc"),
            // A CD may be PS1 or a PS2 CD; a DVD may be PS2 or PSP: the folder decides.
            _ => None,
        },
        _ => None,
    }
}

const XBOX_MAGIC: &[u8] = b"MICROSOFT*XBOX*MEDIA";

fn sniff_disc(path: &Path) -> Option<&'static str> {
    let mut f = std::fs::File::open(path).ok()?;
    let head = read_at(&mut f, 0, 0x20)?;
    if head[0x1C..0x20] == [0xC2, 0x33, 0x9F, 0x3D] {
        return Some("gc");
    }
    if head[0x18..0x1C] == [0x5D, 0x1C, 0x9E, 0xA3] {
        return Some("wii");
    }
    // Xbox file systems: rebuilt images at the start, full ones after the video partition
    // (0x18300000 for the Xbox; 0xFDA0000 and 0x2080000 for the Xbox 360).
    for (base, guess) in [(0u64, None), (0x1830_0000, Some("xbox")), (0x0FDA_0000, Some("x360")), (0x0208_0000, Some("x360"))] {
        if read_at(&mut f, base + 0x10000, 20).as_deref() == Some(XBOX_MAGIC) {
            return xbox_kind(&mut f, base).or(guess);
        }
    }
    iso9660_kind(&mut f)
}

/// Xbox or Xbox 360, by the program in the root folder (default.xbe or default.xex).
fn xbox_kind(f: &mut std::fs::File, base: u64) -> Option<&'static str> {
    let vd = read_at(f, base + 0x10000, 28)?;
    let sector = u32::from_le_bytes([vd[20], vd[21], vd[22], vd[23]]) as u64;
    let size = (u32::from_le_bytes([vd[24], vd[25], vd[26], vd[27]]) as usize).min(256 * 1024);
    let dir = read_at(f, base + sector * 2048, size)?.to_ascii_lowercase();
    if dir.windows(11).any(|w| w == b"default.xex") {
        Some("x360")
    } else if dir.windows(11).any(|w| w == b"default.xbe") {
        Some("xbox")
    } else {
        None
    }
}

fn iso9660_kind(f: &mut std::fs::File) -> Option<&'static str> {
    iso9660_read(f).and_then(|(kind, _)| kind)
}

/// PSP (PSP_GAME), PS3 (PS3_GAME) or, by SYSTEM.CNF, PS2 (BOOT2) and PS1 (BOOT), on a disc
/// with 2048-byte sectors (.iso) or raw 2352-byte ones (.bin from a .cue); with SYSTEM.CNF's
/// text when the disc has one.
fn iso9660_read(f: &mut std::fs::File) -> Option<(Option<&'static str>, Option<String>)> {
    for (sector, skip) in [(2048u64, 0u64), (2352, 24), (2352, 16)] {
        let at = |lba: u64| lba * sector + skip;
        let Some(pvd) = read_at(f, at(16), 2048) else { continue };
        if &pvd[1..6] != b"CD001" {
            continue;
        }
        let root = &pvd[156..190];
        let lba = u32::from_le_bytes([root[2], root[3], root[4], root[5]]) as u64;
        let len = (u32::from_le_bytes([root[10], root[11], root[12], root[13]]) as u64).min(64 * 1024);
        let mut dir = Vec::new();
        for i in 0..len.div_ceil(2048) {
            dir.extend(read_at(f, at(lba + i), 2048)?);
        }
        let mut pos = 0usize;
        while pos + 33 < dir.len() {
            let rec_len = dir[pos] as usize;
            if rec_len == 0 {
                // Records do not cross sectors: on to the next one.
                pos = (pos / 2048 + 1) * 2048;
                continue;
            }
            let name_len = dir[pos + 32] as usize;
            let name = String::from_utf8_lossy(dir.get(pos + 33..pos + 33 + name_len)?).to_uppercase();
            if name == "PSP_GAME" || name == "UMD_DATA.BIN" {
                return Some((Some("psp"), None));
            }
            if name == "PS3_GAME" {
                return Some((Some("ps3"), None));
            }
            if name.starts_with("SYSTEM.CNF") {
                let flba = u32::from_le_bytes([dir[pos + 2], dir[pos + 3], dir[pos + 4], dir[pos + 5]]) as u64;
                let cnf = read_at(f, at(flba), 2048)?;
                let text = String::from_utf8_lossy(&cnf).trim_end_matches('\0').to_string();
                let up = text.to_uppercase();
                let kind = if up.contains("BOOT2") { Some("ps2") } else if up.contains("BOOT") { Some("ps1") } else { None };
                return Some((kind, Some(text)));
            }
            pos += rec_len;
        }
        return None;
    }
    None
}

/// "SLUS-20946" from SYSTEM.CNF's "BOOT2 = cdrom0:\SLUS_209.46;1": the serial PS1 and PS2 cover
/// collections (and PCSX2, DuckStation) name games by.
pub fn serial_from_cnf(cnf: &str) -> Option<String> {
    let line = cnf.lines().find(|l| l.trim_start().to_uppercase().starts_with("BOOT"))?;
    let file = line.rsplit(['\\', ':', '/']).next()?.split(';').next()?.trim();
    let (prefix, rest) = file.split_once('_')?;
    let digits: String = rest.chars().filter(char::is_ascii_digit).collect();
    (prefix.len() == 4 && prefix.chars().all(|c| c.is_ascii_alphabetic()) && digits.len() == 5)
        .then(|| format!("{}-{digits}", prefix.to_uppercase()))
}

/// A PS1 or PS2 disc's serial (.iso, or the first track of a .cue).
pub fn disc_serial(path: &Path) -> Option<String> {
    let target = match ext_of(path).as_str() {
        ".iso" | ".bin" | ".img" => path.to_path_buf(),
        ".cue" => path.parent()?.join(cue_files(path).into_iter().next()?),
        _ => return None,
    };
    let mut f = std::fs::File::open(target).ok()?;
    let (_, cnf) = iso9660_read(&mut f)?;
    serial_from_cnf(&cnf?)
}

/// Where an ISO9660 disc keeps its files: sector size, the bytes before each sector's data
/// (raw .bin) and the root folder (sector, length).
fn iso_layout(f: &mut std::fs::File) -> Option<(u64, u64, u64, u64)> {
    for (sector, skip) in [(2048u64, 0u64), (2352, 24), (2352, 16)] {
        let Some(pvd) = read_at(f, 16 * sector + skip, 2048) else { continue };
        if &pvd[1..6] != b"CD001" {
            continue;
        }
        let root = &pvd[156..190];
        let lba = u32::from_le_bytes([root[2], root[3], root[4], root[5]]) as u64;
        let len = u32::from_le_bytes([root[10], root[11], root[12], root[13]]) as u64;
        return Some((sector, skip, lba, len));
    }
    None
}

/// The data of a file on the disc, up to `max` bytes.
fn iso_read(f: &mut std::fs::File, (sector, skip): (u64, u64), lba: u64, size: u64, max: u64) -> Option<Vec<u8>> {
    let size = size.min(max);
    let mut out = Vec::with_capacity(size as usize);
    for i in 0..size.div_ceil(2048) {
        out.extend(read_at(f, (lba + i) * sector + skip, 2048)?);
    }
    out.truncate(size as usize);
    Some(out)
}

/// A file on the disc by its path ("SLUS_212.42" or "DATA\MAIN.ELF"), as (sector, size); the
/// ";1" version is ignored on both sides.
fn iso_find(f: &mut std::fs::File, layout: (u64, u64, u64, u64), path: &str) -> Option<(u64, u64)> {
    let (sector, skip, mut lba, mut len) = layout;
    let parts: Vec<String> = path.split(['\', '/']).filter(|p| !p.is_empty()).map(|p| p.split(';').next().unwrap_or("").to_uppercase()).collect();
    for (i, part) in parts.iter().enumerate() {
        let dir = iso_read(f, (sector, skip), lba, len, 256 * 1024)?;
        let mut pos = 0usize;
        let mut next = None;
        while pos + 33 < dir.len() {
            let rec_len = dir[pos] as usize;
            if rec_len == 0 {
                pos = (pos / 2048 + 1) * 2048;
                continue;
            }
            let name_len = dir[pos + 32] as usize;
            let name = String::from_utf8_lossy(dir.get(pos + 33..pos + 33 + name_len)?).to_uppercase();
            if name.split(';').next() == Some(part.as_str()) {
                let at = u32::from_le_bytes([dir[pos + 2], dir[pos + 3], dir[pos + 4], dir[pos + 5]]) as u64;
                let size = u32::from_le_bytes([dir[pos + 10], dir[pos + 11], dir[pos + 12], dir[pos + 13]]) as u64;
                next = Some((at, size));
                break;
            }
            pos += rec_len;
        }
        let (at, size) = next?;
        if i == parts.len() - 1 {
            return Some((at, size));
        }
        lba = at;
        len = size;
    }
    None
}

/// The hash RetroAchievements knows a PS2 disc by, made the way PCSX2 makes it
/// (Achievements::GetGameHash): MD5 of the boot program's name ("SLUS_212.42", from
/// SYSTEM.CNF's BOOT2) followed by the program itself, up to 64 MB. None for a .chd, which
/// would need its decoder: PCSX2 says the hash in its log when the game starts instead.
pub fn ps2_ra_hash(path: &Path) -> Option<String> {
    use md5::{Digest, Md5};
    let target = match ext_of(path).as_str() {
        ".iso" | ".bin" | ".img" => path.to_path_buf(),
        ".cue" => path.parent()?.join(cue_files(path).into_iter().next()?),
        _ => return None,
    };
    let mut f = std::fs::File::open(target).ok()?;
    let layout = iso_layout(&mut f)?;
    let (at, size) = iso_find(&mut f, layout, "SYSTEM.CNF")?;
    let cnf = iso_read(&mut f, (layout.0, layout.1), at, size, 4096)?;
    let cnf = String::from_utf8_lossy(&cnf).to_string();
    let boot = cnf.lines().find_map(|l| {
        let (k, v) = l.split_once('=')?;
        k.trim().eq_ignore_ascii_case("BOOT2").then(|| v.trim().to_string())
    })?;
    // PCSX2's GetELFNameForHash: after the last backslash, before the ';'.
    let start = boot.rfind('\').map(|i| i + 1).unwrap_or(0);
    let end = boot.rfind(';').filter(|&e| e >= start).unwrap_or(boot.len());
    let name = &boot[start..end];
    if name.is_empty() {
        return None;
    }
    let inside = boot.split_once(':').map(|(_, p)| p).unwrap_or(&boot);
    let (at, size) = iso_find(&mut f, layout, inside)?;
    let elf = iso_read(&mut f, (layout.0, layout.1), at, size, 64 * 1024 * 1024)?;
    let mut md5 = Md5::new();
    md5.update(name.as_bytes());
    md5.update(&elf);
    Some(format!("{:x}", md5.finalize()))
}

/// A quick look at the games folders: the folders in them (three levels down) and when each
/// last changed. Windows updates a folder's time when something is added to it or taken out,
/// so a game put in any of them changes this.
pub fn folders_signature(state: &emu::State) -> u64 {
    let root = state.root();
    let mut tops: Vec<PathBuf> = SYSTEMS.iter().map(|s| emu::games_dir(&root, s.id)).collect();
    tops.extend(state.folders.iter().map(|f| PathBuf::from(&f.path)));
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut mix = |bytes: &[u8]| {
        for b in bytes {
            h ^= u64::from(*b);
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
    };
    let mut stack: Vec<(PathBuf, usize)> = tops.into_iter().map(|p| (p, 0)).collect();
    let mut seen = 0;
    while let Some((dir, depth)) = stack.pop() {
        seen += 1;
        if seen > 4000 {
            break;
        }
        let Ok(meta) = std::fs::metadata(&dir) else { continue };
        let time = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0);
        mix(dir.to_string_lossy().as_bytes());
        mix(&time.to_le_bytes());
        if depth < 3 {
            if let Ok(list) = std::fs::read_dir(&dir) {
                stack.extend(list.flatten().map(|e| e.path()).filter(|p| p.is_dir()).map(|p| (p, depth + 1)));
            }
        }
    }
    h
}

#[derive(Debug, PartialEq)]
enum ChdKind {
    Cd,
    Gd,
    Dvd,
}

/// What a CHD holds, from its first metadata tag (CD tracks, GD-ROM, DVD).
fn chd_kind(path: &Path) -> Option<ChdKind> {
    let mut f = std::fs::File::open(path).ok()?;
    let head = read_at(&mut f, 0, 0x38)?;
    if &head[0..8] != b"MComprHD" {
        return None;
    }
    let version = u32::from_be_bytes([head[12], head[13], head[14], head[15]]);
    let meta_at = if version >= 5 { 0x30 } else { 0x24 };
    let mut offset = u64::from_be_bytes(head[meta_at..meta_at + 8].try_into().ok()?);
    for _ in 0..16 {
        if offset == 0 {
            break;
        }
        let entry = read_at(&mut f, offset, 16)?;
        match &entry[0..4] {
            b"CHT2" | b"CHTR" | b"CHCD" => return Some(ChdKind::Cd),
            b"CHGD" | b"CHGT" => return Some(ChdKind::Gd),
            b"DVD " => return Some(ChdKind::Dvd),
            _ => offset = u64::from_be_bytes(entry[8..16].try_into().ok()?),
        }
    }
    None
}

// ---- Titles ----

const TAG_WORDS: &[&str] = &[
    "usa", "us", "europe", "eu", "japan", "jp", "world", "brazil", "brasil", "korea", "china", "asia", "australia", "germany",
    "france", "spain", "italy", "netherlands", "sweden", "russia", "uk", "canada", "en", "ja", "fr", "de", "es", "it", "pt", "pt-br",
    "nl", "sv", "no", "da", "fi", "ru", "ko", "zh", "pl", "unl", "beta", "proto", "prototype", "demo", "sample", "ntsc", "pal",
    "ntsc-u", "ntsc-j", "pal-e", "virtual console", "greatest hits", "platinum", "limited edition",
];

fn is_tag_group(inner: &str) -> bool {
    let low = inner.trim().to_lowercase();
    if low.is_empty() {
        return true;
    }
    let starts = ["rev ", "rev.", "v1", "v2", "v3", "v0", "disc ", "disk ", "cd ", "track "];
    if starts.iter().any(|s| low.starts_with(s)) || low.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return true;
    }
    low.split([',', '+']).map(str::trim).all(|w| TAG_WORDS.contains(&w))
}

/// "Disc 2" in a file name, as Redump names multi-disc games.
pub fn disc_number(stem: &str) -> Option<u32> {
    let low = stem.to_lowercase();
    for key in ["(disc ", "(disk ", "(cd "] {
        if let Some(i) = low.find(key) {
            let rest = &low[i + key.len()..];
            let n: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            if let Ok(n) = n.parse() {
                return Some(n);
            }
        }
    }
    None
}

/// A readable name from a file name: region, languages, revision and disc go; anything else
/// between parentheses may be part of the name and stays. Brackets are dump tags ([!], [b]).
pub fn clean_title(stem: &str) -> String {
    let mut s = stem.to_string();
    if !s.contains(' ') && s.contains('_') {
        s = s.replace('_', " ");
    }
    let mut out = String::new();
    let mut rest = s.as_str();
    while let Some(open) = rest.find(['(', '[']) {
        let close_char = if rest.as_bytes()[open] == b'(' { ')' } else { ']' };
        let Some(close) = rest[open..].find(close_char).map(|c| c + open) else { break };
        let inner = &rest[open + 1..close];
        out.push_str(&rest[..open]);
        if close_char == ')' && !is_tag_group(inner) {
            out.push_str(&rest[open..=close]);
        }
        rest = &rest[close + 1..];
    }
    out.push_str(rest);
    let cleaned = out.split_whitespace().collect::<Vec<_>>().join(" ");
    let cleaned = cleaned.trim_matches(|c: char| c == '-' || c == ' ' || c == '.').to_string();
    if cleaned.is_empty() {
        stem.trim().to_string()
    } else {
        cleaned
    }
}

/// The other discs of a multi-disc game, beside `first` (same name but the disc number).
pub fn sibling_discs(first: &Path) -> Vec<PathBuf> {
    let Some(stem) = first.file_stem().map(|s| s.to_string_lossy().to_string()) else { return Vec::new() };
    if disc_number(&stem).is_none() {
        return Vec::new();
    }
    let title = clean_title(&stem).to_lowercase();
    let ext = ext_of(first);
    let mut discs: Vec<(u32, PathBuf)> = std::fs::read_dir(first.parent().unwrap_or(Path::new(".")))
        .map(|l| {
            l.flatten()
                .map(|e| e.path())
                .filter(|p| ext_of(p) == ext)
                .filter_map(|p| {
                    let st = p.file_stem()?.to_string_lossy().to_string();
                    (clean_title(&st).to_lowercase() == title).then(|| (disc_number(&st).unwrap_or(0), p))
                })
                .collect()
        })
        .unwrap_or_default();
    discs.sort();
    discs.into_iter().map(|(_, p)| p).collect()
}

/// Every console's own folder and the player's extra folders, searched.
pub fn scan_all(state: &emu::State) -> Scan {
    let root = state.root();
    let mut all = Scan::default();
    for s in SYSTEMS {
        let r = scan(&emu::games_dir(&root, s.id), Some(s.id));
        all.found.extend(r.found);
    }
    for folder in &state.folders {
        let r = scan(Path::new(&folder.path), folder.system.as_deref());
        all.found.extend(r.found);
        all.unknown.extend(r.unknown);
    }
    // The same file through two folders counts once.
    let mut ids = HashSet::new();
    all.found.retain(|f| ids.insert(f.id.clone()));
    let found_paths: HashSet<String> = all.found.iter().map(|f| f.dir.join(&f.file).display().to_string().to_lowercase()).collect();
    let mut seen = HashSet::new();
    all.unknown.retain(|u| !found_paths.contains(&u.path.to_lowercase()) && seen.insert(u.path.to_lowercase()));
    all
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_lose_only_the_tags() {
        assert_eq!(clean_title("God of War (USA)"), "God of War");
        assert_eq!(clean_title("Final Fantasy VII (USA) (Disc 1)"), "Final Fantasy VII");
        assert_eq!(clean_title("Super Mario 64 (Europe) (En,Fr,De) [!]"), "Super Mario 64");
        assert_eq!(clean_title("Metal Gear Solid (Rev 1)"), "Metal Gear Solid");
        assert_eq!(clean_title("Mario Kart (Double Dash!!) (USA)"), "Mario Kart (Double Dash!!)");
        assert_eq!(clean_title("silent_hill_2"), "silent hill 2");
        assert_eq!(clean_title("(USA)"), "(USA)");
        assert_eq!(disc_number("Final Fantasy VII (USA) (Disc 2)"), Some(2));
        assert_eq!(disc_number("Final Fantasy VII"), None);
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("bf-roms-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn discs_are_told_apart_by_their_header() {
        let d = tmp("sniff");
        let mut gc = vec![0u8; 0x40];
        gc[0x1C..0x20].copy_from_slice(&[0xC2, 0x33, 0x9F, 0x3D]);
        std::fs::write(d.join("a.iso"), &gc).unwrap();
        let mut wii = vec![0u8; 0x40];
        wii[0x18..0x1C].copy_from_slice(&[0x5D, 0x1C, 0x9E, 0xA3]);
        std::fs::write(d.join("b.iso"), &wii).unwrap();

        // An ISO9660 disc with SYSTEM.CNF saying BOOT2 (PS2).
        let mut iso = vec![0u8; 2048 * 24];
        let pvd = 16 * 2048;
        iso[pvd + 1..pvd + 6].copy_from_slice(b"CD001");
        iso[pvd + 156 + 2..pvd + 156 + 6].copy_from_slice(&20u32.to_le_bytes());
        iso[pvd + 156 + 10..pvd + 156 + 14].copy_from_slice(&2048u32.to_le_bytes());
        let rec = 20 * 2048;
        let name = b"SYSTEM.CNF;1";
        iso[rec] = (33 + name.len()) as u8;
        iso[rec + 2..rec + 6].copy_from_slice(&21u32.to_le_bytes());
        iso[rec + 32] = name.len() as u8;
        iso[rec + 33..rec + 33 + name.len()].copy_from_slice(name);
        let cnf = b"BOOT2 = cdrom0:\\SLUS_212.42;1\r\n";
        iso[21 * 2048..21 * 2048 + cnf.len()].copy_from_slice(cnf);
        std::fs::write(d.join("c.iso"), &iso).unwrap();
        let cnf1 = b"BOOT = cdrom:\\SCUS_941.63;1\r\n";
        let mut ps1 = iso.clone();
        ps1[21 * 2048..21 * 2048 + cnf.len()].fill(0);
        ps1[21 * 2048..21 * 2048 + cnf1.len()].copy_from_slice(cnf1);
        std::fs::write(d.join("d.iso"), &ps1).unwrap();

        assert_eq!(sniff(&d.join("a.iso")), Some("gc"));
        assert_eq!(sniff(&d.join("b.iso")), Some("wii"));
        assert_eq!(sniff(&d.join("c.iso")), Some("ps2"));
        assert_eq!(disc_serial(&d.join("c.iso")), Some("SLUS-21242".into()));
        assert_eq!(sniff(&d.join("d.iso")), Some("ps1"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn ps2_hash_is_made_like_pcsx2() {
        use md5::{Digest, Md5};
        let d = tmp("rahash");
        let mut iso = vec![0u8; 2048 * 24];
        let pvd = 16 * 2048;
        iso[pvd + 1..pvd + 6].copy_from_slice(b"CD001");
        iso[pvd + 156 + 2..pvd + 156 + 6].copy_from_slice(&20u32.to_le_bytes());
        iso[pvd + 156 + 10..pvd + 156 + 14].copy_from_slice(&2048u32.to_le_bytes());
        let mut rec = 20 * 2048;
        let cnf = b"BOOT2 = cdrom0:\SLUS_212.42;1\r\nVER = 1.00\r\n";
        let elf = b"\x7fELF the game";
        for (name, lba, size) in [(&b"SYSTEM.CNF;1"[..], 21u32, cnf.len()), (&b"SLUS_212.42;1"[..], 22, elf.len())] {
            iso[rec] = (33 + name.len() + 1) as u8;
            iso[rec + 2..rec + 6].copy_from_slice(&lba.to_le_bytes());
            iso[rec + 10..rec + 14].copy_from_slice(&(size as u32).to_le_bytes());
            iso[rec + 32] = name.len() as u8;
            iso[rec + 33..rec + 33 + name.len()].copy_from_slice(name);
            rec += 33 + name.len() + 1;
        }
        iso[21 * 2048..21 * 2048 + cnf.len()].copy_from_slice(cnf);
        iso[22 * 2048..22 * 2048 + elf.len()].copy_from_slice(elf);
        std::fs::write(d.join("g.iso"), &iso).unwrap();
        let mut want = Md5::new();
        want.update(b"SLUS_212.42");
        want.update(elf);
        assert_eq!(ps2_ra_hash(&d.join("g.iso")), Some(format!("{:x}", want.finalize())));
        assert_eq!(ps2_ra_hash(&d.join("nada.chd")), None);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_mixed_folder_sorts_itself_and_asks_the_rest() {
        let d = tmp("mixed");
        std::fs::write(d.join("Pokemon Emerald (USA).gba"), b"x").unwrap();
        std::fs::write(d.join("Crash (USA).cue"), "FILE \"Crash (USA).bin\" BINARY\n  TRACK 01 MODE2/2352\n").unwrap();
        std::fs::write(d.join("Crash (USA).bin"), vec![0u8; 64]).unwrap();
        std::fs::write(d.join("Mystery.chd"), b"not a chd").unwrap();
        std::fs::write(d.join("leia-me.txt"), b"x").unwrap();
        std::fs::create_dir_all(d.join("Demon's Souls").join("PS3_GAME").join("USRDIR")).unwrap();
        std::fs::write(d.join("Demon's Souls").join("PS3_GAME").join("USRDIR").join("EBOOT.BIN"), b"x").unwrap();
        let s = scan(&d, None);
        let systems: Vec<&str> = s.found.iter().map(|f| f.system).collect();
        assert!(systems.contains(&"gba") && systems.contains(&"ps3"), "{systems:?}");
        assert!(!s.found.iter().any(|f| f.file.ends_with(".bin")), "a .cue track is not a game");
        assert!(s.unknown.iter().any(|u| u.path.ends_with("Mystery.chd")));
        assert!(s.unknown.iter().any(|u| u.path.ends_with("Crash (USA).cue")), "an unreadable .cue is asked");
        let ps3 = s.found.iter().find(|f| f.system == "ps3").unwrap();
        assert_eq!(ps3.title, "Demon's Souls");
        // With the folder's console given, nothing is asked.
        let s = scan(&d, Some("ps1"));
        assert!(s.unknown.is_empty() && s.found.iter().any(|f| f.file == "Crash (USA).cue"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn multi_disc_games_count_once() {
        let d = tmp("discs");
        for n in 1..=3 {
            std::fs::write(d.join(format!("Final Fantasy VII (USA) (Disc {n}).chd")), b"x").unwrap();
        }
        let s = scan(&d, Some("ps1"));
        assert_eq!(s.found.len(), 1);
        assert_eq!(sibling_discs(&d.join("Final Fantasy VII (USA) (Disc 1).chd")).len(), 3);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn ids_stay_with_the_file() {
        let a = game_id("ps2", Path::new(r"D:\Jogos\GOW.iso"));
        assert_eq!(a, game_id("ps2", Path::new(r"d:\jogos\gow.ISO")));
        assert_ne!(a, game_id("ps2", Path::new(r"D:\Jogos\GOW2.iso")));
        assert!(a.starts_with("emu-ps2-"));
    }

    #[test]
    fn serials_from_system_cnf() {
        assert_eq!(serial_from_cnf("BOOT2 = cdrom0:\\SLUS_209.46;1\r\nVER = 1.00"), Some("SLUS-20946".into()));
        assert_eq!(serial_from_cnf("BOOT = cdrom:\\SCUS_941.63;1"), Some("SCUS-94163".into()));
        assert_eq!(serial_from_cnf("BOOT2 = cdrom0:\\GAME.ELF;1"), None);
    }
}
