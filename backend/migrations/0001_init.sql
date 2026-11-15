-- LabNotes SQLite Schema Initialization
-- 0001_init.sql

PRAGMA foreign_keys = ON;

-- 1. Subjects Table
CREATE TABLE IF NOT EXISTS subjects (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_subjects_position ON subjects (position ASC, name ASC);

-- 2. Pages Table (Draft State)
CREATE TABLE IF NOT EXISTS pages (
    id TEXT PRIMARY KEY NOT NULL,
    draft_subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
    draft_title TEXT NOT NULL,
    draft_markdown TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pages_draft_subject_id ON pages (draft_subject_id);
CREATE INDEX IF NOT EXISTS idx_pages_updated_at ON pages (updated_at DESC);

-- 3. Publications Table (Published Snapshot)
CREATE TABLE IF NOT EXISTS publications (
    page_id TEXT PRIMARY KEY NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
    title TEXT NOT NULL,
    markdown TEXT NOT NULL,
    published_revision INTEGER NOT NULL,
    published_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_publications_subject_id ON publications (subject_id);
CREATE INDEX IF NOT EXISTS idx_publications_published_at ON publications (published_at DESC);

-- 4. Assets Table (Uploaded Media & Files)
CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY NOT NULL,
    page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    stored_name TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('image', 'attachment')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_assets_page_id ON assets (page_id);
CREATE INDEX IF NOT EXISTS idx_assets_stored_name ON assets (stored_name);

-- 5. Page Public Assets Junction Table (Public Snapshot Visibility)
CREATE TABLE IF NOT EXISTS page_public_assets (
    page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    PRIMARY KEY (page_id, asset_id)
);

CREATE INDEX IF NOT EXISTS idx_page_public_assets_asset_id ON page_public_assets (asset_id);

-- 6. Admin Table
CREATE TABLE IF NOT EXISTS admin (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 7. Sessions Table
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY NOT NULL,
    admin_id INTEGER NOT NULL REFERENCES admin(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_admin_id ON sessions (admin_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at);
