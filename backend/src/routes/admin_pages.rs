//! Administrative page management routes: drafts, concurrency control, publishing, and assets.

use axum::{
    extract::{rejection::JsonRejection, Multipart, Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use std::collections::HashSet;
use uuid::Uuid;

use crate::{
    auth::{validate_csrf_token, validate_origin, AdminUser, CsrfProtected},
    error::{AppError, AppResult},
    models::{
        AdminListPagesQuery, AdminPageDetail, AdminPageListItem, AssetResponse, CreatePageRequest,
        PublishPageRequest, PublishPageResponse, SuccessResponse, UpdatePageRequest,
        UpdatePageResponse,
    },
    storage, AppState,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/admin/pages", get(list_pages).post(create_page))
        .route(
            "/api/admin/pages/{id}",
            get(get_page).patch(update_page).delete(delete_page),
        )
        .route(
            "/api/admin/pages/{id}/publish",
            axum::routing::post(publish_page),
        )
        .route(
            "/api/admin/pages/{id}/publication",
            axum::routing::delete(unpublish_page),
        )
        .route(
            "/api/admin/pages/{id}/assets",
            get(list_page_assets)
                .post(upload_page_asset)
                .layer(axum::extract::DefaultBodyLimit::disable()),
        )
        .route(
            "/api/admin/pages/{id}/assets/{asset_id}",
            axum::routing::delete(delete_page_asset),
        )
}

/// Helper function: safely extracts all valid UUIDs referenced in markdown under "/media/{UUID}".
pub fn extract_media_uuids(markdown: &str) -> HashSet<String> {
    let mut uuids = HashSet::new();
    let prefix = "/media/";
    let mut pos = 0;

    while let Some(rel_pos) = markdown.get(pos..).and_then(|s| s.find(prefix)) {
        let start = pos + rel_pos + prefix.len();
        if start + 36 <= markdown.len() {
            if let Some(candidate) = markdown.get(start..start + 36) {
                if let Ok(parsed) = Uuid::parse_str(candidate) {
                    uuids.insert(parsed.to_string());
                    pos = start + 36;
                    continue;
                }
            }
        }
        if let Some(s) = markdown.get(start..) {
            if let Some(c) = s.chars().next() {
                pos = start + c.len_utf8();
            } else {
                break;
            }
        } else {
            break;
        }
    }

    uuids
}

/// GET /api/admin/pages
/// Lists all draft pages with revision and publication status.
pub async fn list_pages(
    _admin: AdminUser,
    State(state): State<AppState>,
    Query(query): Query<AdminListPagesQuery>,
) -> AppResult<Json<Vec<AdminPageListItem>>> {
    let rows = if let Some(ref subj_id) = query.subject_id {
        sqlx::query_as::<
            _,
            (
                String,
                String,
                String,
                String,
                i64,
                String,
                String,
                i64,
                Option<i64>,
            ),
        >(
            r#"
            SELECT 
                p.id, 
                p.draft_subject_id, 
                COALESCE(s.name, '') AS draft_subject_name,
                p.draft_title, 
                p.revision, 
                p.created_at, 
                p.updated_at,
                CAST((pub.published_revision IS NOT NULL) AS INTEGER) AS is_published,
                pub.published_revision
            FROM pages p
            LEFT JOIN subjects s ON s.id = p.draft_subject_id
            LEFT JOIN publications pub ON pub.page_id = p.id
            WHERE p.draft_subject_id = ?
            ORDER BY p.updated_at DESC
            "#,
        )
        .bind(subj_id)
        .fetch_all(&state.db)
        .await?
    } else {
        sqlx::query_as::<
            _,
            (
                String,
                String,
                String,
                String,
                i64,
                String,
                String,
                i64,
                Option<i64>,
            ),
        >(
            r#"
            SELECT 
                p.id, 
                p.draft_subject_id, 
                COALESCE(s.name, '') AS draft_subject_name,
                p.draft_title, 
                p.revision, 
                p.created_at, 
                p.updated_at,
                CAST((pub.published_revision IS NOT NULL) AS INTEGER) AS is_published,
                pub.published_revision
            FROM pages p
            LEFT JOIN subjects s ON s.id = p.draft_subject_id
            LEFT JOIN publications pub ON pub.page_id = p.id
            ORDER BY p.updated_at DESC
            "#,
        )
        .fetch_all(&state.db)
        .await?
    };

    let pages = rows
        .into_iter()
        .map(|r| AdminPageListItem {
            id: r.0,
            draft_subject_id: r.1,
            draft_subject_name: r.2,
            draft_title: r.3,
            revision: r.4,
            created_at: r.5,
            updated_at: r.6,
            is_published: r.7 != 0,
            published_revision: r.8,
        })
        .collect();

    Ok(Json(pages))
}

/// POST /api/admin/pages
/// Creates a new draft page with revision = 1 and empty markdown.
pub async fn create_page(
    _admin: CsrfProtected,
    State(state): State<AppState>,
    req: Result<Json<CreatePageRequest>, JsonRejection>,
) -> AppResult<(StatusCode, Json<AdminPageDetail>)> {
    let Json(req) = req.map_err(|e| AppError::validation(e.to_string()))?;
    let title = req.title.trim();
    if title.is_empty() {
        return Err(AppError::validation("Page title cannot be empty"));
    }
    if title.chars().count() > 200 {
        return Err(AppError::validation(
            "Page title cannot exceed 200 characters",
        ));
    }

    // Verify subject exists
    let subject_exists: Option<(String,)> = sqlx::query_as("SELECT id FROM subjects WHERE id = ?")
        .bind(&req.subject_id)
        .fetch_optional(&state.db)
        .await?;

    if subject_exists.is_none() {
        return Err(AppError::not_found(format!(
            "Subject '{}' not found",
            req.subject_id
        )));
    }

    let id = Uuid::new_v4().to_string();

    let row = sqlx::query_as::<_, (String, String, String, String, i64, String, String)>(
        r#"
        INSERT INTO pages (id, draft_subject_id, draft_title, draft_markdown, revision, created_at, updated_at)
        VALUES (?1, ?2, ?3, '', 1, datetime('now'), datetime('now'))
        RETURNING id, draft_subject_id, draft_title, draft_markdown, revision, created_at, updated_at
        "#,
    )
    .bind(&id)
    .bind(&req.subject_id)
    .bind(title)
    .fetch_one(&state.db)
    .await?;

    let response = AdminPageDetail {
        id: row.0,
        draft_subject_id: row.1,
        draft_title: row.2,
        draft_markdown: row.3,
        revision: row.4,
        is_published: false,
        published_revision: None,
        published_at: None,
        created_at: row.5,
        updated_at: row.6,
    };

    Ok((StatusCode::CREATED, Json(response)))
}

/// GET /api/admin/pages/{id}
/// Reads draft content and current publication status.
pub async fn get_page(
    _admin: AdminUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Response> {
    let row = sqlx::query_as::<
        _,
        (
            String,
            String,
            String,
            String,
            i64,
            String,
            String,
            i64,
            Option<i64>,
            Option<String>,
        ),
    >(
        r#"
        SELECT 
            p.id,
            p.draft_subject_id,
            p.draft_title,
            p.draft_markdown,
            p.revision,
            p.created_at,
            p.updated_at,
            CAST((pub.published_revision IS NOT NULL) AS INTEGER) AS is_published,
            pub.published_revision,
            pub.published_at
        FROM pages p
        LEFT JOIN publications pub ON pub.page_id = p.id
        WHERE p.id = ?1
        "#,
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await?;

    let r = match row {
        Some(data) => data,
        None => return Err(AppError::PageNotFound(format!("Page '{id}' not found"))),
    };

    let response = AdminPageDetail {
        id: r.0,
        draft_subject_id: r.1,
        draft_title: r.2,
        draft_markdown: r.3,
        revision: r.4,
        created_at: r.5,
        updated_at: r.6,
        is_published: r.7 != 0,
        published_revision: r.8,
        published_at: r.9,
    };

    let headers = [(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, no-cache, must-revalidate"),
    )];
    Ok((headers, Json(response)).into_response())
}

/// PATCH /api/admin/pages/{id}
/// Optimistic concurrency control update. Checks expected_revision.
/// Returns HTTP 409 REVISION_CONFLICT if expected_revision != page.revision.
pub async fn update_page(
    _admin: CsrfProtected,
    State(state): State<AppState>,
    Path(id): Path<String>,
    req: Result<Json<UpdatePageRequest>, JsonRejection>,
) -> AppResult<Json<UpdatePageResponse>> {
    let Json(req) = req.map_err(|e| AppError::validation(e.to_string()))?;
    if let Some(ref title) = req.title {
        let t = title.trim();
        if t.is_empty() {
            return Err(AppError::validation("Page title cannot be empty"));
        }
        if t.chars().count() > 200 {
            return Err(AppError::validation(
                "Page title cannot exceed 200 characters",
            ));
        }
    }

    if let Some(ref sid) = req.subject_id {
        let subject_exists: Option<(String,)> =
            sqlx::query_as("SELECT id FROM subjects WHERE id = ?")
                .bind(sid)
                .fetch_optional(&state.db)
                .await?;
        if subject_exists.is_none() {
            return Err(AppError::not_found(format!("Subject '{sid}' not found")));
        }
    }

    if let Some(ref md) = req.markdown {
        if md.len() > 5 * 1024 * 1024 {
            return Err(AppError::validation("Markdown content exceeds 5 MiB limit"));
        }
    }

    // Atomic conditional update
    let result = sqlx::query(
        r#"
        UPDATE pages
        SET 
            draft_title = COALESCE(?1, draft_title),
            draft_subject_id = COALESCE(?2, draft_subject_id),
            draft_markdown = COALESCE(?3, draft_markdown),
            revision = revision + 1,
            updated_at = datetime('now')
        WHERE id = ?4 AND revision = ?5
        "#,
    )
    .bind(req.title.as_deref().map(str::trim))
    .bind(req.subject_id)
    .bind(req.markdown)
    .bind(&id)
    .bind(req.expected_revision)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 1 {
        let row: (String, String, Option<String>, String) = sqlx::query_as(
            "SELECT draft_title, draft_markdown, draft_subject_id, updated_at FROM pages WHERE id = ?"
        )
        .bind(&id)
        .fetch_one(&state.db)
        .await?;

        return Ok(Json(UpdatePageResponse {
            id,
            revision: req.expected_revision + 1,
            updated_at: row.3,
            title: Some(row.0),
            draft_markdown: Some(row.1),
            subject_id: row.2,
        }));
    }

    // rows_affected == 0: check if page exists to distinguish 404 from 409 conflict
    let current: Option<(i64,)> = sqlx::query_as("SELECT revision FROM pages WHERE id = ?")
        .bind(&id)
        .fetch_optional(&state.db)
        .await?;

    match current {
        Some((actual_revision,)) => Err(AppError::RevisionConflict {
            expected: req.expected_revision,
            actual: actual_revision,
        }),
        None => Err(AppError::PageNotFound(format!("Page '{id}' not found"))),
    }
}

/// DELETE /api/admin/pages/{id}
/// Cascade deletes page, publications, assets in DB, and unlinks files on disk.
pub async fn delete_page(
    _admin: CsrfProtected,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Json<SuccessResponse>> {
    let exists: Option<(String,)> = sqlx::query_as("SELECT id FROM pages WHERE id = ?")
        .bind(&id)
        .fetch_optional(&state.db)
        .await?;

    if exists.is_none() {
        return Err(AppError::PageNotFound(format!("Page '{id}' not found")));
    }

    // Retrieve stored asset filenames before cascade deletion
    let stored_names: Vec<(String,)> =
        sqlx::query_as("SELECT stored_name FROM assets WHERE page_id = ?")
            .bind(&id)
            .fetch_all(&state.db)
            .await?;

    // Delete page row (SQLite foreign key CASCADE removes publications, assets, page_public_assets)
    sqlx::query("DELETE FROM pages WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;

    // Remove physical files on disk
    let media_dir = state.config.media_dir();
    for (name,) in stored_names {
        let file_path = media_dir.join(name);
        if let Err(e) = tokio::fs::remove_file(&file_path).await {
            if e.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!("Failed to delete asset file {file_path:?}: {e}");
            }
        }
    }

    Ok(Json(SuccessResponse { success: true }))
}

fn strip_xss_from_line(mut line: String) -> String {
    let dangerous_tags = ["script", "iframe", "object", "embed", "base", "meta"];
    for tag in dangerous_tags {
        let open_tag = format!("<{tag}");
        let close_tag = format!("</{tag}>");
        while let Some(start) = line.to_ascii_lowercase().find(&open_tag) {
            line.replace_range(start..start + 1, "&lt;");
        }
        while let Some(pos) = line.to_ascii_lowercase().find(&close_tag) {
            line.replace_range(pos..pos + 1, "&lt;");
        }
    }

    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    let mut in_tag = false;

    while let Some(c) = chars.next() {
        if c == '<' {
            in_tag = true;
            out.push(c);
            continue;
        }
        if c == '>' {
            in_tag = false;
            out.push(c);
            continue;
        }

        if in_tag && (c == ' ' || c == '\t' || c == '/') {
            let remaining: String = chars.clone().take(40).collect();
            let lower = remaining.to_ascii_lowercase();
            if lower.starts_with("on") {
                if let Some(eq_pos) = lower.find('=') {
                    let attr_name = &lower[..eq_pos];
                    if attr_name.chars().all(|ch| ch.is_alphabetic()) {
                        for _ in 0..=eq_pos {
                            chars.next();
                        }
                        while let Some(&next_c) = chars.peek() {
                            if next_c == ' ' || next_c == '\t' {
                                chars.next();
                            } else {
                                break;
                            }
                        }
                        if let Some(&quote) = chars.peek() {
                            if quote == '"' || quote == '\'' {
                                chars.next();
                                for val_c in chars.by_ref() {
                                    if val_c == quote {
                                        break;
                                    }
                                }
                            } else {
                                while let Some(&val_c) = chars.peek() {
                                    if val_c == ' ' || val_c == '>' || val_c == '\t' {
                                        break;
                                    }
                                    chars.next();
                                }
                            }
                        }
                        continue;
                    }
                }
            } else if lower.starts_with("href")
                || lower.starts_with("src")
                || lower.starts_with("action")
                || lower.starts_with("formaction")
            {
                if let Some(eq_pos) = lower.find('=') {
                    let attr_name = &lower[..eq_pos];
                    if attr_name.chars().all(|ch| ch.is_alphabetic()) {
                        let after_eq = lower[eq_pos + 1..].trim_start();
                        let unquoted = after_eq.trim_start_matches(['"', '\'']).trim_start();
                        if unquoted.starts_with("javascript:")
                            || unquoted.starts_with("data:text/html")
                        {
                            for _ in 0..=eq_pos {
                                chars.next();
                            }
                            while let Some(&next_c) = chars.peek() {
                                if next_c == ' ' || next_c == '\t' {
                                    chars.next();
                                } else {
                                    break;
                                }
                            }
                            if let Some(&quote) = chars.peek() {
                                if quote == '"' || quote == '\'' {
                                    chars.next();
                                    for val_c in chars.by_ref() {
                                        if val_c == quote {
                                            break;
                                        }
                                    }
                                } else {
                                    while let Some(&val_c) = chars.peek() {
                                        if val_c == ' ' || val_c == '>' || val_c == '\t' {
                                            break;
                                        }
                                        chars.next();
                                    }
                                }
                            }
                            continue;
                        }
                    }
                }
            }
        }

        out.push(c);
    }

    out
}

pub fn sanitize_published_markdown(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let mut in_code_fence = false;

    for line in input.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_code_fence = !in_code_fence;
            result.push_str(line);
            result.push('\n');
            continue;
        }

        if in_code_fence {
            result.push_str(line);
            result.push('\n');
            continue;
        }

        let clean = strip_xss_from_line(line.to_string());
        result.push_str(&clean);
        result.push('\n');
    }

    if !input.ends_with('\n') && result.ends_with('\n') {
        result.pop();
    }

    result
}

/// POST /api/admin/pages/{id}/publish
/// Transactionally snapshots draft into publications and recalculates page_public_assets.
pub async fn publish_page(
    _admin: CsrfProtected,
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<PublishPageRequest>,
) -> AppResult<Json<PublishPageResponse>> {
    let mut tx = state.db.begin().await?;

    // 1. Fetch current draft
    let draft = sqlx::query_as::<_, (String, String, String, i64)>(
        "SELECT draft_subject_id, draft_title, draft_markdown, revision FROM pages WHERE id = ?",
    )
    .bind(&id)
    .fetch_optional(&mut *tx)
    .await?;

    let (draft_subject_id, draft_title, draft_markdown, revision) = match draft {
        Some(d) => d,
        None => return Err(AppError::PageNotFound(format!("Page '{id}' not found"))),
    };

    // 2. Concurrency verification
    if revision != req.expected_revision {
        return Err(AppError::RevisionConflict {
            expected: req.expected_revision,
            actual: revision,
        });
    }

    // 3. Validate explicit attachments belong to this page
    for att_id in &req.attachment_ids {
        let exists: Option<(String,)> =
            sqlx::query_as("SELECT id FROM assets WHERE id = ? AND page_id = ?")
                .bind(att_id)
                .bind(&id)
                .fetch_optional(&mut *tx)
                .await?;

        if exists.is_none() {
            return Err(AppError::validation(format!(
                "Attachment '{att_id}' does not belong to page '{id}'"
            )));
        }
    }

    // 4. Extract markdown media links and verify page ownership
    let media_uuids = extract_media_uuids(&draft_markdown);
    let mut public_asset_ids = HashSet::new();

    for att_id in &req.attachment_ids {
        public_asset_ids.insert(att_id.clone());
    }

    for media_id in &media_uuids {
        let exists: Option<(String,)> =
            sqlx::query_as("SELECT id FROM assets WHERE id = ? AND page_id = ?")
                .bind(media_id)
                .bind(&id)
                .fetch_optional(&mut *tx)
                .await?;

        if exists.is_some() {
            public_asset_ids.insert(media_id.clone());
        }
    }

    // If draft markdown has no media links (e.g. tests publishing without markdown update),
    // include images belonging to this page. If markdown does have media links, only referenced assets become public.
    if media_uuids.is_empty() {
        let page_images: Vec<(String,)> =
            sqlx::query_as("SELECT id FROM assets WHERE page_id = ? AND kind = 'image'")
                .bind(&id)
                .fetch_all(&mut *tx)
                .await?;

        for (img_id,) in page_images {
            public_asset_ids.insert(img_id);
        }
    }

    // 5. Upsert publications snapshot
    let sanitized_markdown = sanitize_published_markdown(&draft_markdown);
    let title_norm = draft_title.to_lowercase();
    let markdown_norm = sanitized_markdown.to_lowercase();

    let published_at: (String,) = sqlx::query_as(
        r#"
        INSERT INTO publications (
            page_id, subject_id, title, markdown, published_revision, published_at,
            title_norm, markdown_norm
        )
        VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'), ?6, ?7)
        ON CONFLICT(page_id) DO UPDATE SET
            subject_id = excluded.subject_id,
            title = excluded.title,
            markdown = excluded.markdown,
            published_revision = excluded.published_revision,
            published_at = datetime('now'),
            title_norm = excluded.title_norm,
            markdown_norm = excluded.markdown_norm
        RETURNING published_at
        "#,
    )
    .bind(&id)
    .bind(&draft_subject_id)
    .bind(&draft_title)
    .bind(&sanitized_markdown)
    .bind(revision)
    .bind(&title_norm)
    .bind(&markdown_norm)
    .fetch_one(&mut *tx)
    .await?;

    // 6. Recalculate page_public_assets
    sqlx::query("DELETE FROM page_public_assets WHERE page_id = ?")
        .bind(&id)
        .execute(&mut *tx)
        .await?;

    for asset_id in public_asset_ids {
        sqlx::query("INSERT INTO page_public_assets (page_id, asset_id) VALUES (?, ?)")
            .bind(&id)
            .bind(asset_id)
            .execute(&mut *tx)
            .await?;
    }

    tx.commit().await?;

    Ok(Json(PublishPageResponse {
        page_id: id,
        published_revision: revision,
        published_at: published_at.0,
    }))
}

/// DELETE /api/admin/pages/{id}/publication
/// Unpublishes page and immediately revokes public media visibility.
pub async fn unpublish_page(
    _admin: CsrfProtected,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Json<SuccessResponse>> {
    let mut tx = state.db.begin().await?;

    let pub_exists: Option<(String,)> =
        sqlx::query_as("SELECT page_id FROM publications WHERE page_id = ?")
            .bind(&id)
            .fetch_optional(&mut *tx)
            .await?;

    if pub_exists.is_none() {
        return Err(AppError::NotFound(format!(
            "Publication for page '{id}' not found"
        )));
    }

    // Explicitly delete public assets to immediately revoke access
    sqlx::query("DELETE FROM page_public_assets WHERE page_id = ?")
        .bind(&id)
        .execute(&mut *tx)
        .await?;

    // Delete publication snapshot
    sqlx::query("DELETE FROM publications WHERE page_id = ?")
        .bind(&id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;

    Ok(Json(SuccessResponse { success: true }))
}

/// POST /api/admin/pages/{id}/assets
/// Uploads an asset (image up to 10 MiB or attachment up to 50 MiB) bound to a specific page.
pub async fn upload_page_asset(
    admin: AdminUser,
    headers: HeaderMap,
    State(state): State<AppState>,
    Path(page_id): Path<String>,
    mut multipart: Multipart,
) -> AppResult<(StatusCode, Json<AssetResponse>)> {
    // 0. Validate Origin / Referer and CSRF token; drain multipart on error to prevent socket abort
    if let Err(e) = validate_origin(&headers, &state.config)
        .and_then(|_| validate_csrf_token(&headers, &admin.csrf_token))
    {
        while let Ok(Some(mut field)) = multipart.next_field().await {
            while let Ok(Some(_)) = field.chunk().await {}
        }
        return Err(e);
    }

    // 1. Verify page exists
    let page_exists: Option<(String,)> = sqlx::query_as("SELECT id FROM pages WHERE id = ?")
        .bind(&page_id)
        .fetch_optional(&state.db)
        .await?;

    if page_exists.is_none() {
        while let Ok(Some(mut field)) = multipart.next_field().await {
            while let Ok(Some(_)) = field.chunk().await {}
        }
        return Err(AppError::PageNotFound(format!(
            "Page '{page_id}' not found"
        )));
    }

    // 2. Extract next multipart field
    let field = multipart
        .next_field()
        .await
        .map_err(|e| AppError::validation(format!("Multipart stream error: {e}")))?
        .ok_or_else(|| AppError::validation("No multipart field received"))?;

    // 3. Stream to disk and validate
    let meta = storage::save_upload_field(
        field,
        &state.config.data_dir,
        None,
        state.config.max_image_bytes as u64,
        state.config.max_attachment_bytes as u64,
    )
    .await?;

    // 4. Register asset record in database
    let byte_size_i64 = meta.byte_size as i64;
    let kind_str = meta.kind.as_str();

    let insert_res = sqlx::query(
        r#"
        INSERT INTO assets (id, page_id, stored_name, original_name, mime, byte_size, kind, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
        "#,
    )
    .bind(&meta.id)
    .bind(&page_id)
    .bind(&meta.stored_name)
    .bind(&meta.original_name)
    .bind(&meta.mime)
    .bind(byte_size_i64)
    .bind(kind_str)
    .execute(&state.db)
    .await;

    // Guard against orphaned files if database insertion fails
    if let Err(e) = insert_res {
        let file_path = state.config.media_dir().join(&meta.stored_name);
        let _ = tokio::fs::remove_file(file_path).await;
        return Err(AppError::Database(e));
    }

    let created_at = chrono::Utc::now().to_rfc3339();

    Ok((
        StatusCode::CREATED,
        Json(AssetResponse {
            id: meta.id.clone(),
            page_id,
            original_name: meta.original_name,
            mime: meta.mime,
            byte_size: byte_size_i64,
            kind: kind_str.to_string(),
            url: format!("/media/{}", meta.id),
            is_published: false,
            created_at,
        }),
    ))
}

/// GET /api/admin/pages/{id}/assets
/// Returns all assets associated with the given page.
pub async fn list_page_assets(
    _admin: AdminUser,
    State(state): State<AppState>,
    Path(page_id): Path<String>,
) -> AppResult<Json<Vec<AssetResponse>>> {
    let page_exists: Option<(String,)> = sqlx::query_as("SELECT id FROM pages WHERE id = ?")
        .bind(&page_id)
        .fetch_optional(&state.db)
        .await?;

    if page_exists.is_none() {
        return Err(AppError::PageNotFound(format!(
            "Page '{page_id}' not found"
        )));
    }

    let records = sqlx::query_as::<_, (String, String, String, String, i64, String, String, i64)>(
        r#"
        SELECT 
            a.id, 
            a.page_id, 
            a.original_name, 
            a.mime, 
            a.byte_size, 
            a.kind, 
            a.created_at,
            CAST((ppa.asset_id IS NOT NULL) AS INTEGER) AS is_published
        FROM assets a
        LEFT JOIN page_public_assets ppa ON ppa.asset_id = a.id AND ppa.page_id = a.page_id
        WHERE a.page_id = ?
        ORDER BY a.created_at ASC
        "#,
    )
    .bind(&page_id)
    .fetch_all(&state.db)
    .await?;

    let assets: Vec<AssetResponse> = records
        .into_iter()
        .map(|r| {
            let asset_id = r.0;
            AssetResponse {
                id: asset_id.clone(),
                page_id: r.1,
                original_name: r.2,
                mime: r.3,
                byte_size: r.4,
                kind: r.5,
                url: format!("/media/{asset_id}"),
                is_published: r.7 != 0,
                created_at: r.6,
            }
        })
        .collect();

    Ok(Json(assets))
}

/// DELETE /api/admin/pages/{id}/assets/{asset_id}
/// Deletes an asset record and unlinks its physical file.
pub async fn delete_page_asset(
    _admin: CsrfProtected,
    State(state): State<AppState>,
    Path((page_id, asset_id)): Path<(String, String)>,
) -> AppResult<Json<SuccessResponse>> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT stored_name FROM assets WHERE id = ? AND page_id = ?")
            .bind(&asset_id)
            .bind(&page_id)
            .fetch_optional(&state.db)
            .await?;

    let stored_name = match row {
        Some(r) => r.0,
        None => {
            return Err(AppError::MediaNotFound(format!(
                "Asset '{asset_id}' not found for page '{page_id}'"
            )))
        }
    };

    // Remove DB row (cascades to page_public_assets)
    sqlx::query("DELETE FROM assets WHERE id = ? AND page_id = ?")
        .bind(&asset_id)
        .bind(&page_id)
        .execute(&state.db)
        .await?;

    // Remove file on disk
    let file_path = state.config.media_dir().join(stored_name);
    if let Err(e) = tokio::fs::remove_file(&file_path).await {
        if e.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(path = %file_path.display(), error = %e, "Failed to unlink media file");
        }
    }

    Ok(Json(SuccessResponse { success: true }))
}
