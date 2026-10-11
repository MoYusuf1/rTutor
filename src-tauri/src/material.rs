//! The learner's material (textbooks, slides, transcripts, notes): turned into clean Markdown, split into
//! parts a tutor can search and read one at a time, and kept as a plain file in the subject's folder
//! (~/rlearn/<subject>/) so a terminal agent can open it too.

use crate::db::{err, Res};
use std::path::{Path, PathBuf};

/// Roughly how many words go in one part: a few pages, small enough to read in one tool call.
const PART: usize = 1200;

/// Text from a file as Markdown, as compact as it can be without losing content. PDFs keep `[page N]`
/// markers so the tutor can say where something comes from.
pub fn extract(path: &Path) -> Res<String> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase();
    let raw = if ext == "pdf" {
        let p = path.to_owned();
        // the PDF parser can panic on malformed files; keep that from taking the app down
        let pages = std::panic::catch_unwind(move || pdf_extract::extract_text_by_pages(&p))
            .map_err(|_| "This PDF couldn't be read.".to_owned())?
            .map_err(err)?;
        let mut out = String::new();
        for (i, page) in pages.iter().enumerate().filter(|(_, p)| !p.trim().is_empty()) {
            out.push_str(&format!("\n\n[page {}]\n\n{}", i + 1, page.trim()));
        }
        out
    } else {
        std::fs::read_to_string(path).map_err(|_| "Only PDF, text, Markdown and subtitle (.srt, .vtt) files can be added.".to_owned())?
    };
    let subtitles = matches!(ext.as_str(), "srt" | "vtt");
    let mut out = String::with_capacity(raw.len());
    let mut blank = 0;
    for line in raw.lines().map(str::trim_end) {
        // subtitle files: drop cue numbers, timestamps and the header, keep the words
        if subtitles && (line.contains("-->") || line == "WEBVTT" || line.trim().parse::<u32>().is_ok()) {
            continue;
        }
        blank = if line.trim().is_empty() { blank + 1 } else { 0 };
        if blank < 2 {
            out.push_str(line);
            out.push('\n');
        }
    }
    Ok(out.trim().to_owned())
}

fn page_of(line: &str) -> Option<u32> {
    line.trim().strip_prefix("[page ")?.strip_suffix(']')?.parse().ok()
}

/// Splits material into parts of about `PART` words, preferring to break at a heading or a blank line.
/// Each part gets a label: its pages (when known) and its first heading or line.
pub fn chunk(body: &str) -> Vec<(String, String)> {
    let mut parts = Vec::new();
    let (mut cur, mut words, mut pages) = (String::new(), 0, None::<(u32, u32)>);
    let mut page = None;
    let flush = |cur: &mut String, words: &mut usize, pages: &mut Option<(u32, u32)>, parts: &mut Vec<(String, String)>| {
        if *words > 0 {
            let title = cur
                .lines()
                .map(str::trim)
                .find(|l| !l.is_empty() && page_of(l).is_none())
                .unwrap_or_default()
                .trim_start_matches('#')
                .trim();
            let title: String = if title.chars().count() > 70 { format!("{}…", title.chars().take(70).collect::<String>().trim_end()) } else { title.to_owned() };
            let label = match *pages {
                Some((a, b)) if a == b => format!("p. {a} · {title}"),
                Some((a, b)) => format!("pp. {a}–{b} · {title}"),
                None => title,
            };
            parts.push((label, std::mem::take(cur).trim().to_owned()));
        }
        cur.clear();
        (*words, *pages) = (0, None);
    };
    for line in body.lines() {
        let heading = line.starts_with('#');
        let marker = page_of(line);
        let boundary = heading || marker.is_some() || line.trim().is_empty();
        if (boundary && (words >= PART || (heading && words >= PART / 4))) || words >= PART * 2 {
            flush(&mut cur, &mut words, &mut pages, &mut parts);
        }
        if let Some(n) = marker {
            page = Some(n);
        }
        let n = line.split_whitespace().count();
        if n > 0 && marker.is_none() {
            if let Some(p) = page {
                pages = Some(pages.map_or((p, p), |(a, _)| (a, p)));
            }
        }
        words += if marker.is_some() { 0 } else { n };
        cur.push_str(line);
        cur.push('\n');
    }
    flush(&mut cur, &mut words, &mut pages, &mut parts);
    parts
}

fn clean(name: &str) -> String {
    let s: String = name.chars().map(|c| if r#"/\:*?"<>|"#.contains(c) || c.is_control() { '-' } else { c }).collect();
    let s = s.trim().trim_matches('.').to_owned();
    if s.is_empty() { "Untitled".into() } else { s }
}

/// ~/rlearn/<subject>: where a subject's material lives as files.
pub fn subject_dir(subject: &str) -> PathBuf {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).unwrap_or_default();
    PathBuf::from(home).join("rlearn").join(clean(subject))
}

/// Writes material as Markdown into its subject's folder and returns the path. Never overwrites another file.
pub fn write_file(subject: &str, name: &str, body: &str) -> Res<PathBuf> {
    let dir = subject_dir(subject);
    std::fs::create_dir_all(&dir).map_err(err)?;
    let stem = clean(Path::new(name).file_stem().and_then(|s| s.to_str()).unwrap_or(name));
    let mut path = dir.join(format!("{stem}.md"));
    for n in 2.. {
        if !path.exists() {
            break;
        }
        path = dir.join(format!("{stem} ({n}).md"));
    }
    std::fs::write(&path, format!("# {name}\n\n{body}\n")).map_err(err)?;
    Ok(path)
}

/// A renamed subject takes its folder along.
pub fn rename_subject(old: &str, new: &str) {
    let (from, to) = (subject_dir(old), subject_dir(new));
    if from != to && from.is_dir() && !to.exists() {
        let _ = std::fs::rename(from, to);
    }
}

/// Removes material files rlearn wrote, and their folder once it's empty. Other files are left alone.
pub fn remove_files(files: &[String]) {
    for f in files.iter().filter(|f| !f.is_empty()) {
        let path = Path::new(f);
        let _ = std::fs::remove_file(path);
        if let Some(dir) = path.parent() {
            let _ = std::fs::remove_dir(dir); // fails unless empty
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parts_break_at_headings_and_carry_pages() {
        let mut body = String::from("[page 1]\n\n# Sounds\n\n");
        body.push_str(&"word ".repeat(400));
        body.push_str("\n\n[page 2]\n\n");
        body.push_str(&"more ".repeat(500));
        body.push_str("\n\n[page 3]\n\n# Grammar\n\nNouns have gender.\n");
        let parts = chunk(&body);
        assert_eq!(parts.len(), 2, "{parts:?}");
        assert_eq!(parts[0].0, "pp. 1–2 · Sounds");
        assert_eq!(parts[1].0, "p. 3 · Grammar");
        assert!(parts[1].1.contains("Nouns have gender."));
    }

    #[test]
    fn long_text_without_breaks_is_still_split() {
        let body = "a ".repeat(PART * 2) + "\n" + &"b ".repeat(PART * 2) + "\n" + &"c ".repeat(10);
        let parts = chunk(&body);
        assert_eq!(parts.len(), 3);
        assert!(parts.iter().all(|(label, _)| !label.is_empty()));
    }

    #[test]
    fn subtitles_keep_only_the_words() {
        let dir = std::env::temp_dir().join("learn-extract-test");
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("talk.srt");
        std::fs::write(&f, "1\n00:00:01,000 --> 00:00:02,000\nHello there\n\n\n\n2\n00:00:03,000 --> 00:00:04,000\nGeneral idea\n").unwrap();
        assert_eq!(extract(&f).unwrap(), "Hello there\n\nGeneral idea"); // runs of blank lines collapse to one
    }

    /// Timing on a real file: SOURCE=/path/to/file.pdf cargo test -- --ignored --nocapture
    #[test]
    #[ignore]
    fn extract_real_file() {
        let path = std::env::var("SOURCE").unwrap();
        let t = std::time::Instant::now();
        let text = extract(Path::new(&path)).unwrap();
        let parts = chunk(&text);
        println!("{} words, {} parts in {:?}", text.split_whitespace().count(), parts.len(), t.elapsed());
        for (label, _) in parts.iter().take(8) {
            println!("  {label}");
        }
    }
}
