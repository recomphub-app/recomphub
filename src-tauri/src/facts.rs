//! A port's facts sheet, from its GitHub project: stars, open problems, license, how many
//! versions and downloads, the newest version (date and size of the Windows file) and what
//! changed in the last versions. Two requests per project, kept on disk for 6 hours; when
//! GitHub does not answer, the last sheet is shown.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::github;

const FRESH_FOR: u64 = 6 * 3600;
/// Versions whose notes are kept ("Atualizações" on the port page).
const NOTES: usize = 8;
const NOTE_CHARS: usize = 4000;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Note {
    pub tag: String,
    pub published: u64,
    pub body: String,
}

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
pub struct Facts {
    pub fetched_at: u64,
    pub stars: u64,
    pub open_issues: u64,
    pub license: Option<String>,
    pub pushed: Option<u64>,
    pub releases: u32,
    /// Every download of every file of every version.
    pub downloads: u64,
    pub first_release: Option<u64>,
    pub latest_tag: Option<String>,
    pub latest_published: Option<u64>,
    /// Size of the newest version's Windows file, in bytes.
    pub latest_size: Option<u64>,
    pub notes: Vec<Note>,
}

#[derive(Deserialize)]
struct RepoJson {
    #[serde(default)]
    stargazers_count: u64,
    #[serde(default)]
    open_issues_count: u64,
    #[serde(default)]
    license: Option<LicenseJson>,
    #[serde(default)]
    pushed_at: Option<String>,
}

#[derive(Deserialize)]
struct LicenseJson {
    #[serde(default)]
    spdx_id: Option<String>,
}

#[derive(Deserialize)]
pub struct ReleaseJson {
    pub tag_name: String,
    #[serde(default)]
    pub draft: bool,
    #[serde(default)]
    pub prerelease: bool,
    #[serde(default)]
    pub published_at: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub assets: Vec<AssetJson>,
}

#[derive(Deserialize)]
pub struct AssetJson {
    pub name: String,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub download_count: u64,
}

/// The sheet's release part from GitHub's list (newest first).
pub fn from_releases(list: &[ReleaseJson]) -> Facts {
    let shown: Vec<&ReleaseJson> = list.iter().filter(|r| !r.draft).collect();
    let stable = shown.iter().find(|r| !r.prerelease).or(shown.first());
    let time = |r: &ReleaseJson| r.published_at.as_deref().and_then(github::parse_time);
    Facts {
        releases: shown.len() as u32,
        downloads: shown.iter().flat_map(|r| &r.assets).map(|a| a.download_count).sum(),
        first_release: shown.iter().filter_map(|r| time(r)).min(),
        latest_tag: stable.map(|r| r.tag_name.clone()),
        latest_published: stable.and_then(|r| time(r)),
        latest_size: stable.and_then(|r| {
            r.assets
                .iter()
                .filter_map(|a| crate::community::windows_rank(&a.name).map(|rank| (rank, a.size)))
                .min_by_key(|(rank, _)| *rank)
                .map(|(_, size)| size)
        }),
        // Test builds crowd the list in some projects: the stable versions' notes, when there are any.
        notes: shown
            .iter()
            .filter(|r| !r.prerelease || shown.iter().all(|s| s.prerelease))
            .take(NOTES)
            .map(|r| Note {
                tag: r.tag_name.clone(),
                published: time(r).unwrap_or(0),
                body: r.body.as_deref().unwrap_or("").trim().chars().take(NOTE_CHARS).collect(),
            })
            .collect(),
        ..Facts::default()
    }
}

fn file_for(dir: &Path, repo: &str) -> PathBuf {
    dir.join(format!("{}.json", repo.replace('/', "__")))
}

fn load(dir: &Path, repo: &str) -> Option<Facts> {
    std::fs::read(file_for(dir, repo)).ok().and_then(|b| serde_json::from_slice(&b).ok())
}

async fn fetch(repo: &str) -> Result<Facts, String> {
    let resp = github::api(&format!("https://api.github.com/repos/{repo}")).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(github::status_error(resp.status()));
    }
    let info: RepoJson = resp.json().await.map_err(|e| e.to_string())?;
    let resp = github::api(&format!("https://api.github.com/repos/{repo}/releases?per_page=100")).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(github::status_error(resp.status()));
    }
    let list: Vec<ReleaseJson> = resp.json().await.map_err(|e| e.to_string())?;
    let mut facts = from_releases(&list);
    facts.stars = info.stargazers_count;
    // GitHub counts pull requests as issues too; this is what its own page shows.
    facts.open_issues = info.open_issues_count;
    facts.license = info.license.and_then(|l| l.spdx_id).filter(|s| s != "NOASSERTION");
    facts.pushed = info.pushed_at.as_deref().and_then(github::parse_time);
    Ok(facts)
}

/// The sheet of `repo`, from disk when recent, from GitHub otherwise; the old one when GitHub
/// does not answer.
pub async fn get(dir: &Path, repo: &str) -> Result<Facts, String> {
    let now = crate::library::now();
    let saved = load(dir, repo);
    if let Some(f) = &saved {
        if now.saturating_sub(f.fetched_at) < FRESH_FOR {
            return Ok(f.clone());
        }
    }
    match fetch(repo).await {
        Ok(mut f) => {
            f.fetched_at = now;
            let _ = std::fs::create_dir_all(dir);
            let _ = std::fs::write(file_for(dir, repo), serde_json::to_vec(&f).unwrap_or_default());
            Ok(f)
        }
        Err(e) => saved.ok_or(e),
    }
}

/// The sheets already on disk, for the shelves (no request): repo -> sheet.
pub fn all_saved(dir: &Path) -> std::collections::HashMap<String, Facts> {
    let Ok(read) = std::fs::read_dir(dir) else { return Default::default() };
    read.flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().strip_suffix(".json")?.replacen("__", "/", 1);
            let f: Facts = serde_json::from_slice(&std::fs::read(e.path()).ok()?).ok()?;
            Some((name, f))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rel(tag: &str, when: &str, pre: bool, assets: &[(&str, u64, u64)]) -> ReleaseJson {
        ReleaseJson {
            tag_name: tag.into(),
            draft: false,
            prerelease: pre,
            published_at: Some(when.into()),
            body: Some(format!("  Mudanças da {tag}  ")),
            assets: assets.iter().map(|(n, s, d)| AssetJson { name: n.to_string(), size: *s, download_count: *d }).collect(),
        }
    }

    #[test]
    fn sheet_from_releases() {
        let list = vec![
            rel("v3.0-beta", "2026-10-25T10:00:00Z", true, &[("port-windows.zip", 90, 5)]),
            rel("v2.7", "2026-10-22T10:00:00Z", false, &[("port-linux.AppImage", 80, 40), ("port-windows.zip", 76, 500)]),
            rel("v1.0", "2026-10-10T10:00:00Z", false, &[("port-windows.zip", 70, 1000)]),
        ];
        let f = from_releases(&list);
        assert_eq!(f.releases, 3);
        assert_eq!(f.downloads, 1545);
        assert_eq!(f.latest_tag.as_deref(), Some("v2.7"));
        assert_eq!(f.latest_size, Some(76));
        assert_eq!(f.first_release, github::parse_time("2026-10-10T10:00:00Z"));
        assert_eq!(f.notes.len(), 2);
        assert_eq!(f.notes[0].tag, "v2.7");
        assert_eq!(f.notes[0].body, "Mudanças da v2.7");
        // Only test builds: their notes are what there is.
        assert_eq!(from_releases(&list[..1]).notes[0].tag, "v3.0-beta");
        assert_eq!(from_releases(&[]).latest_tag, None);
    }
}
