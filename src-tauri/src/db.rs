//! SQLite storage. Append-only: each message and each canvas section is one row, written once,
//! so saving costs the same at turn 1 and turn 500. Full-text search runs on an FTS5 index.

use rusqlite::{params, Connection, OptionalExtension, Params, Row};
use serde_json::{json, Value};

pub type Res<T> = Result<T, String>;
pub fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY, folder_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
  title TEXT NOT NULL, bookmarked INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT '', compact_from INTEGER NOT NULL DEFAULT 0, compact_state TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS messages (
  lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE, seq INTEGER NOT NULL, body TEXT NOT NULL,
  PRIMARY KEY (lesson_id, seq)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS tool_results (
  lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE, tool_id TEXT NOT NULL, body TEXT NOT NULL,
  PRIMARY KEY (lesson_id, tool_id)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS sections (
  id INTEGER PRIMARY KEY, lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE, markdown TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS sections_by_lesson ON sections(lesson_id, id);
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY, folder_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
  lesson_id INTEGER REFERENCES lessons(id) ON DELETE CASCADE, name TEXT NOT NULL, body TEXT NOT NULL, words INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY, lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  provider TEXT NOT NULL, model TEXT NOT NULL, input INTEGER NOT NULL, cache_read INTEGER NOT NULL,
  cache_write INTEGER NOT NULL, output INTEGER NOT NULL, cost REAL, ms INTEGER NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS turns_by_lesson ON turns(lesson_id, id);
CREATE VIRTUAL TABLE IF NOT EXISTS sections_fts USING fts5(markdown, content='sections', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS sections_ai AFTER INSERT ON sections BEGIN
  INSERT INTO sections_fts(rowid, markdown) VALUES (new.id, new.markdown); END;
CREATE TRIGGER IF NOT EXISTS sections_ad AFTER DELETE ON sections BEGIN
  INSERT INTO sections_fts(sections_fts, rowid, markdown) VALUES ('delete', old.id, old.markdown); END;
CREATE TABLE IF NOT EXISTS parts (
  id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, label TEXT NOT NULL, body TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS parts_by_source ON parts(source_id, seq);
CREATE VIRTUAL TABLE IF NOT EXISTS parts_fts USING fts5(body, content='parts', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS parts_ai AFTER INSERT ON parts BEGIN
  INSERT INTO parts_fts(rowid, body) VALUES (new.id, new.body); END;
CREATE TRIGGER IF NOT EXISTS parts_ad AFTER DELETE ON parts BEGIN
  INSERT INTO parts_fts(parts_fts, rowid, body) VALUES ('delete', old.id, old.body); END;";

pub fn open(path: &std::path::Path) -> rusqlite::Result<Connection> {
    let c = Connection::open(path)?;
    c.pragma_update(None, "journal_mode", "WAL")?;
    c.pragma_update(None, "synchronous", "NORMAL")?;
    c.pragma_update(None, "foreign_keys", "ON")?;
    migrate(&c)?;
    Ok(c)
}

fn migrate(c: &Connection) -> rusqlite::Result<()> {
    let version: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version >= 2 {
        c.execute_batch(SCHEMA)?; // idempotent: adds tables introduced since (e.g. turns)
        add_lesson_columns(c)?;
        if version < 3 {
            subjects(c)?;
        }
        return if version < 4 { slim(c) } else { Ok(()) };
    }
    // version 1 kept each lesson as one JSON blob; carry those lessons over
    let v1 = c.query_row("SELECT COUNT(*) FROM pragma_table_info('lessons') WHERE name = 'data'", [], |r| r.get::<_, i64>(0))? > 0;
    let tx = c.unchecked_transaction()?;
    if v1 {
        tx.execute_batch("ALTER TABLE lessons RENAME TO lessons_v1;")?;
    }
    tx.execute_batch(SCHEMA)?;
    if v1 {
        let old: Vec<(String, i64, String)> = {
            let mut q = tx.prepare("SELECT title, updated, data FROM lessons_v1")?;
            let rows = q.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
            rows.collect::<Result<_, _>>()?
        };
        for (title, updated, data) in old {
            tx.execute("INSERT INTO lessons (title, updated) VALUES (?1, ?2)", params![title, updated])?;
            let id = tx.last_insert_rowid();
            let d: Value = serde_json::from_str(&data).unwrap_or_default();
            for (seq, m) in d["messages"].as_array().into_iter().flatten().enumerate() {
                tx.execute("INSERT INTO messages VALUES (?1, ?2, ?3)", params![id, seq as i64, m.to_string()])?;
            }
            for s in d["canvas"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                tx.execute("INSERT INTO sections (lesson_id, markdown) VALUES (?1, ?2)", params![id, s])?;
            }
        }
        tx.execute_batch("DROP TABLE lessons_v1;")?;
    }
    tx.pragma_update(None, "user_version", 2)?;
    tx.commit()?;
    add_lesson_columns(c)?;
    subjects(c)?;
    slim(c)
}

/// Version 4: material is kept once, as its parts; the copy in `sources.body` goes, and the space it
/// took is given back.
fn slim(c: &Connection) -> rusqlite::Result<()> {
    c.execute_batch("UPDATE sources SET body = '' WHERE EXISTS (SELECT 1 FROM parts WHERE source_id = sources.id); PRAGMA user_version = 4;")?;
    c.execute_batch("VACUUM;")
}

/// A source's whole text: its parts in order (older rows may still hold it in `body`).
pub const SOURCE_TEXT: &str = "COALESCE(NULLIF(s.body, ''), (SELECT group_concat(body, char(10) || char(10) ORDER BY seq) FROM parts WHERE source_id = s.id), '')";

/// Version 3: every lesson belongs to a subject (a top-level folder), and material is split into parts.
fn subjects(c: &Connection) -> rusqlite::Result<()> {
    let tx = c.unchecked_transaction()?;
    let loose: Vec<(i64, String, Option<String>)> = {
        let mut q = tx.prepare("SELECT id, title, (SELECT body FROM messages WHERE lesson_id = lessons.id ORDER BY seq LIMIT 1) FROM lessons WHERE folder_id IS NULL")?;
        let rows = q.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        rows.collect::<Result<_, _>>()?
    };
    for (id, mut title, first) in loose {
        // titles used to be cut at 60 characters; the first message still has the whole line
        let first = first.and_then(|b| serde_json::from_str::<Value>(&b).ok()).and_then(|m| m["content"].as_str().map(|t| t.lines().next().unwrap_or_default().trim().to_owned()));
        if let Some(full) = first.filter(|f| title.chars().count() == 60 && f.starts_with(&title)) {
            title = full;
            tx.execute("UPDATE lessons SET title = ?2 WHERE id = ?1", params![id, title])?;
        }
        tx.execute("INSERT INTO folders (name) VALUES (?1)", [&title])?;
        tx.execute("UPDATE lessons SET folder_id = ?2 WHERE id = ?1", params![id, tx.last_insert_rowid()])?;
    }
    let unsplit: Vec<(i64, String)> = {
        let mut q = tx.prepare("SELECT id, body FROM sources WHERE NOT EXISTS (SELECT 1 FROM parts WHERE source_id = sources.id)")?;
        let rows = q.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<Result<_, _>>()?
    };
    for (id, body) in unsplit {
        add_parts(&tx, id, &body)?;
    }
    tx.pragma_update(None, "user_version", 3)?;
    tx.commit()
}

pub fn add_parts(c: &Connection, source: i64, body: &str) -> rusqlite::Result<()> {
    let mut q = c.prepare_cached("INSERT INTO parts (source_id, seq, label, body) VALUES (?1, ?2, ?3, ?4)")?;
    for (seq, (label, text)) in crate::material::chunk(body).into_iter().enumerate() {
        q.execute(params![source, seq as i64 + 1, label, text])?;
    }
    Ok(())
}

/// Columns added in place to databases created before them.
fn add_lesson_columns(c: &Connection) -> rusqlite::Result<()> {
    let added = [
        ("lessons", "state", "TEXT NOT NULL DEFAULT ''"),
        ("lessons", "compact_from", "INTEGER NOT NULL DEFAULT 0"),
        ("lessons", "compact_state", "TEXT NOT NULL DEFAULT ''"),
        ("sources", "file", "TEXT NOT NULL DEFAULT ''"),
        ("folders", "notes", "TEXT NOT NULL DEFAULT ''"),
        ("lessons", "dir", "TEXT NOT NULL DEFAULT ''"),
    ];
    for (table, col, decl) in added {
        let has: i64 = c.query_row(&format!("SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = ?1"), [col], |r| r.get(0))?;
        if has == 0 {
            c.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {col} {decl};"))?;
        }
    }
    Ok(())
}

/// The tutor's lesson state, and where (and with which state snapshot) the history was last cut.
pub struct Compaction {
    pub state: String,
    pub from: usize,
    pub snapshot: String,
}

pub fn compaction(c: &Connection, lesson: i64) -> Res<Compaction> {
    c.query_row("SELECT state, compact_from, compact_state FROM lessons WHERE id = ?1", [lesson], |r| {
        Ok(Compaction { state: r.get(0)?, from: r.get::<_, i64>(1)? as usize, snapshot: r.get(2)? })
    })
    .map_err(err)
}

pub fn last_provider(c: &Connection, lesson: i64) -> Res<Option<String>> {
    c.query_row("SELECT provider FROM turns WHERE lesson_id = ?1 ORDER BY id DESC LIMIT 1", [lesson], |r| r.get(0)).optional().map_err(err)
}

pub fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

pub fn rows<P: Params>(c: &Connection, sql: &str, p: P, f: impl FnMut(&Row) -> rusqlite::Result<Value>) -> Res<Vec<Value>> {
    let mut q = c.prepare_cached(sql).map_err(err)?;
    let out = q.query_map(p, f).map_err(err)?.collect::<Result<_, _>>().map_err(err);
    out
}

pub fn exec<P: Params>(c: &Connection, sql: &str, p: P) -> Res<usize> {
    c.prepare_cached(sql).and_then(|mut q| q.execute(p)).map_err(err)
}

/// Everything the sidebar shows, in one round trip.
pub fn tree(c: &Connection) -> Res<Value> {
    let folders = rows(c, "SELECT id, parent_id, name FROM folders ORDER BY name COLLATE NOCASE", [], |r| {
        Ok(json!({ "id": r.get::<_, i64>(0)?, "parent": r.get::<_, Option<i64>>(1)?, "name": r.get::<_, String>(2)? }))
    })?;
    let lessons = rows(c, "SELECT id, folder_id, title, bookmarked, updated FROM lessons ORDER BY updated DESC", [], |r| {
        Ok(json!({ "id": r.get::<_, i64>(0)?, "folder": r.get::<_, Option<i64>>(1)?, "title": r.get::<_, String>(2)?,
                   "bookmarked": r.get::<_, bool>(3)?, "updated": r.get::<_, i64>(4)? }))
    })?;
    let sources = rows(c, "SELECT id, folder_id, lesson_id, name, words FROM sources ORDER BY name COLLATE NOCASE", [], |r| {
        Ok(json!({ "id": r.get::<_, i64>(0)?, "folder": r.get::<_, Option<i64>>(1)?, "lesson": r.get::<_, Option<i64>>(2)?,
                   "name": r.get::<_, String>(3)?, "words": r.get::<_, i64>(4)? }))
    })?;
    Ok(json!({ "folders": folders, "lessons": lessons, "sources": sources }))
}

pub fn messages(c: &Connection, lesson: i64) -> Res<Vec<Value>> {
    let mut q = c.prepare_cached("SELECT body FROM messages WHERE lesson_id = ?1 ORDER BY seq").map_err(err)?;
    let out = q
        .query_map([lesson], |r| r.get::<_, String>(0))
        .map_err(err)?
        .map(|s| s.map_err(err).and_then(|s| serde_json::from_str(&s).map_err(err)))
        .collect();
    out
}

pub fn append_message(c: &Connection, lesson: i64, seq: usize, msg: &Value) -> Res<()> {
    exec(c, "INSERT INTO messages (lesson_id, seq, body) VALUES (?1, ?2, ?3)", params![lesson, seq as i64, msg.to_string()])?;
    exec(c, "UPDATE lessons SET updated = ?2 WHERE id = ?1", params![lesson, now()])?;
    Ok(())
}

pub fn save_tool_result(c: &Connection, lesson: i64, result: &Value) -> Res<()> {
    let id = result["tool_use_id"].as_str().ok_or("Missing tool call ID")?;
    exec(c, "INSERT OR REPLACE INTO tool_results VALUES (?1, ?2, ?3)", params![lesson, id, result.to_string()])?;
    Ok(())
}

pub fn tool_results(c: &Connection, lesson: i64) -> Res<Value> {
    let mut out = serde_json::Map::new();
    let mut q = c.prepare("SELECT tool_id, body FROM tool_results WHERE lesson_id = ?1").map_err(err)?;
    let rows = q.query_map([lesson], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(err)?;
    for row in rows {
        let (id, body) = row.map_err(err)?;
        out.insert(id, serde_json::from_str(&body).map_err(err)?);
    }
    Ok(Value::Object(out))
}

pub fn next_seq(c: &Connection, lesson: i64) -> Res<usize> {
    c.query_row("SELECT COALESCE(MAX(seq) + 1, 0) FROM messages WHERE lesson_id = ?1", [lesson], |r| r.get::<_, i64>(0))
        .map(|n| n as usize)
        .map_err(err)
}

/// The material the tutor teaches from: the lesson's own sources plus those of every folder above it.
pub fn sources_for(c: &Connection, lesson: i64) -> Res<Vec<(String, String)>> {
    let mut q = c.prepare_cached(&format!("{MATERIAL} SELECT s.name, {SOURCE_TEXT} FROM mine s ORDER BY s.id")).map_err(err)?;
    let out = q.query_map([lesson], |r| Ok((r.get(0)?, r.get(1)?))).map_err(err)?.collect::<Result<_, _>>().map_err(err);
    out
}

/// The material a lesson is taught from: its own and its folders', as (id, name, words, file, part labels).
pub fn material_index(c: &Connection, lesson: i64) -> Res<Vec<(i64, String, i64, String, Vec<String>)>> {
    let mut q = c
        .prepare_cached(&format!("{MATERIAL} SELECT s.id, s.name, s.words, s.file, (SELECT json_group_array(label) FROM (SELECT label FROM parts WHERE source_id = s.id ORDER BY seq)) FROM mine s ORDER BY s.id"))
        .map_err(err)?;
    let out = q
        .query_map([lesson], |r| {
            let labels: String = r.get(4)?;
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, serde_json::from_str(&labels).unwrap_or_default()))
        })
        .map_err(err)?
        .collect::<Result<_, _>>()
        .map_err(err);
    out
}

/// The lesson's material, for the recursive queries below.
const MATERIAL: &str = "WITH RECURSIVE up(id) AS (
    SELECT folder_id FROM lessons WHERE id = ?1
    UNION ALL SELECT f.parent_id FROM folders f JOIN up ON f.id = up.id WHERE f.parent_id IS NOT NULL),
  mine AS (SELECT * FROM sources WHERE lesson_id = ?1 OR folder_id IN (SELECT id FROM up))";

/// Full-text search over the lesson's material: the best parts, with a snippet each.
pub fn search_parts(c: &Connection, lesson: i64, query: &str) -> Res<Vec<Value>> {
    // quote each word so FTS syntax in the query can't fail it; any word may match, best first
    let q: Vec<String> = query.split_whitespace().map(|w| format!("\"{}\"", w.replace('"', ""))).collect();
    if q.is_empty() {
        return Ok(vec![]);
    }
    rows(
        c,
        &format!("{MATERIAL} SELECT s.id, s.name, p.seq, p.label, snippet(parts_fts, 0, '**', '**', ' … ', 40)
           FROM parts_fts JOIN parts p ON p.id = parts_fts.rowid JOIN mine s ON s.id = p.source_id
           WHERE parts_fts MATCH ?2 ORDER BY rank LIMIT 6"),
        params![lesson, q.join(" OR ")],
        |r| Ok(json!({ "material": r.get::<_, i64>(0)?, "name": r.get::<_, String>(1)?, "part": r.get::<_, i64>(2)?,
                       "label": r.get::<_, String>(3)?, "snippet": r.get::<_, String>(4)? })),
    )
}

/// One part of the lesson's material, with how many parts that material has.
pub fn read_part(c: &Connection, lesson: i64, source: i64, part: i64) -> Res<Option<(String, String, String, i64)>> {
    c.query_row(
        &format!("{MATERIAL} SELECT s.name, p.label, p.body, (SELECT COUNT(*) FROM parts WHERE source_id = s.id)
           FROM parts p JOIN mine s ON s.id = p.source_id WHERE s.id = ?2 AND p.seq = ?3"),
        params![lesson, source, part],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )
    .optional()
    .map_err(err)
}

/// Files written for material in `folder` and everything beneath it.
pub fn files_within(c: &Connection, folder: i64) -> Res<Vec<String>> {
    let mut q = c
        .prepare_cached(
            "WITH RECURSIVE down(id) AS (SELECT ?1 UNION ALL SELECT f.id FROM folders f JOIN down ON f.parent_id = down.id)
             SELECT file FROM sources WHERE folder_id IN (SELECT id FROM down)
                OR lesson_id IN (SELECT id FROM lessons WHERE folder_id IN (SELECT id FROM down))",
        )
        .map_err(err)?;
    let out = q.query_map([folder], |r| r.get(0)).map_err(err)?.collect::<Result<_, _>>().map_err(err);
    out
}

/// The subject (top-level folder) a lesson belongs to: its id, name and the tutor's notes on it.
pub fn subject_of_lesson(c: &Connection, lesson: i64) -> Res<Option<(i64, String, String)>> {
    c.query_row(
        "WITH RECURSIVE up(id, parent) AS (SELECT f.id, f.parent_id FROM folders f JOIN lessons l ON l.folder_id = f.id WHERE l.id = ?1
           UNION ALL SELECT f.id, f.parent_id FROM folders f JOIN up ON f.id = up.parent)
         SELECT f.id, f.name, f.notes FROM up JOIN folders f ON f.id = up.id WHERE up.parent IS NULL",
        [lesson],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
    .optional()
    .map_err(err)
}

/// The top-level folder (the subject) that `folder` sits in.
pub fn subject_of(c: &Connection, folder: i64) -> Res<String> {
    c.query_row(
        "WITH RECURSIVE up(id, parent, name) AS (SELECT id, parent_id, name FROM folders WHERE id = ?1
           UNION ALL SELECT f.id, f.parent_id, f.name FROM folders f JOIN up ON f.id = up.parent)
         SELECT name FROM up WHERE parent IS NULL",
        [folder],
        |r| r.get(0),
    )
    .map_err(err)
}

/// True if `target` is `folder` itself or somewhere beneath it (moving `folder` there would make a loop).
pub fn is_within(c: &Connection, target: i64, folder: i64) -> Res<bool> {
    c.query_row(
        "WITH RECURSIVE down(id) AS (SELECT ?1 UNION ALL SELECT f.id FROM folders f JOIN down ON f.parent_id = down.id)
         SELECT EXISTS(SELECT 1 FROM down WHERE id = ?2)",
        params![folder, target],
        |r| r.get(0),
    )
    .map_err(err)
}

pub fn record_turn(c: &Connection, lesson: i64, provider: &str, u: &crate::llm::Usage) -> Res<()> {
    exec(
        c,
        "INSERT INTO turns (lesson_id, provider, model, input, cache_read, cache_write, output, cost, ms, at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![lesson, provider, u.model, u.input as i64, u.cache_read as i64, u.cache_write as i64, u.output as i64, u.cost, u.ms as i64, now()],
    )
    .map(drop)
}

/// Totals for a lesson plus its latest turn (the current context size and cache hit rate).
pub fn lesson_stats(c: &Connection, lesson: i64) -> Res<Value> {
    let totals = c
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(input + cache_read + cache_write), 0), COALESCE(SUM(output), 0), SUM(cost)
             FROM turns WHERE lesson_id = ?1",
            [lesson],
            |r| Ok(json!({ "turns": r.get::<_, i64>(0)?, "input": r.get::<_, i64>(1)?, "output": r.get::<_, i64>(2)?, "cost": r.get::<_, Option<f64>>(3)? })),
        )
        .map_err(err)?;
    let last = c
        .query_row(
            "SELECT provider, model, input, cache_read, cache_write, output FROM turns WHERE lesson_id = ?1 ORDER BY id DESC LIMIT 1",
            [lesson],
            |r| Ok(json!({ "provider": r.get::<_, String>(0)?, "model": r.get::<_, String>(1)?, "input": r.get::<_, i64>(2)?,
                           "cache_read": r.get::<_, i64>(3)?, "cache_write": r.get::<_, i64>(4)?, "output": r.get::<_, i64>(5)? })),
        )
        .optional()
        .map_err(err)?;
    Ok(json!({ "totals": totals, "last": last }))
}

pub fn lesson(c: &Connection, id: i64) -> Res<Value> {
    let (title, folder, state): (String, Option<i64>, String) = c
        .query_row("SELECT title, folder_id, state FROM lessons WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(err)?;
    let sections = rows(c, "SELECT markdown FROM sections WHERE lesson_id = ?1 ORDER BY id", [id], |r| Ok(Value::String(r.get(0)?)))?;
    Ok(json!({ "id": id, "title": title, "folder": folder, "state": state, "sections": sections }))
}

/// Lessons whose title or content matches; snippets mark hits with \u{1}…\u{2}.
pub fn search(c: &Connection, query: &str) -> Res<Vec<Value>> {
    let terms: Vec<String> = query.split_whitespace().map(|t| format!("\"{}\"*", t.replace('"', ""))).collect();
    if terms.is_empty() {
        return Ok(vec![]);
    }
    let mut seen = std::collections::HashSet::new();
    let mut out = rows(c, "SELECT id, title FROM lessons WHERE title LIKE ?1 ORDER BY updated DESC LIMIT 20", [format!("%{}%", query.trim())], |r| {
        Ok(json!({ "id": r.get::<_, i64>(0)?, "title": r.get::<_, String>(1)?, "snippet": "" }))
    })?;
    out.extend(rows(
        c,
        "SELECT l.id, l.title, snippet(sections_fts, 0, char(1), char(2), '…', 14)
         FROM sections_fts JOIN sections s ON s.id = sections_fts.rowid JOIN lessons l ON l.id = s.lesson_id
         WHERE sections_fts MATCH ?1 ORDER BY rank LIMIT 60",
        [terms.join(" ")],
        |r| Ok(json!({ "id": r.get::<_, i64>(0)?, "title": r.get::<_, String>(1)?, "snippet": r.get::<_, String>(2)? })),
    )?);
    out.retain(|v| seen.insert(v["id"].as_i64()));
    out.truncate(30);
    Ok(out)
}

pub fn setting(c: &Connection) -> Res<Value> {
    let v: Option<String> = c.query_row("SELECT value FROM settings WHERE key = 'app'", [], |r| r.get(0)).optional().map_err(err)?;
    Ok(v.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate(&c).unwrap();
        c
    }

    #[test]
    fn completed_tools_survive_reopening_and_cascade_with_lesson() {
        let c = mem();
        c.execute("INSERT INTO lessons (id, title, updated) VALUES (1, 'Test', 0)", []).unwrap();
        let result = json!({ "type": "tool_result", "tool_use_id": "call-1", "content": "Added" });
        save_tool_result(&c, 1, &result).unwrap();
        save_tool_result(&c, 1, &result).unwrap();
        assert_eq!(tool_results(&c, 1).unwrap()["call-1"], result);
        assert_eq!(tool_results(&c, 1).unwrap().as_object().unwrap().len(), 1);
        c.execute("DELETE FROM lessons WHERE id = 1", []).unwrap();
        assert_eq!(tool_results(&c, 1).unwrap(), json!({}));
    }

    #[test]
    fn sources_come_from_lesson_and_every_parent_folder() {
        let c = mem();
        c.execute_batch(
            "INSERT INTO folders (id, parent_id, name) VALUES (1, NULL, 'Cloud'), (2, 1, 'Terraform'), (3, NULL, 'Other');
             INSERT INTO lessons (id, folder_id, title, updated) VALUES (1, 2, 'State', 0);
             INSERT INTO sources (folder_id, lesson_id, name, body, words) VALUES
               (1, NULL, 'top', 'a', 1), (2, NULL, 'mid', 'b', 1), (NULL, 1, 'own', 'c', 1), (3, NULL, 'unrelated', 'd', 1);",
        )
        .unwrap();
        let names: Vec<String> = sources_for(&c, 1).unwrap().into_iter().map(|(n, _)| n).collect();
        assert_eq!(names, ["top", "mid", "own"]);
    }

    #[test]
    fn material_is_searched_and_read_only_within_the_lesson() {
        let c = mem();
        c.execute_batch(
            "INSERT INTO folders (id, parent_id, name) VALUES (1, NULL, 'Somali'), (2, NULL, 'Other');
             INSERT INTO lessons (id, folder_id, title, updated) VALUES (1, 1, 'Greetings', 0);
             INSERT INTO sources (id, folder_id, name, body, words) VALUES (1, 1, 'Grammar', '', 0), (2, 2, 'Elsewhere', '', 0);",
        )
        .unwrap();
        add_parts(&c, 1, "[page 4]\n\n# Greetings\n\nIska warran means how are you.").unwrap();
        add_parts(&c, 2, "Iska warran appears here too.").unwrap();
        let hits = search_parts(&c, 1, "warran \"AND").unwrap(); // stray FTS syntax is harmless
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0]["label"], "p. 4 · Greetings");
        assert!(read_part(&c, 1, 1, 1).unwrap().unwrap().2.contains("how are you"));
        assert!(read_part(&c, 1, 2, 1).unwrap().is_none(), "another subject's material is out of reach");
        assert_eq!(material_index(&c, 1).unwrap()[0].4, ["p. 4 · Greetings"]);
        assert!(sources_for(&c, 1).unwrap()[0].1.contains("how are you"), "the text comes back from its parts");
        c.execute("DELETE FROM sources WHERE id = 1", []).unwrap();
        assert!(search_parts(&c, 1, "warran").unwrap().is_empty());
    }

    #[test]
    fn loose_lessons_become_subjects_with_their_full_title() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(SCHEMA).unwrap();
        c.pragma_update(None, "user_version", 2).unwrap();
        let long = "Teach me about electrical engineering, I'm starting from scratch please";
        let cut: String = long.chars().take(60).collect();
        c.execute("INSERT INTO lessons (id, title, updated) VALUES (1, ?1, 0)", [&cut]).unwrap();
        c.execute("INSERT INTO messages VALUES (1, 0, ?1)", [json!({ "role": "user", "content": long }).to_string()]).unwrap();
        migrate(&c).unwrap();
        let (title, folder): (String, String) = c.query_row("SELECT l.title, f.name FROM lessons l JOIN folders f ON f.id = l.folder_id", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((title.as_str(), folder.as_str()), (long, long));
    }

    #[test]
    fn deleting_a_folder_removes_everything_inside_and_the_search_index() {
        let c = mem();
        c.execute_batch(
            "INSERT INTO folders (id, parent_id, name) VALUES (1, NULL, 'Cloud'), (2, 1, 'Terraform');
             INSERT INTO lessons (id, folder_id, title, updated) VALUES (1, 2, 'State', 0);
             INSERT INTO sections (lesson_id, markdown) VALUES (1, 'plan refreshes the state');",
        )
        .unwrap();
        append_message(&c, 1, 0, &json!({ "role": "user", "content": "hi" })).unwrap();
        assert_eq!(search(&c, "refresh").unwrap().len(), 1);
        exec(&c, "DELETE FROM folders WHERE id = 1", []).unwrap();
        let count = |t: &str| c.query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get::<_, i64>(0)).unwrap();
        assert_eq!((count("folders"), count("lessons"), count("messages"), count("sections")), (0, 0, 0, 0));
        assert!(search(&c, "refresh").unwrap().is_empty());
    }

    #[test]
    fn a_folder_cannot_move_into_its_own_subtree() {
        let c = mem();
        c.execute_batch("INSERT INTO folders (id, parent_id, name) VALUES (1, NULL, 'a'), (2, 1, 'b'), (3, 2, 'c'), (4, NULL, 'd');").unwrap();
        assert!(is_within(&c, 3, 1).unwrap() && is_within(&c, 1, 1).unwrap());
        assert!(!is_within(&c, 4, 1).unwrap() && !is_within(&c, 1, 3).unwrap());
    }

    #[test]
    fn turns_add_up_per_lesson() {
        let c = mem();
        c.execute_batch("INSERT INTO lessons (id, title, updated) VALUES (1, 'L', 0);").unwrap();
        let mut u = crate::llm::Usage { model: "m".into(), input: 100, cache_read: 900, output: 50, cost: Some(0.01), ..Default::default() };
        record_turn(&c, 1, "claude-code", &u).unwrap();
        u.cost = None;
        record_turn(&c, 1, "claude-code", &u).unwrap();
        let s = lesson_stats(&c, 1).unwrap();
        assert_eq!((s["totals"]["turns"].as_i64(), s["totals"]["input"].as_i64(), s["totals"]["cost"].as_f64()), (Some(2), Some(2000), Some(0.01)));
        assert_eq!(s["last"]["cache_read"], 900);
    }

    #[test]
    fn lesson_state_columns_are_added_to_older_databases() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(&SCHEMA.replace(
            ",\n  state TEXT NOT NULL DEFAULT '', compact_from INTEGER NOT NULL DEFAULT 0, compact_state TEXT NOT NULL DEFAULT '')",
            ")",
        ))
        .unwrap();
        c.pragma_update(None, "user_version", 2).unwrap();
        c.execute_batch("INSERT INTO lessons (id, title, updated) VALUES (1, 'Old', 0);").unwrap();
        migrate(&c).unwrap();
        let k = compaction(&c, 1).unwrap();
        assert_eq!((k.state.as_str(), k.from), ("", 0));
    }

    #[test]
    fn migrates_v1_blob_lessons() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE lessons (id TEXT PRIMARY KEY, title TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL);
             INSERT INTO lessons VALUES ('x', 'Old', '{\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"canvas\":[\"# Old\"]}', 5);",
        )
        .unwrap();
        migrate(&c).unwrap();
        assert_eq!(messages(&c, 1).unwrap()[0]["content"], "hi");
        assert_eq!(lesson(&c, 1).unwrap()["sections"][0], "# Old");
    }
}
