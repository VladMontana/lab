//! Media asset serving route with dynamic visibility gating.

use axum::{
    extract::{Path, Request, State},
    http::{header, HeaderName, HeaderValue},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use tower::ServiceExt;
use tower_http::services::fs::ServeFile;
use uuid::Uuid;

use crate::{
    auth::OptionalAdminUser,
    error::{AppError, AppResult},
    AppState,
};

pub fn router() -> Router<AppState> {
    Router::new().route("/media/{id}", get(serve_media_handler))
}

/// Formats an RFC 5987 / RFC 6266 compliant Content-Disposition header.
pub fn format_content_disposition(kind: &str, original_name: &str) -> String {
    let disposition_type = if kind == "image" {
        "inline"
    } else {
        "attachment"
    };

    // ASCII-safe fallback
    let ascii_fallback: String = original_name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let ascii_name = if ascii_fallback.is_empty() {
        "file"
    } else {
        &ascii_fallback
    };

    // Percent-encode UTF-8 name for filename*
    let mut encoded = String::new();
    for byte in original_name.as_bytes() {
        match *byte {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                encoded.push(*byte as char);
            }
            b => {
                use std::fmt::Write;
                let _ = write!(encoded, "%{:02X}", b);
            }
        }
    }

    format!("{disposition_type}; filename=\"{ascii_name}\"; filename*=UTF-8''{encoded}")
}

/// GET /media/{id}
/// Dynamically gates media assets based on publication state and admin session.
pub async fn serve_media_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
    admin_opt: OptionalAdminUser,
    req: Request,
) -> AppResult<Response> {
    // 1. Sanitize asset ID: must parse as valid UUID
    if Uuid::parse_str(&id).is_err() {
        return Err(AppError::MediaNotFound(
            "Invalid media identifier".to_string(),
        ));
    }

    // 2. Query asset metadata and determine if it belongs to an active publication
    let row = sqlx::query_as::<_, (String, String, String, String, i64, String, i64)>(
        r#"
        SELECT 
            a.id,
            a.stored_name,
            a.original_name,
            a.mime,
            a.byte_size,
            a.kind,
            CAST(EXISTS(
                SELECT 1 
                FROM page_public_assets ppa
                JOIN publications pub ON pub.page_id = ppa.page_id
                WHERE ppa.asset_id = a.id
            ) AS INTEGER) AS is_public
        FROM assets a
        WHERE a.id = ?
        "#,
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await?;

    let asset = match row {
        Some(a) => a,
        None => return Err(AppError::MediaNotFound("Media not found".to_string())),
    };

    let is_public = asset.6 == 1;

    // 3. Evaluate visibility gating
    if !is_public && admin_opt.0.is_none() {
        // MUST return 404, NOT 403, to prevent asset enumeration
        return Err(AppError::MediaNotFound("Media not found".to_string()));
    }

    // 4. Verify physical file exists on disk
    let file_path = state.config.media_dir().join(&asset.1);
    if !file_path.exists() {
        tracing::error!(asset_id = %id, path = %file_path.display(), "Physical media file missing from disk");
        return Err(AppError::MediaNotFound(
            "Media file missing from storage".to_string(),
        ));
    }

    // 5. Serve file using tower-http ServeFile (supports Range/206 and streaming)
    let serve_service = ServeFile::new(&file_path);
    let mut response = serve_service
        .oneshot(req)
        .await
        .map_err(|e| AppError::internal(format!("Failed to stream media file: {e}")))?
        .into_response();

    // 6. Set required security, caching, and disposition headers
    let headers = response.headers_mut();

    // Content-Type
    if let Ok(val) = HeaderValue::from_str(&asset.3) {
        headers.insert(header::CONTENT_TYPE, val);
    }

    // X-Content-Type-Options: nosniff
    headers.insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );

    // Content-Disposition
    let disposition = format_content_disposition(&asset.5, &asset.2);
    if let Ok(val) = HeaderValue::from_str(&disposition) {
        headers.insert(header::CONTENT_DISPOSITION, val);
    }

    // Cache-Control
    if is_public {
        headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=31536000, immutable"),
        );
    } else {
        headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("private, no-cache"),
        );
    }

    Ok(response)
}
