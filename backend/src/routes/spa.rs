//! Static file serving & SPA fallback for pre-compiled frontend/dist.
//! Serves frontend assets and falls back to index.html for client-side routing,
//! while strictly rejecting /api/* and /media/* from fallback.

use axum::{
    body::Body,
    http::{header, HeaderValue, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use std::path::{Component, Path, PathBuf};

/// Resolves the frontend distribution directory from environment or standard paths.
pub fn resolve_frontend_dist_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("FRONTEND_DIST_DIR") {
        let p = PathBuf::from(dir);
        if p.exists() {
            return p;
        }
    }
    let candidates = [
        PathBuf::from("frontend/dist"),
        PathBuf::from("../frontend/dist"),
        PathBuf::from("./dist"),
        PathBuf::from("/app/frontend/dist"),
        PathBuf::from("/app/dist"),
    ];
    candidates
        .into_iter()
        .find(|p| p.exists())
        .unwrap_or_else(|| PathBuf::from("frontend/dist"))
}

/// Fallback handler for client-side SPA routing and static assets.
pub async fn spa_fallback_handler(method: Method, uri: Uri) -> Response {
    let raw_path = uri.path();

    // Normalize path by stripping redundant leading slashes for routing checks
    let trimmed_path = raw_path.trim_start_matches('/');
    let lower_trimmed = trimmed_path.to_ascii_lowercase();

    // Invariant 1: Method must be GET or HEAD.
    // Non-GET/HEAD requests to unmatched routes must return JSON 404, never SPA index.html
    if method != Method::GET && method != Method::HEAD {
        return json_not_found(raw_path);
    }

    // Invariant 2: Fallback Guard for /api and /media
    // Any unmatched route under /api or /media (including //api or //media) must return JSON 404 envelope.
    if lower_trimmed == "api"
        || lower_trimmed.starts_with("api/")
        || lower_trimmed == "media"
        || lower_trimmed.starts_with("media/")
    {
        return json_not_found(raw_path);
    }

    // Invariant 3: Path Traversal Defense
    // Layer 1: Check raw and percent-decoded path for traversal sequences (.., backslash, null bytes, percent-encoded variants)
    let lower_path = raw_path.to_ascii_lowercase();
    let decoded_path = percent_decode(&lower_path);
    let double_decoded = percent_decode(&decoded_path);

    if lower_path.contains("..")
        || lower_path.contains('\\')
        || lower_path.contains('\0')
        || lower_path.contains("%2e")
        || lower_path.contains("%5c")
        || lower_path.contains("%00")
        || decoded_path.contains("..")
        || decoded_path.contains('\\')
        || decoded_path.contains('\0')
        || double_decoded.contains("..")
        || double_decoded.contains('\\')
        || double_decoded.contains('\0')
    {
        return (
            StatusCode::BAD_REQUEST,
            [(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            )],
            serde_json::to_string(&crate::error::ErrorResponse {
                error: crate::error::ErrorDetail {
                    code: "BAD_REQUEST".to_string(),
                    message: "Invalid path traversal attempt".to_string(),
                },
            })
            .unwrap_or_default(),
        )
            .into_response();
    }

    // Layer 2: Path component check: ensure every component is Normal
    for component in Path::new(trimmed_path).components() {
        match component {
            Component::Normal(_) => {}
            _ => {
                return (
                    StatusCode::BAD_REQUEST,
                    [(
                        header::CONTENT_TYPE,
                        HeaderValue::from_static("application/json"),
                    )],
                    serde_json::to_string(&crate::error::ErrorResponse {
                        error: crate::error::ErrorDetail {
                            code: "BAD_REQUEST".to_string(),
                            message: "Invalid path component".to_string(),
                        },
                    })
                    .unwrap_or_default(),
                )
                    .into_response();
            }
        }
    }

    let dist_dir = resolve_frontend_dist_dir();

    // Check if a static file exists on disk
    if !trimmed_path.is_empty() {
        let target_file = dist_dir.join(trimmed_path);

        // Layer 3: Canonical verification: ensure target_file is strictly within dist_dir
        if let (Ok(canonical_target), Ok(canonical_dist)) =
            (target_file.canonicalize(), dist_dir.canonicalize())
        {
            if !canonical_target.starts_with(&canonical_dist) {
                return json_not_found(raw_path);
            }

            if canonical_target.is_file() {
                let content_type = detect_mime_header(&canonical_target);
                let cache_control = if lower_trimmed.starts_with("assets/") {
                    // Vite hashed assets are immutable
                    "public, max-age=31536000, immutable"
                } else if lower_trimmed == "index.html" || lower_trimmed.ends_with(".html") {
                    // HTML entrypoints must never be cached across deploys
                    "no-cache"
                } else {
                    // Other static files (e.g. favicon.ico, robots.txt)
                    "public, max-age=3600"
                };

                if method == Method::HEAD {
                    return (
                        StatusCode::OK,
                        [
                            (header::CONTENT_TYPE, content_type),
                            (
                                header::CACHE_CONTROL,
                                HeaderValue::from_static(cache_control),
                            ),
                        ],
                        Body::empty(),
                    )
                        .into_response();
                }

                if let Ok(bytes) = tokio::fs::read(&canonical_target).await {
                    return (
                        StatusCode::OK,
                        [
                            (header::CONTENT_TYPE, content_type),
                            (
                                header::CACHE_CONTROL,
                                HeaderValue::from_static(cache_control),
                            ),
                        ],
                        bytes,
                    )
                        .into_response();
                }
            }
        }
    }

    // Invariant 4: Missing Static Assets Guard
    // Any unmatched request starting with /assets/ MUST return 404, never index.html
    if lower_trimmed == "assets" || lower_trimmed.starts_with("assets/") {
        return (
            StatusCode::NOT_FOUND,
            [(
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/plain; charset=utf-8"),
            )],
            "Asset not found",
        )
            .into_response();
    }

    // Invariant 4b: File Extension & System Directory Guard
    // Any unmatched request with a file extension or system directory path MUST return 404
    let last_segment = trimmed_path.rsplit('/').next().unwrap_or(trimmed_path);
    let has_file_extension = last_segment.contains('.') && !last_segment.ends_with(".html");
    let is_system_dir = lower_trimmed.starts_with("etc/")
        || lower_trimmed.starts_with("windows/")
        || lower_trimmed.starts_with("proc/")
        || lower_trimmed.starts_with("sys/");

    if has_file_extension || is_system_dir {
        return (
            StatusCode::NOT_FOUND,
            [(
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/plain; charset=utf-8"),
            )],
            "Not found",
        )
            .into_response();
    }

    // Invariant 5: SPA Client-Side Routing Fallback
    // Return index.html with Cache-Control: no-cache
    let index_file = dist_dir.join("index.html");
    if let Ok(html) = tokio::fs::read_to_string(&index_file).await {
        if method == Method::HEAD {
            return (
                StatusCode::OK,
                [
                    (
                        header::CONTENT_TYPE,
                        HeaderValue::from_static("text/html; charset=utf-8"),
                    ),
                    (header::CACHE_CONTROL, HeaderValue::from_static("no-cache")),
                ],
                Body::empty(),
            )
                .into_response();
        }

        return (
            StatusCode::OK,
            [
                (
                    header::CONTENT_TYPE,
                    HeaderValue::from_static("text/html; charset=utf-8"),
                ),
                (header::CACHE_CONTROL, HeaderValue::from_static("no-cache")),
            ],
            html,
        )
            .into_response();
    }

    // If dist/index.html is not found on disk, return 404 JSON
    json_not_found(raw_path)
}

fn json_not_found(path: &str) -> Response {
    (
        StatusCode::NOT_FOUND,
        [(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        )],
        serde_json::to_string(&crate::error::ErrorResponse {
            error: crate::error::ErrorDetail {
                code: "NOT_FOUND".to_string(),
                message: format!("Resource not found: {path}"),
            },
        })
        .unwrap_or_default(),
    )
        .into_response()
}

fn detect_mime_header(path: &Path) -> HeaderValue {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => HeaderValue::from_static("text/html; charset=utf-8"),
        "css" => HeaderValue::from_static("text/css; charset=utf-8"),
        "js" | "mjs" => HeaderValue::from_static("application/javascript; charset=utf-8"),
        "json" | "map" => HeaderValue::from_static("application/json"),
        "svg" => HeaderValue::from_static("image/svg+xml"),
        "png" => HeaderValue::from_static("image/png"),
        "jpg" | "jpeg" => HeaderValue::from_static("image/jpeg"),
        "webp" => HeaderValue::from_static("image/webp"),
        "ico" => HeaderValue::from_static("image/x-icon"),
        "woff" => HeaderValue::from_static("font/woff"),
        "woff2" => HeaderValue::from_static("font/woff2"),
        "txt" => HeaderValue::from_static("text/plain; charset=utf-8"),
        _ => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            HeaderValue::try_from(mime.as_ref())
                .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream"))
        }
    }
}

fn percent_decode(s: &str) -> String {
    let mut bytes = Vec::with_capacity(s.len());
    let src = s.as_bytes();
    let mut i = 0;
    while i < src.len() {
        if src[i] == b'%' && i + 2 < src.len() {
            if let (Some(d1), Some(d2)) = (hex_val(src[i + 1]), hex_val(src[i + 2])) {
                bytes.push((d1 << 4) | d2);
                i += 3;
                continue;
            }
        }
        bytes.push(src[i]);
        i += 1;
    }
    String::from_utf8_lossy(&bytes).to_string()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_percent_decode_standard() {
        assert_eq!(percent_decode("hello%20world"), "hello world");
        assert_eq!(percent_decode("%2e%2e%2f"), "../");
        assert_eq!(percent_decode("%2E%2E%5C"), "..\\");
    }

    #[test]
    fn test_percent_decode_malformed_preserves_characters() {
        assert_eq!(percent_decode("%2g"), "%2g");
        assert_eq!(percent_decode("%g2"), "%g2");
        assert_eq!(percent_decode("%"), "%");
        assert_eq!(percent_decode("%2"), "%2");
        assert_eq!(percent_decode("%2%2e"), "%2.");
        assert_eq!(percent_decode("%%2e"), "%.");
    }
}
