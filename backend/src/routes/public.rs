//! Public read-only catalog, search, and page detail routes.

use axum::{
    extract::{rejection::QueryRejection, Path, Query, State},
    routing::get,
    Json, Router,
};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    models::{
        PublicAttachmentItem, PublicPageItem, PublicPageListResponse, PublicPageQuery,
        PublicPageViewResponse, PublicSubjectItem,
    },
    AppState,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/public/subjects", get(list_public_subjects))
        .route("/api/public/pages", get(list_public_pages))
        .route("/api/public/pages/{id}", get(get_public_page))
}

/// Escapes special SQLite LIKE wildcard characters (`%`, `_`, `\`)
/// and wraps the pattern with `%...%` in lowercase.
pub fn escape_like_pattern(raw: &str) -> String {
    let mut escaped = String::with_capacity(raw.len() + 8);
    for c in raw.chars() {
        match c {
            '%' => escaped.push_str("\\%"),
            '_' => escaped.push_str("\\_"),
            '\\' => escaped.push_str("\\\\"),
            other => escaped.push(other),
        }
    }
    format!("%{}%", escaped.to_lowercase())
}

/// Strips markdown syntax elements and returns normalized plain text.
pub fn strip_markdown_to_plain_text(markdown: &str) -> String {
    let mut out = String::with_capacity(markdown.len());
    let mut in_code_fence = false;

    for line in markdown.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_code_fence = !in_code_fence;
            continue;
        }
        if in_code_fence || trimmed.is_empty() {
            continue;
        }

        // Strip heading markers (# Header)
        let text_line = if let Some(stripped) = trimmed.strip_prefix('#') {
            stripped.trim_start_matches('#').trim_start()
        } else if let Some(stripped) = trimmed.strip_prefix('>') {
            stripped.trim_start()
        } else if let Some(stripped) = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "))
            .or_else(|| trimmed.strip_prefix("+ "))
        {
            stripped.trim_start()
        } else if let Some(dot_idx) = trimmed.find(". ") {
            // Check for numbered list e.g. "1. "
            if !trimmed[..dot_idx].is_empty()
                && trimmed[..dot_idx].chars().all(|c| c.is_ascii_digit())
            {
                &trimmed[dot_idx + 2..]
            } else {
                trimmed
            }
        } else {
            trimmed
        };

        // Inline formatting stripper
        let mut chars = text_line.chars().peekable();
        while let Some(c) = chars.next() {
            match c {
                '!' => {
                    // Check for image syntax: ![alt](url)
                    if chars.peek() == Some(&'[') {
                        chars.next(); // consume '['
                        let mut alt = String::new();
                        for ch in chars.by_ref() {
                            if ch == ']' {
                                break;
                            }
                            alt.push(ch);
                        }
                        if chars.peek() == Some(&'(') {
                            chars.next(); // consume '('
                            for ch in chars.by_ref() {
                                if ch == ')' {
                                    break;
                                }
                            }
                        }
                        if !alt.is_empty() {
                            out.push_str(&alt);
                        }
                    } else {
                        out.push(c);
                    }
                }
                '[' => {
                    // Link syntax: [text](url) -> keep text, skip url
                    let mut link_text = String::new();
                    for ch in chars.by_ref() {
                        if ch == ']' {
                            break;
                        }
                        link_text.push(ch);
                    }
                    if chars.peek() == Some(&'(') {
                        chars.next(); // consume '('
                        for ch in chars.by_ref() {
                            if ch == ')' {
                                break;
                            }
                        }
                    }
                    out.push_str(&link_text);
                }
                '*' | '_' | '~' | '`' => {
                    // Skip emphasis and inline code markers
                }
                '<' => {
                    // HTML tag stripper: <...>
                    let mut tag = String::new();
                    let mut is_tag = false;
                    while let Some(&next_c) = chars.peek() {
                        chars.next();
                        if next_c == '>' {
                            is_tag = true;
                            break;
                        }
                        tag.push(next_c);
                        if tag.len() > 100 {
                            break;
                        }
                    }
                    if !is_tag {
                        out.push('<');
                        out.push_str(&tag);
                    }
                }
                _ => out.push(c),
            }
        }
        out.push(' ');
    }

    // Collapse multiple consecutive spaces
    let mut normalized = String::with_capacity(out.len());
    let mut prev_space = false;
    for c in out.chars() {
        if c.is_whitespace() {
            if !prev_space && !normalized.is_empty() {
                normalized.push(' ');
                prev_space = true;
            }
        } else {
            normalized.push(c);
            prev_space = false;
        }
    }
    if normalized.ends_with(' ') {
        normalized.pop();
    }
    normalized
}

/// Generates a clean preview snippet (~160 chars) centered around the search query if found.
pub fn generate_snippet(plain_text: &str, query: Option<&str>) -> String {
    let chars: Vec<char> = plain_text.chars().collect();
    if chars.is_empty() {
        return String::new();
    }

    let target_len = 160;
    if chars.len() <= target_len {
        return plain_text.to_string();
    }

    let query_match = query.and_then(|q| {
        let clean = q.trim();
        if clean.is_empty() {
            return None;
        }
        let q_chars: Vec<char> = clean.to_lowercase().chars().collect();
        if q_chars.is_empty() {
            return None;
        }
        let text_lower: Vec<char> = plain_text.to_lowercase().chars().collect();

        text_lower
            .windows(q_chars.len())
            .position(|w| w == q_chars.as_slice())
    });

    match query_match {
        Some(match_idx) => {
            let q_len = query.map(|q| q.trim().chars().count()).unwrap_or(0);
            let half_window = target_len.saturating_sub(q_len) / 2;
            let start = match_idx.saturating_sub(half_window);
            let end = (start + target_len).min(chars.len());
            let start = end.saturating_sub(target_len);

            let prefix = if start > 0 { "..." } else { "" };
            let suffix = if end < chars.len() { "..." } else { "" };

            let slice: String = chars[start..end].iter().collect();
            format!("{}{}{}", prefix, slice.trim(), suffix)
        }
        None => {
            let end = target_len.min(chars.len());
            let slice: String = chars[0..end].iter().collect();
            let suffix = if chars.len() > target_len { "..." } else { "" };
            format!("{}{}", slice.trim(), suffix)
        }
    }
}

/// GET /api/public/subjects
/// Returns all subjects that have at least one published page (`page_count > 0`),
/// ordered by `position ASC, name ASC`.
pub async fn list_public_subjects(
    State(state): State<AppState>,
) -> AppResult<Json<Vec<PublicSubjectItem>>> {
    let rows = sqlx::query_as::<_, (String, String, i64, i64)>(
        r#"
        SELECT 
            s.id, 
            s.name, 
            s.position, 
            CAST(COUNT(pub.page_id) AS INTEGER) AS page_count
        FROM subjects s
        INNER JOIN publications pub ON pub.subject_id = s.id
        GROUP BY s.id, s.name, s.position
        HAVING COUNT(pub.page_id) > 0
        ORDER BY s.position ASC, s.name ASC
        "#,
    )
    .fetch_all(&state.db)
    .await?;

    let items = rows
        .into_iter()
        .map(|(id, name, position, page_count)| PublicSubjectItem {
            id,
            name,
            position,
            page_count,
        })
        .collect();

    Ok(Json(items))
}

/// GET /api/public/pages
/// Retrieves paginated list of published pages with optional subject filtering and LIKE search.
pub async fn list_public_pages(
    State(state): State<AppState>,
    query: Result<Query<PublicPageQuery>, QueryRejection>,
) -> AppResult<Json<PublicPageListResponse>> {
    let Query(params) = query.map_err(AppError::from)?;

    // 1. Validate subject_id UUID if supplied
    let clean_subject_id = if let Some(ref sid) = params.subject_id {
        let trimmed = sid.trim();
        if !trimmed.is_empty() {
            if Uuid::parse_str(trimmed).is_err() {
                return Err(AppError::validation("Invalid subject_id UUID"));
            }
            Some(trimmed.to_string())
        } else {
            None
        }
    } else {
        None
    };

    // 2. Normalize search term and build escaped LIKE pattern
    let clean_query = params.q.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let escaped_pattern = clean_query.map(escape_like_pattern);

    // 3. Normalize pagination parameters
    let limit = params.limit.unwrap_or(20).clamp(1, 100);
    let offset = params.offset.unwrap_or(0).max(0);

    // 4. Construct dynamic WHERE clause
    let mut where_clauses = Vec::new();
    if clean_subject_id.is_some() {
        where_clauses.push("pub.subject_id = ?");
    }
    if escaped_pattern.is_some() {
        where_clauses
            .push("(pub.title_norm LIKE ? ESCAPE '\\' OR pub.markdown_norm LIKE ? ESCAPE '\\')");
    }

    let where_sql = if where_clauses.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", where_clauses.join(" AND "))
    };

    // 5. Execute search inside a single read transaction for snapshot isolation
    let mut tx = state.db.begin().await?;

    let count_sql = format!(
        "SELECT CAST(COUNT(*) AS INTEGER) FROM publications pub INNER JOIN subjects s ON pub.subject_id = s.id{}",
        where_sql
    );
    let mut count_query = sqlx::query_scalar::<_, i64>(&count_sql);
    if let Some(ref sid) = clean_subject_id {
        count_query = count_query.bind(sid);
    }
    if let Some(ref pat) = escaped_pattern {
        count_query = count_query.bind(pat).bind(pat);
    }
    let total = count_query.fetch_one(&mut *tx).await?;

    if total == 0 {
        tx.commit().await?;
        return Ok(Json(PublicPageListResponse {
            items: Vec::new(),
            total: 0,
            limit,
            offset,
        }));
    }

    // 6. Query paginated records within the same transaction snapshot
    let data_sql = format!(
        r#"
        SELECT 
            pub.page_id,
            pub.subject_id,
            s.name AS subject_name,
            pub.title,
            pub.markdown,
            pub.published_at
        FROM publications pub
        INNER JOIN subjects s ON pub.subject_id = s.id
        {}
        ORDER BY pub.published_at DESC, pub.title ASC
        LIMIT ? OFFSET ?
        "#,
        where_sql
    );
    let mut data_query =
        sqlx::query_as::<_, (String, String, String, String, String, String)>(&data_sql);
    if let Some(ref sid) = clean_subject_id {
        data_query = data_query.bind(sid);
    }
    if let Some(ref pat) = escaped_pattern {
        data_query = data_query.bind(pat).bind(pat);
    }
    data_query = data_query.bind(limit).bind(offset);

    let rows = data_query.fetch_all(&mut *tx).await?;
    tx.commit().await?;

    // 7. Generate plain text snippets
    let items = rows
        .into_iter()
        .map(
            |(id, subject_id, subject_name, title, markdown, published_at)| {
                let plain_text = strip_markdown_to_plain_text(&markdown);
                let snippet = generate_snippet(&plain_text, clean_query);
                PublicPageItem {
                    id,
                    subject_id,
                    subject_name,
                    title,
                    snippet,
                    published_at,
                }
            },
        )
        .collect();

    Ok(Json(PublicPageListResponse {
        items,
        total,
        limit,
        offset,
    }))
}

/// GET /api/public/pages/{id}
/// Retrieves a published page snapshot by UUID with public attachments.
/// Returns HTTP 404 `PAGE_NOT_FOUND` if malformed UUID, missing, or unpublished.
pub async fn get_public_page(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Json<PublicPageViewResponse>> {
    // 1. UUID sanity check: return 404 immediately on malformed UUID
    if Uuid::parse_str(&id).is_err() {
        return Err(AppError::PageNotFound("Public page not found".to_string()));
    }

    // 2. Fetch publication snapshot
    let pub_row = sqlx::query_as::<_, (String, String, String, String, String, String)>(
        r#"
        SELECT 
            pub.page_id,
            pub.subject_id,
            s.name AS subject_name,
            pub.title,
            pub.markdown,
            pub.published_at
        FROM publications pub
        INNER JOIN subjects s ON pub.subject_id = s.id
        WHERE pub.page_id = ?
        "#,
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await?;

    let (page_id, subject_id, subject_name, title, markdown, published_at) = match pub_row {
        Some(row) => row,
        None => return Err(AppError::PageNotFound("Public page not found".to_string())),
    };

    // 3. Fetch linked public attachments (excluding images)
    let attachment_rows = sqlx::query_as::<_, (String, String, i64, String)>(
        r#"
        SELECT 
            a.id,
            a.original_name,
            a.byte_size,
            a.mime
        FROM page_public_assets ppa
        INNER JOIN assets a ON ppa.asset_id = a.id
        WHERE ppa.page_id = ? AND a.kind = 'attachment'
        ORDER BY a.original_name ASC
        "#,
    )
    .bind(&id)
    .fetch_all(&state.db)
    .await?;

    let attachments = attachment_rows
        .into_iter()
        .map(
            |(att_id, original_name, byte_size, mime)| PublicAttachmentItem {
                id: att_id,
                original_name,
                byte_size,
                mime,
            },
        )
        .collect();

    Ok(Json(PublicPageViewResponse {
        id: page_id,
        subject_id,
        subject_name,
        title,
        markdown,
        published_at,
        attachments,
    }))
}
