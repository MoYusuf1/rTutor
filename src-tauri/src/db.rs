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
  title TEXT NOT NULL, bookmarked INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS messages (
  lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE, seq INTEGER NOT NULL, body TEXT NOT NULL,
  PRIMARY KEY (lesson_id, seq)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS sections (
  id INTEGER PRIMARY KEY, lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE, markdown TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS sections_by_lesson ON sections(lesson_id, id);
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY, folder_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
  lesson_id INTEGER REFERENCES lessons(id) ON DELETE CASCADE, name TEXT NOT NULL, body TEXT NOT NULL, words INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS sections_fts USING fts5(markdown, content='sections', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS sections_ai AFTER INSERT ON sections BEGIN
  INSERT INTO sections_fts(rowid, markdown) VALUES (new.id, new.markdown); END;
CREATE TRIGGER IF NOT EXISTS sections_ad AFTER DELETE ON sections BEGIN
  INSERT INTO sections_fts(sections_fts, rowid, markdown) VALUES ('delete', old.id, old.markdown); END;";

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
        return Ok(());
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
    tx.commit()
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

pub fn next_seq(c: &Connection, lesson: i64) -> Res<usize> {
    c.query_row("SELECT COALESCE(MAX(seq) + 1, 0) FROM messages WHERE lesson_id = ?1", [lesson], |r| r.get::<_, i64>(0))
        .map(|n| n as usize)
        .map_err(err)
}

/// The material the tutor teaches from: the lesson's own sources plus those of every folder above it.
pub fn sources_for(c: &Connection, lesson: i64) -> Res<Vec<(String, String)>> {
    let mut q = c
        .prepare_cached(
            "WITH RECURSIVE up(id) AS (
               SELECT folder_id FROM lessons WHERE id = ?1
               UNION ALL SELECT f.parent_id FROM folders f JOIN up ON f.id = up.id WHERE f.parent_id IS NOT NULL)
             SELECT name, body FROM sources WHERE lesson_id = ?1 OR folder_id IN (SELECT id FROM up) ORDER BY id",
        )
        .map_err(err)?;
    let out = q.query_map([lesson], |r| Ok((r.get(0)?, r.get(1)?))).map_err(err)?.collect::<Result<_, _>>().map_err(err);
    out
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

pub fn lesson(c: &Connection, id: i64) -> Res<Value> {
    let (title, folder): (String, Option<i64>) = c
        .query_row("SELECT title, folder_id FROM lessons WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(err)?;
    let sections = rows(c, "SELECT markdown FROM sections WHERE lesson_id = ?1 ORDER BY id", [id], |r| Ok(Value::String(r.get(0)?)))?;
    Ok(json!({ "id": id, "title": title, "folder": folder, "sections": sections }))
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
