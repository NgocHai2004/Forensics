use chrono::{DateTime, Local};
use jwalk::WalkDir;
use rayon::prelude::*;
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::env;
use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const MAX_TEXT: usize = 50_000;
const MAX_EXTRACT: usize = 2_000_000;
const CHUNK_SIZE: usize = 1_000;

fn ext_kind(ext: &str) -> &'static str {
    match ext {
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "tif" | "tiff" | "heic" | "heif" => "image",
        "mp4" | "mov" | "mkv" | "avi" | "webm" | "3gp" | "m4v" => "video",
        "mp3" | "m4a" | "wav" | "aac" | "ogg" | "opus" | "amr" | "flac" => "audio",
        "txt" | "md" | "csv" | "json" | "log" | "xml" | "pdf" | "doc" | "docx" | "xls"
        | "xlsx" | "ppt" | "pptx" | "rtf" | "odt" | "ods" | "odp" | "zip" | "apk" | "jar"
        | "sqlite" | "jwt" => "document",
        _ => "other",
    }
}

fn is_sniff_ext(ext: &str) -> bool {
    matches!(ext, "db" | "sqlite" | "sqlite3" | "log")
}

fn is_known_ext(ext: &str) -> bool {
    ext_kind(ext) != "other"
}

fn sniff_ext(path: &Path) -> Option<&'static str> {
    let mut f = File::open(path).ok()?;
    let mut buf = [0u8; 32];
    let n = f.read(&mut buf).ok()?;
    let h = &buf[..n];
    if h.starts_with(b"\xff\xd8\xff") { return Some("jpg"); }
    if h.starts_with(b"\x89PNG") { return Some("png"); }
    if h.starts_with(b"GIF8") { return Some("gif"); }
    if h.starts_with(b"BM") { return Some("bmp"); }
    if h.starts_with(b"%PDF") { return Some("pdf"); }
    if h.starts_with(b"SQLite format 3\x00") { return Some("sqlite"); }
    if h.starts_with(b"PK\x03\x04") { return Some("zip"); }
    if h.starts_with(b"ID3") { return Some("mp3"); }
    if h.starts_with(b"OggS") { return Some("ogg"); }
    if h.starts_with(b"fLaC") { return Some("flac"); }
    if h.starts_with(b"#!AMR") { return Some("amr"); }
    None
}

fn is_rust_text_ext(ext: &str) -> bool {
    matches!(ext, "txt" | "md" | "json" | "log" | "xml")
}

fn skip_dir(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        ".git" | ".svn" | "__macosx" | "system volume information" | "_ios_backup"
    )
}

fn skip_file(name: &str) -> bool {
    let low = name.to_ascii_lowercase();
    matches!(low.as_str(), ".nomedia" | ".ds_store" | "thumbs.db" | "desktop.ini")
        || low.ends_with("-wal")
        || low.ends_with("-shm")
        || low.ends_with("-journal")
}

fn app_of(path: &str) -> Option<&'static str> {
    let norm = path.replace('\\', "/");
    let mut parts: Vec<&str> = norm.split('/').collect();
    if !parts.is_empty() {
        parts.pop();
    }
    for p in parts.into_iter().rev() {
        let low = p.to_ascii_lowercase();
        let hit = match low.as_str() {
            "zalo" => Some("Zalo"),
            "messenger" => Some("Messenger"),
            "facebook" => Some("Facebook"),
            "telegram" => Some("Telegram"),
            "threads" => Some("Threads"),
            "whatsapp" => Some("WhatsApp"),
            "viber" => Some("Viber"),
            "instagram" => Some("Instagram"),
            "tiktok" => Some("TikTok"),
            "screenshots" => Some("Screenshots"),
            "camera" => Some("Camera"),
            "recordings" => Some("Recordings"),
            "download" => Some("Download"),
            "documents" => Some("Documents"),
            "bluetooth" => Some("Bluetooth"),
            _ => None,
        };
        if hit.is_some() {
            return hit;
        }
    }
    None
}

fn sha256_file(path: &Path) -> Result<String, std::io::Error> {
    let f = File::open(path)?;
    let mut reader = BufReader::with_capacity(256 * 1024, f);
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 256 * 1024];
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn clean_text(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len().min(MAX_EXTRACT));
    let mut prev_space = true;
    for ch in raw.chars() {
        if ch.is_whitespace() {
            if !prev_space {
                out.push(' ');
                prev_space = true;
            }
        } else {
            out.push(ch);
            prev_space = false;
        }
        if out.len() >= MAX_EXTRACT {
            break;
        }
    }
    out.trim().to_string()
}

fn split_chunks(text: &str, app: Option<&str>) -> Vec<String> {
    if text.is_empty() {
        return Vec::new();
    }
    let chars: Vec<char> = text.chars().collect();
    let mut chunks = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let mut end = (i + CHUNK_SIZE).min(chars.len());
        if end < chars.len() {
            if let Some(pos) = chars[i..end].iter().rposition(|c| *c == ' ') {
                if pos > CHUNK_SIZE / 2 {
                    end = i + pos;
                }
            }
        }
        let s: String = chars[i..end].iter().collect();
        let trimmed = s.trim();
        if !trimmed.is_empty() {
            if let Some(a) = app {
                chunks.push(format!("[Nguồn: {a}] {trimmed}"));
            } else {
                chunks.push(trimmed.to_string());
            }
        }
        i = if end <= i { i + CHUNK_SIZE } else { end };
        while i < chars.len() && chars[i] == ' ' {
            i += 1;
        }
    }
    chunks
}

fn fmt_mtime(st: &fs::Metadata) -> String {
    match st.modified() {
        Ok(t) => {
            let dt: DateTime<Local> = DateTime::<Local>::from(t);
            dt.format("%Y-%m-%dT%H:%M:%S").to_string()
        }
        Err(_) => {
            let _ = UNIX_EPOCH;
            String::new()
        }
    }
}

enum WorkItem {
    Fast {
        path: String,
        name: String,
        ext: String,
        kind: &'static str,
        size: i64,
        mtime: String,
        sha256: String,
        text_content: Option<String>,
        chunks: Vec<String>,
        error: Option<String>,
    },
    Python(String),
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: mf-fast <folder> <data_dir> [collection] [device]");
        std::process::exit(2);
    }
    let folder = fs::canonicalize(&args[1])?;
    let data_dir = fs::canonicalize(&args[2]).unwrap_or_else(|_| PathBuf::from(&args[2]));
    let collection = args.get(3).filter(|s| !s.is_empty()).cloned();
    let device = args.get(4).filter(|s| !s.is_empty()).cloned();

    let db_path = Path::new(&args[2]).join("index.db");
    let mut conn = Connection::open(&db_path)?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=60000;",
    )?;

    // 1. Load unchanged files in one query
    let mut unchanged: HashMap<String, (i64, String)> = HashMap::new();
    {
        let mut stmt = conn.prepare("SELECT path, size, mtime FROM files WHERE error IS NULL")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        for row in rows {
            if let Ok((p, sz, mt)) = row {
                unchanged.insert(p, (sz, mt));
            }
        }
    }

    // 2. Parallel directory walk
    let data_cmp = data_dir.clone();
    let mut candidates: Vec<(PathBuf, fs::Metadata)> = Vec::new();
    for entry in WalkDir::new(&folder)
        .follow_links(false)
        .process_read_dir(move |_depth, _path, _state, children| {
            children.retain(|res| match res {
                Ok(e) => {
                    let name = e.file_name().to_string_lossy();
                    if e.file_type().is_dir() {
                        !skip_dir(&name) && e.path() != data_cmp
                    } else if e.file_type().is_file() {
                        !skip_file(&name)
                    } else {
                        false
                    }
                }
                Err(_) => false,
            });
        })
    {
        if let Ok(e) = entry {
            if e.file_type().is_file() {
                if let Ok(st) = e.metadata() {
                    candidates.push((e.path(), st));
                }
            }
        }
    }

    let total_walked = candidates.len();

    // Filter out unchanged files before hashing
    let changed: Vec<(PathBuf, fs::Metadata, String)> = candidates
        .into_iter()
        .filter_map(|(p, st)| {
            let p_str = p.to_string_lossy().to_string();
            let mt = fmt_mtime(&st);
            let sz = st.len() as i64;
            if let Some((usz, umt)) = unchanged.get(&p_str) {
                if *usz == sz && *umt == mt {
                    return None;
                }
            }
            Some((p, st, mt))
        })
        .collect();

    // 3. Parallel hash + fast text extraction with rayon
    let items: Vec<WorkItem> = changed
        .into_par_iter()
        .map(|(p, st, mtime)| {
            let p_str = p.to_string_lossy().to_string();
            let name = p
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let mut ext = p
                .extension()
                .map(|e| e.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default();
            let sz = st.len() as i64;
            if (!is_known_ext(&ext) || is_sniff_ext(&ext)) && sz > 0 {
                if let Some(s) = sniff_ext(&p) {
                    ext = s.to_string();
                }
            }
            let kind = ext_kind(&ext);

            if kind != "other" && !is_rust_text_ext(&ext) {
                return WorkItem::Python(p_str);
            }

            let sha = match sha256_file(&p) {
                Ok(h) => h,
                Err(e) => {
                    return WorkItem::Fast {
                        path: p_str,
                        name,
                        ext,
                        kind,
                        size: sz,
                        mtime,
                        sha256: String::new(),
                        text_content: None,
                        chunks: Vec::new(),
                        error: Some(format!("IOError: {e}").chars().take(500).collect()),
                    };
                }
            };

            let (text_content, chunks) = if is_rust_text_ext(&ext) {
                let bytes = fs::read(&p).unwrap_or_default();
                let limit = bytes.len().min(MAX_EXTRACT * 2);
                let raw = String::from_utf8_lossy(&bytes[..limit]);
                let cleaned = clean_text(&raw);
                let app = app_of(&p_str);
                let ch = split_chunks(&cleaned, app);
                let tc = if ch.is_empty() {
                    None
                } else {
                    Some(ch.join("\n").chars().take(MAX_TEXT).collect())
                };
                (tc, ch)
            } else {
                (None, Vec::new())
            };

            WorkItem::Fast {
                path: p_str,
                name,
                ext,
                kind,
                size: sz,
                mtime,
                sha256: sha,
                text_content,
                chunks,
                error: None,
            }
        })
        .collect();

    // 4. Batched SQLite writes + emit remaining Python paths to stdout
    let indexed_at = Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
    let mut fast_items = Vec::new();
    let mut py_paths = Vec::new();
    for it in items {
        match it {
            WorkItem::Fast { .. } => fast_items.push(it),
            WorkItem::Python(p) => py_paths.push(p),
        }
    }

    let fast_count = fast_items.len();
    for batch in fast_items.chunks(1000) {
        let tx = conn.transaction()?;
        {
            let mut ins_file = tx.prepare_cached(
                "INSERT INTO files(path,name,ext,kind,size,mtime,sha256,indexed_at,text_content,error,collection,device,ai_pending)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,0)
                 ON CONFLICT(path) DO UPDATE SET
                   name=excluded.name, ext=excluded.ext, kind=excluded.kind,
                   size=excluded.size, mtime=excluded.mtime, sha256=excluded.sha256,
                   indexed_at=excluded.indexed_at, text_content=excluded.text_content,
                   error=excluded.error,
                   collection=COALESCE(excluded.collection, files.collection),
                   device=COALESCE(excluded.device, files.device),
                   ai_pending=0
                 RETURNING id",
            )?;
            let mut del_chunks = tx.prepare_cached("DELETE FROM chunks WHERE file_id=?1")?;
            let mut ins_chunk = tx.prepare_cached(
                "INSERT INTO chunks(file_id, seq, loc, source, text) VALUES (?1, ?2, NULL, 'text', ?3)",
            )?;

            for item in batch {
                if let WorkItem::Fast {
                    path,
                    name,
                    ext,
                    kind,
                    size,
                    mtime,
                    sha256,
                    text_content,
                    chunks,
                    error,
                } = item
                {
                    let fid: i64 = ins_file.query_row(
                        params![
                            path,
                            name,
                            ext,
                            *kind,
                            size,
                            mtime,
                            sha256,
                            &indexed_at,
                            text_content,
                            error,
                            &collection,
                            &device
                        ],
                        |r| r.get(0),
                    )?;
                    del_chunks.execute(params![fid])?;
                    for (seq, text) in chunks.iter().enumerate() {
                        ins_chunk.execute(params![fid, seq as i64, text])?;
                    }
                }
            }
        }
        tx.commit()?;
    }

    eprintln!("RUST_DONE:{total_walked}:{fast_count}:{}", py_paths.len());
    for p in py_paths {
        println!("{p}");
    }
    Ok(())
}
