# Project: LabNotes MVP

## Architecture
LabNotes is a single-binary web platform designed for publishing academic practical laboratory works by a single author.
- **Backend**: Rust stable, Tokio, Axum, tower-http, SQLite via SQLx with SQL migrations.
- **Frontend**: Svelte, TypeScript, Vite, CodeMirror 6, markdown-it (raw HTML disabled) + DOMPurify, plain scoped CSS (Notion-inspired theme).
- **Process Model**: Single unified Rust process serving REST API (`/api/*`), media streams (`/media/*`), and pre-compiled SPA static files (`frontend/dist`) with client-side routing fallback.
- **Data Persistence**: SQLite database and media files stored in `/app/data` (Docker volume) or local `./data` directory.
- **Security**: Argon2id password hashing off-thread via `tokio::task::spawn_blocking`, SQLite server-side sessions with SHA-256 hashed tokens in HttpOnly cookies, login rate limiting, CSRF/Origin validation, chunked disk streaming with magic byte validation, and strict Markdown sanitization.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Single-binary runtime | Axum serves REST API, media, and SPA static files with fallback | M6 | AGENT_PLAN.md: 24, 137 |
| 2 | Health Readiness Probe | GET /healthz returns status ok for Docker & load balancer | M1 | AGENT_PLAN.md: 125 |
| 3 | Public Subjects List | GET /api/public/subjects returns subjects with published pages count | M3 | AGENT_PLAN.md: 120 |
| 4 | Public Page Catalog & Search | GET /api/public/pages with pagination and SQL search over title/markdown | M3 | AGENT_PLAN.md: 36, 122 |
| 5 | Public Page View | GET /api/public/pages/:id returns published snapshot and attachments | M3 | AGENT_PLAN.md: 37, 123 |
| 6 | Rendered Markdown View | Full Markdown typography: H1-H6, lists, tables, checklists, blockquotes | M4 | AGENT_PLAN.md: 38, 143 |
| 7 | Code Block Copy Button | Copy button on each code block with visual feedback | M4 | AGENT_PLAN.md: 39 |
| 8 | Table of Contents (TOC) | Auto-generated TOC sidebar from H2 and H3 headings | M4 | AGENT_PLAN.md: 40 |
| 9 | Image Lightbox | Click image opens fullscreen overlay; Escape key dismissal | M4 | AGENT_PLAN.md: 41 |
| 10 | Attachment Download List | Download list of public attachments with filename and size | M4 | AGENT_PLAN.md: 42, 87 |
| 11 | Friendly 404 & Empty States | Clean 404 page and empty catalog states | M4 | AGENT_PLAN.md: 44 |
| 12 | Initial Admin Bootstrap | Provision single admin via ADMIN_PASSWORD env or CLI | M2 | AGENT_PLAN.md: 49-50 |
| 13 | Admin Login | POST /api/admin/login with Argon2id, rate limiting, and session cookie | M2 | AGENT_PLAN.md: 51-53 |
| 14 | Admin Logout | POST /api/admin/logout revokes session in DB and clears cookie | M2 | AGENT_PLAN.md: 53, 129 |
| 15 | Admin Session Check | GET /api/admin/me returns author profile and CSRF token | M2 | AGENT_PLAN.md: 129 |
| 16 | List All Subjects | GET /api/admin/subjects returns all subjects for author management | M2 | AGENT_PLAN.md: 130 |
| 17 | Create Subject | POST /api/admin/subjects creates new subject | M2 | AGENT_PLAN.md: 58, 130 |
| 18 | Update Subject | PATCH /api/admin/subjects/:id renames or reorders subject | M2 | AGENT_PLAN.md: 58, 130 |
| 19 | Delete Subject | DELETE /api/admin/subjects/:id blocked if subject has pages (409) | M2 | AGENT_PLAN.md: 58, 130 |
| 20 | List Admin Pages | GET /api/admin/pages lists drafts, publication status, and revisions | M2 | AGENT_PLAN.md: 59, 130 |
| 21 | Create Page | POST /api/admin/pages creates new blank draft | M2 | AGENT_PLAN.md: 59, 130 |
| 22 | Read Page Draft | GET /api/admin/pages/:id returns full draft and revision number | M2 | AGENT_PLAN.md: 130 |
| 23 | Update Draft (Autosave/Manual) | PATCH /api/admin/pages/:id with expected_revision check (409 on conflict) | M2 | AGENT_PLAN.md: 74, 131 |
| 24 | Delete Page | DELETE /api/admin/pages/:id cascades page, publications, and assets | M2 | AGENT_PLAN.md: 59, 130 |
| 25 | Publish Draft Snapshot | POST /api/admin/pages/:id/publish atomically copies draft to publications | M2 | AGENT_PLAN.md: 61, 115 |
| 26 | Unpublish Page | DELETE /api/admin/pages/:id/publication revokes public access immediately | M2 | AGENT_PLAN.md: 63, 133 |
| 27 | Share / Copy Link | UI action to copy /p/:id public URL to clipboard | M5 | AGENT_PLAN.md: 64 |
| 28 | CodeMirror 6 Markdown Editor | Markdown syntax highlighting, tab indent, word wrap, undo/redo | M5 | AGENT_PLAN.md: 69 |
| 29 | Dynamic Editor Loading | Lazy-load CodeMirror bundle only on admin routes | M5 | AGENT_PLAN.md: 146 |
| 30 | View Modes (Editor / Preview / Split) | Toggle editor-only, preview-only, split pane (collapses on mobile) | M5 | AGENT_PLAN.md: 70 |
| 31 | Formatting Toolbar | Toolbar buttons (H1-H3, Bold, Italic, Link, List, Code, Image) | M5 | AGENT_PLAN.md: 71 |
| 32 | Formatting Hotkeys | Shortcuts Ctrl/Cmd+S, Ctrl/Cmd+B, Ctrl/Cmd+I | M5 | AGENT_PLAN.md: 72 |
| 33 | Autosave & Status Indicators | Debounced (~1s) autosave with status badges | M5 | AGENT_PLAN.md: 73 |
| 34 | LocalStorage Recovery | Cache unsaved draft in localStorage; prompt to restore on conflict | M5 | AGENT_PLAN.md: 76 |
| 35 | Navigation Guard | Warn of unsaved changes before page unload or route change | M5 | AGENT_PLAN.md: 75 |
| 36 | Import / Export Markdown | Import UTF-8 .md file into editor; export draft as .md file | M5 | AGENT_PLAN.md: 65 |
| 37 | Image Upload (Paste / DnD / Picker) | Upload PNG/JPEG/WebP up to 10 MiB via Ctrl+V, DnD, or file input | M5 & M2 | AGENT_PLAN.md: 80, 86 |
| 38 | Image Insertion in Editor | Auto-insert ![name](/media/UUID) at cursor position upon upload | M5 | AGENT_PLAN.md: 83-84 |
| 39 | Attachment Upload | Upload PDF, DOCX, TXT, MD, ZIP up to 50 MiB | M5 & M2 | AGENT_PLAN.md: 87, 134 |
| 40 | Streaming Disk Storage | Stream file chunks directly to disk; atomic move upon validation | M1 | AGENT_PLAN.md: 89 |
| 41 | Media Serving & Visibility Check | GET /media/:id serves file only if public or authenticated admin | M2 | AGENT_PLAN.md: 91-92 |
| 42 | List Page Assets | GET /api/admin/pages/:id/assets lists all uploaded assets for page | M2 | AGENT_PLAN.md: 135 |
| 43 | Markdown XSS Sanitization | markdown-it (html: false) + DOMPurify strips scripts and event handlers | M4 | AGENT_PLAN.md: 143 |
| 44 | CSRF & Origin Validation | Validate Origin header and match X-CSRF-Token on mutating requests | M2 | AGENT_PLAN.md: 142 |
| 45 | Rate Limiting on Login | Limit failed login attempts per client IP (HTTP 429) | M2 | AGENT_PLAN.md: 51 |
| 46 | Docker Multi-Stage Build | Multi-stage Dockerfile and compose.yaml with persistent /app/data | M6 | AGENT_PLAN.md: 24, 220 |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M_TEST | E2E Testing Track | Independent opaque-box test suite (Tiers 1-4) & TEST_READY.md | none | DONE |
| M1 | Foundation, Storage & Core Database Backend | Cargo setup, SQLite migrations, config, errors, streaming storage, GET /healthz | none | DONE |
| M2 | Auth, Author Content Management & Media Gating | Argon2id, sessions, rate limiting, subject/page CRUD, dual-state publishing, revision conflict 409, media access gating | M1 | DONE |
| M3 | Public Catalog, SQL Search & Read APIs | GET /api/public/subjects, GET /api/public/pages (catalog + search), GET /api/public/pages/:id | M1, M2 | DONE |
| M4 | Svelte Frontend Core (Reader, Catalog & Markdown Pipeline) | Svelte + Vite setup, typed API client, markdown-it + DOMPurify, Reader view, TOC, Code copy, Lightbox, 404 view | M1, M3 | DONE |
| M5 | CodeMirror Editor, Autosave Concurrency & Admin UI | CodeMirror 6 lazy loading, formatting toolbar/hotkeys, debounced autosave with revision 409 recovery, DnD/paste uploads, Admin dashboard | M2, M4 | DONE |
| M6 | Single-Binary Serving, Dockerfile & Deployment Docs | Axum SPA static file serving with fallback, multi-stage Dockerfile, compose.yaml, README.md, quality checks | M4, M5 | DONE |
| M7 | Final Milestone: 100% E2E Pass & Coverage Hardening | Phase 1: 100% E2E tests pass (Tiers 1-4). Phase 2: Adversarial coverage hardening (Tier 5) | M6, M_TEST | DONE |

## Interface Contracts

### 1. Database Schema
- **subjects**: `id TEXT PRIMARY KEY`, `name TEXT NOT NULL`, `position INTEGER NOT NULL DEFAULT 0`, `created_at TEXT`, `updated_at TEXT`.
- **pages**: `id TEXT PRIMARY KEY`, `draft_subject_id TEXT NOT NULL REFERENCES subjects(id)`, `draft_title TEXT NOT NULL`, `draft_markdown TEXT NOT NULL DEFAULT ''`, `revision INTEGER NOT NULL DEFAULT 1`, `created_at TEXT`, `updated_at TEXT`.
- **publications**: `page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE`, `subject_id TEXT NOT NULL REFERENCES subjects(id)`, `title TEXT NOT NULL`, `markdown TEXT NOT NULL`, `published_revision INTEGER NOT NULL`, `published_at TEXT NOT NULL`.
- **assets**: `id TEXT PRIMARY KEY`, `page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE`, `stored_name TEXT NOT NULL`, `original_name TEXT NOT NULL`, `mime TEXT NOT NULL`, `byte_size INTEGER NOT NULL`, `kind TEXT NOT NULL CHECK(kind IN ('image', 'attachment'))`, `created_at TEXT`.
- **page_public_assets**: `page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE`, `asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE`, `PRIMARY KEY (page_id, asset_id)`.
- **admin**: `id INTEGER PRIMARY KEY AUTOINCREMENT`, `username TEXT NOT NULL UNIQUE`, `password_hash TEXT NOT NULL`, `created_at TEXT`, `updated_at TEXT`.
- **sessions**: `token_hash TEXT PRIMARY KEY`, `admin_id INTEGER NOT NULL REFERENCES admin(id) ON DELETE CASCADE`, `expires_at TEXT NOT NULL`, `created_at TEXT`.

### 2. Standard API Error Format
All errors return JSON with structure:
```json
{
  "error": {
    "code": "STRING_ERROR_CODE",
    "message": "Human-readable description"
  }
}
```
Standard codes: `VALIDATION_ERROR` (400), `INVALID_IMAGE_FORMAT` (400), `SVG_NOT_ALLOWED` (400), `UNSUPPORTED_MIME` (400), `UNAUTHORIZED` (401), `INVALID_CREDENTIALS` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `PAGE_NOT_FOUND` (404), `MEDIA_NOT_FOUND` (404), `REVISION_CONFLICT` (409), `SUBJECT_NOT_EMPTY` (409), `FILE_TOO_LARGE` (413), `RATE_LIMIT_EXCEEDED` (429), `INTERNAL_ERROR` (500).

### 3. API Route Contracts
- `GET /healthz` -> 200 OK `{"status": "ok"}`
- `GET /api/public/subjects` -> 200 OK `[{ "id": string, "name": string, "position": number, "page_count": number }]`
- `GET /api/public/pages?subject_id=&q=&limit=20&offset=0` -> 200 OK `{"items": [...], "total": number}`
- `GET /api/public/pages/:id` -> 200 OK `{"id": string, "subject_id": string, "subject_name": string, "title": string, "markdown": string, "published_at": string, "attachments": [...]}` (or 404)
- `GET /media/:id` -> binary stream with appropriate MIME and headers. Returns 404 for draft assets if unauthenticated.
- `POST /api/admin/login` -> 200 OK `{"success": true, "user": {"id": 1, "username": "admin"}, "csrf_token": "..."}`, sets HttpOnly session cookie.
- `POST /api/admin/logout` -> 200 OK `{"success": true}`, clears session cookie.
- `GET /api/admin/me` -> 200 OK `{"id": 1, "username": "admin", "csrf_token": "..."}`
- `GET /api/admin/subjects` -> 200 OK array of subjects with full page counts.
- `POST /api/admin/subjects` -> 201 Created subject object.
- `PATCH /api/admin/subjects/:id` -> 200 OK updated subject.
- `DELETE /api/admin/subjects/:id` -> 200 OK or 409 if pages exist.
- `GET /api/admin/pages` -> 200 OK array of page draft summaries.
- `POST /api/admin/pages` -> 201 Created `{ "id": string, "draft_title": string, "draft_subject_id": string, "draft_markdown": "", "revision": 1 }`
- `GET /api/admin/pages/:id` -> 200 OK full draft object.
- `PATCH /api/admin/pages/:id` -> Body: `{"expected_revision": N, "title"?: string, "subject_id"?: string, "markdown"?: string}`. Returns 200 OK `{"id": string, "revision": N+1}` or 409 Conflict.
- `DELETE /api/admin/pages/:id` -> 200 OK `{ "success": true }`.
- `POST /api/admin/pages/:id/publish` -> Body: `{"expected_revision": N, "attachment_ids": string[]}`. Returns 200 OK `{"page_id": string, "published_revision": N, "published_at": string}`.
- `DELETE /api/admin/pages/:id/publication` -> 200 OK `{ "success": true }`.
- `POST /api/admin/pages/:id/assets` -> multipart/form-data. Returns 201 Created `{ "id": string, "original_name": string, "mime": string, "byte_size": number, "kind": "image"|"attachment", "url": "/media/..." }`.
- `GET /api/admin/pages/:id/assets` -> 200 OK array of asset objects.
- `DELETE /api/admin/pages/:id/assets/:asset_id` -> 200 OK.

## Code Layout
```
c:\Users\Влад\Desktop\lab\
├── .agents/                      # Teamwork metadata only (no source code or data)
├── .gitignore                    # Project git ignore
├── .dockerignore                 # Container build ignore
├── .env.example                  # Environment configuration example
├── compose.yaml                  # Docker Compose configuration
├── Dockerfile                    # Multi-stage container build
├── README.md                     # Documentation (Russian)
├── STATUS.md                     # Project status log
├── PROJECT.md                    # Single-source-of-truth project index
├── backend/
│   ├── Cargo.toml                # Rust dependencies & optimized profile
│   ├── Cargo.lock                # Pinned lockfile
│   ├── migrations/
│   │   └── 0001_init.sql         # Initial SQLite database schema
│   ├── src/
│   │   ├── main.rs               # Server startup & routing assembly
│   │   ├── config.rs             # Environment config
│   │   ├── db.rs                 # SQLite connection pool & migration runner
│   │   ├── error.rs              # Unified JSON error envelope
│   │   ├── auth.rs               # Argon2id, session tokens, rate limiter
│   │   ├── storage.rs            # Streaming multipart upload & validation
│   │   ├── models.rs             # Serde DTOs and models
│   │   └── routes/
│   │       ├── mod.rs            # Axum router
│   │       ├── healthz.rs        # GET /healthz
│   │       ├── public.rs         # Public catalog and page views
│   │       ├── media.rs          # GET /media/:id serving
│   │       ├── admin_auth.rs     # Login, logout, session check
│   │       ├── admin_subjects.rs # Subject management
│   │       ├── admin_pages.rs    # Draft management, revision check, publish
│   │       └── spa.rs            # Static file serving & SPA fallback
│   └── tests/
│       └── integration_tests.rs  # Rust integration tests
├── frontend/
│   ├── package.json              # Frontend dependencies
│   ├── tsconfig.json             # TypeScript config
│   ├── vite.config.ts            # Vite config with dev proxy
│   ├── index.html                # SPA HTML shell
│   └── src/
│       ├── main.ts               # Svelte app entry
│       ├── App.svelte            # Main app shell & router
│       ├── lib/
│       │   ├── api.ts            # Client API client with CSRF & error handling
│       │   ├── markdown.ts       # markdown-it (html: false) + DOMPurify
│       │   └── stores.ts         # Svelte state stores
│       ├── components/
│       │   ├── Sidebar.svelte    # Navigation & subjects list
│       │   ├── Lightbox.svelte   # Image zoom overlay
│       │   ├── CodeBlock.svelte  # Code copy button
│       │   ├── Toc.svelte        # Table of contents
│       │   └── CodeMirrorEditor.svelte # Lazy CodeMirror 6 editor
│       ├── pages/
│       │   ├── Catalog.svelte    # Public catalog & search
│       │   ├── Reader.svelte     # Public article reader (/p/:id)
│       │   ├── Login.svelte      # Admin login
│       │   ├── AdminDashboard.svelte # Admin management
│       │   ├── EditorPage.svelte # Page editor & preview
│       │   └── NotFound.svelte   # 404 page
│       └── styles/
│           └── app.css           # Notion-inspired CSS design
└── data/                         # Local persistence directory (git-ignored)
```
