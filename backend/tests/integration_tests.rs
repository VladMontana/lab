//! Unified integration test suite for Milestone 1.
//! Covers SQLite migrations, GET /healthz HTTP response, error envelope formatting,
//! and streaming storage validations.

use axum::{
    body::Body,
    extract::{Multipart, State},
    http::{header, Request, StatusCode},
    response::IntoResponse,
    routing::post,
    Json, Router,
};
use backend::{
    db::{init_test_db, run_migrations},
    error::{AppError, ErrorResponse},
    routes::healthz,
    storage::{
        detect_file_type, inspect_image_dimensions, sanitize_filename, save_upload_field,
        AssetKind, UploadedFileMeta,
    },
};
use http_body_util::BodyExt;
use sqlx::sqlite::SqlitePoolOptions;
use std::path::PathBuf;
use tempfile::tempdir;
use tower::ServiceExt;

// 1. Minimal PNG fixture (1x1 transparent PNG, 67 bytes)
const VALID_1X1_PNG: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
    0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, // 8-bit RGBA
    0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, // IDAT
    0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
    0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, // IEND
    0x42, 0x60, 0x82,
];

// 2. Minimal PDF fixture
const VALID_PDF: &[u8] = b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n";

// 3. Minimal ZIP fixture
const VALID_ZIP: &[u8] = &[
    0x50, 0x4B, 0x03, 0x04, 0x0A, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x74, 0x65, 0x73, 0x74,
];

// 4. Minimal JPEG header
const VALID_JPEG_HEADER: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46];

// 5. Minimal WebP header
const VALID_WEBP_HEADER: &[u8] = &[
    b'R', b'I', b'F', b'F', 0x20, 0x00, 0x00, 0x00, b'W', b'E', b'B', b'P',
];

#[tokio::test]
async fn test_healthz_endpoint_returns_ok() {
    let app = healthz::router();

    let response = app
        .oneshot(
            Request::builder()
                .uri("/healthz")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("Healthz request failed");

    assert_eq!(response.status(), StatusCode::OK);

    let body_bytes = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body_bytes).unwrap();
    assert_eq!(json["status"], "ok");
}

#[tokio::test]
async fn test_sqlite_migrations_create_all_seven_tables() {
    let pool = SqlitePoolOptions::new()
        .connect("sqlite::memory:")
        .await
        .expect("Failed to connect to in-memory SQLite");

    // Run SQLx migrations
    run_migrations(&pool)
        .await
        .expect("Database migrations failed");

    // Verify all 7 core tables exist
    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_sqlx_%' ORDER BY name"
    )
    .fetch_all(&pool)
    .await
    .expect("Failed to query sqlite_master");

    let expected_tables = vec![
        "admin",
        "assets",
        "page_public_assets",
        "pages",
        "publications",
        "sessions",
        "subjects",
    ];

    for expected in &expected_tables {
        assert!(
            tables.iter().any(|t| t == expected),
            "Expected table '{expected}' was not created by migrations"
        );
    }
}

#[tokio::test]
async fn test_sqlite_foreign_key_cascade_and_restrict() {
    let pool = init_test_db().await.expect("Failed to init test db");

    // 1. Insert a subject
    sqlx::query(
        "INSERT INTO subjects (id, name, position) VALUES ('sub-1', 'Computer Science', 1)",
    )
    .execute(&pool)
    .await
    .unwrap();

    // 2. Insert a page draft
    sqlx::query(
        "INSERT INTO pages (id, draft_subject_id, draft_title, draft_markdown, revision) VALUES ('page-1', 'sub-1', 'Lab 1', '# Hello', 1)"
    )
    .execute(&pool)
    .await
    .unwrap();

    // 3. Test RESTRICT on deleting subject with existing pages
    let delete_sub_res = sqlx::query("DELETE FROM subjects WHERE id = 'sub-1'")
        .execute(&pool)
        .await;
    assert!(
        delete_sub_res.is_err(),
        "Expected deleting subject with pages to fail under RESTRICT"
    );

    // 4. Insert publication, asset, and page_public_asset
    sqlx::query(
        "INSERT INTO publications (page_id, subject_id, title, markdown, published_revision) VALUES ('page-1', 'sub-1', 'Lab 1 Pub', '# Hello Pub', 1)"
    )
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO assets (id, page_id, stored_name, original_name, mime, byte_size, kind) VALUES ('ast-1', 'page-1', 'ast-1', 'pic.png', 'image/png', 100, 'image')"
    )
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query("INSERT INTO page_public_assets (page_id, asset_id) VALUES ('page-1', 'ast-1')")
        .execute(&pool)
        .await
        .unwrap();

    // 5. Test CHECK constraint on assets kind
    let check_err = sqlx::query(
        "INSERT INTO assets (id, page_id, stored_name, original_name, mime, byte_size, kind) VALUES ('ast-2', 'page-1', 'ast-2', 'bad.exe', 'application/octet-stream', 100, 'executable')"
    )
    .execute(&pool)
    .await;
    assert!(
        check_err.is_err(),
        "Expected invalid asset kind to fail CHECK constraint"
    );

    // 6. Delete page and verify CASCADE to publications, assets, and page_public_assets
    sqlx::query("DELETE FROM pages WHERE id = 'page-1'")
        .execute(&pool)
        .await
        .unwrap();

    let pub_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM publications WHERE page_id = 'page-1'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(pub_count, 0, "Publications must be deleted on page CASCADE");

    let asset_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM assets WHERE id = 'ast-1'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(asset_count, 0, "Assets must be deleted on page CASCADE");

    let ppa_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM page_public_assets WHERE page_id = 'page-1'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        ppa_count, 0,
        "page_public_assets must be deleted on page CASCADE"
    );

    // 7. Verify subject can now be deleted once pages are gone
    let delete_sub_ok = sqlx::query("DELETE FROM subjects WHERE id = 'sub-1'")
        .execute(&pool)
        .await;
    assert!(
        delete_sub_ok.is_ok(),
        "Subject with no pages should delete cleanly"
    );
}

#[tokio::test]
async fn test_detect_file_type_signatures() {
    // PNG
    let (kind, mime) = detect_file_type(VALID_1X1_PNG, "test.png", None).unwrap();
    assert_eq!(kind, AssetKind::Image);
    assert_eq!(mime, "image/png");

    // JPEG
    let (kind, mime) = detect_file_type(VALID_JPEG_HEADER, "test.jpg", None).unwrap();
    assert_eq!(kind, AssetKind::Image);
    assert_eq!(mime, "image/jpeg");

    // WebP
    let (kind, mime) = detect_file_type(VALID_WEBP_HEADER, "test.webp", None).unwrap();
    assert_eq!(kind, AssetKind::Image);
    assert_eq!(mime, "image/webp");

    // PDF
    let (kind, mime) = detect_file_type(VALID_PDF, "doc.pdf", None).unwrap();
    assert_eq!(kind, AssetKind::Attachment);
    assert_eq!(mime, "application/pdf");

    // ZIP
    let (kind, mime) = detect_file_type(VALID_ZIP, "archive.zip", None).unwrap();
    assert_eq!(kind, AssetKind::Attachment);
    assert_eq!(mime, "application/zip");

    // DOCX (ZIP signature with .docx extension)
    let (kind, mime) = detect_file_type(VALID_ZIP, "assignment.docx", None).unwrap();
    assert_eq!(kind, AssetKind::Attachment);
    assert_eq!(
        mime,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );

    // TXT
    let txt_bytes = b"Hello, world!\nLine two.";
    let (kind, mime) = detect_file_type(txt_bytes, "notes.txt", None).unwrap();
    assert_eq!(kind, AssetKind::Attachment);
    assert_eq!(mime, "text/plain");

    // MD
    let md_bytes = b"# Heading 1\nSome markdown text.";
    let (kind, mime) = detect_file_type(md_bytes, "README.md", None).unwrap();
    assert_eq!(kind, AssetKind::Attachment);
    assert_eq!(mime, "text/markdown");
}

#[tokio::test]
async fn test_strict_svg_rejection() {
    let svg_content = b"<svg xmlns=\"http://www.w3.org/2000/svg\"><circle r=\"10\"/></svg>";
    let err = detect_file_type(svg_content, "badge.svg", None).unwrap_err();
    assert!(matches!(err, AppError::SvgNotAllowed));

    let xml_svg = b"<?xml version=\"1.0\"?>\n<svg width=\"100\" height=\"100\"></svg>";
    let err2 = detect_file_type(xml_svg, "vector.xml", None).unwrap_err();
    assert!(matches!(err2, AppError::SvgNotAllowed));

    let disguised_svg = b"<SVG viewBox=\"0 0 100 100\"><rect/></svg>";
    let err3 = detect_file_type(disguised_svg, "image.png", None).unwrap_err();
    assert!(matches!(err3, AppError::SvgNotAllowed));
}

#[tokio::test]
async fn test_strict_html_rejection() {
    let html_content = b"<!DOCTYPE html><html><body><h1>XSS</h1></body></html>";
    let err = detect_file_type(html_content, "page.html", None).unwrap_err();
    assert!(matches!(err, AppError::UnsupportedMime(_)));

    let fragment = b"<html><script>alert(1)</script></html>";
    let err2 = detect_file_type(fragment, "fragment.txt", None).unwrap_err();
    assert!(matches!(err2, AppError::UnsupportedMime(_)));
}

#[tokio::test]
async fn test_filename_sanitization_path_traversal() {
    assert_eq!(
        sanitize_filename(Some("../../../../etc/passwd"), "default"),
        "passwd"
    );
    assert_eq!(
        sanitize_filename(Some("..\\..\\windows\\system32\\cmd.exe"), "default"),
        "cmd.exe"
    );
    assert_eq!(
        sanitize_filename(Some("my_photo\0.png"), "default"),
        "my_photo.png"
    );
    assert_eq!(
        sanitize_filename(Some("   ...hello report.pdf...   "), "default"),
        "hello report.pdf"
    );
    assert_eq!(
        sanitize_filename(Some("CON.txt"), "default"),
        "file_CON.txt"
    );
    assert_eq!(sanitize_filename(Some("PRN"), "default"), "file_PRN");
    assert_eq!(sanitize_filename(Some("../.."), "default"), "default");
    assert_eq!(sanitize_filename(None, "fallback.txt"), "fallback.txt");
}

#[tokio::test]
async fn test_image_dimension_inspection() {
    let dir = tempdir().unwrap();
    let img_path = dir.path().join("test_1x1.png");
    std::fs::write(&img_path, VALID_1X1_PNG).unwrap();

    let (width, height) = inspect_image_dimensions(&img_path).unwrap();
    assert_eq!(width, 1);
    assert_eq!(height, 1);

    // Corrupted image file
    let corrupt_path = dir.path().join("corrupt.png");
    std::fs::write(&corrupt_path, b"not a png image file at all").unwrap();
    let err = inspect_image_dimensions(&corrupt_path);
    assert!(err.is_err());
}

#[tokio::test]
async fn test_error_envelope_json_serialization() {
    // 1. Validation error
    let err = AppError::validation("Invalid title");
    let resp = err.into_response();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let json: ErrorResponse = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(json.error.code, "VALIDATION_ERROR");
    assert_eq!(json.error.message, "Invalid title");

    // 2. SVG not allowed
    let err = AppError::SvgNotAllowed;
    let resp = err.into_response();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let json: ErrorResponse = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(json.error.code, "SVG_NOT_ALLOWED");

    // 3. File too large
    let err = AppError::file_too_large(10_485_760);
    let resp = err.into_response();
    assert_eq!(resp.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let json: ErrorResponse = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(json.error.code, "FILE_TOO_LARGE");

    // 4. Rate limit exceeded with retry header
    let err = AppError::RateLimitExceeded {
        retry_after_secs: 45,
    };
    let resp = err.into_response();
    assert_eq!(resp.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(resp.headers().get(header::RETRY_AFTER).unwrap(), "45");
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let json: ErrorResponse = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(json.error.code, "RATE_LIMIT_EXCEEDED");

    // 5. Database error must not leak SQL details to client
    let sql_err = AppError::Database(sqlx::Error::RowNotFound);
    let resp = sql_err.into_response();
    assert_eq!(resp.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let json: ErrorResponse = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(json.error.code, "INTERNAL_ERROR");
    assert_eq!(json.error.message, "Internal server error");
}

#[tokio::test]
async fn test_streaming_upload_multipart_e2e() {
    let dir = tempdir().unwrap();
    let data_dir = dir.path().to_path_buf();

    // Create test upload router
    async fn test_upload_handler(
        State(dir): State<PathBuf>,
        mut multipart: Multipart,
    ) -> Result<Json<UploadedFileMeta>, AppError> {
        let field = multipart
            .next_field()
            .await
            .map_err(|e| AppError::validation(e.to_string()))?
            .ok_or_else(|| AppError::validation("No multipart field received"))?;

        let meta = save_upload_field(field, &dir, None, 10 * 1024 * 1024, 50 * 1024 * 1024).await?;

        Ok(Json(meta))
    }

    let router = Router::new()
        .route("/upload", post(test_upload_handler))
        .with_state(data_dir.clone());

    // 1. Upload valid PNG image
    let boundary = "------------------------boundary123456";
    let body_data = format!(
        "--{boundary}\r\n\
        Content-Disposition: form-data; name=\"file\"; filename=\"my_lab.png\"\r\n\
        Content-Type: image/png\r\n\r\n"
    );
    let mut multipart_body = Vec::new();
    multipart_body.extend_from_slice(body_data.as_bytes());
    multipart_body.extend_from_slice(VALID_1X1_PNG);
    multipart_body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

    let req = Request::builder()
        .method("POST")
        .uri("/upload")
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(Body::from(multipart_body))
        .unwrap();

    let resp = router.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let meta: UploadedFileMeta = serde_json::from_slice(&bytes).unwrap();

    assert_eq!(meta.original_name, "my_lab.png");
    assert_eq!(meta.mime, "image/png");
    assert_eq!(meta.kind, AssetKind::Image);
    assert_eq!(meta.width, Some(1));
    assert_eq!(meta.height, Some(1));
    assert_eq!(meta.byte_size, VALID_1X1_PNG.len() as u64);

    // Verify stored file exists on disk at data_dir/media/{id}
    let stored_file = data_dir.join("media").join(&meta.id);
    assert!(stored_file.exists(), "Stored file must exist in media dir");
    let content = std::fs::read(&stored_file).unwrap();
    assert_eq!(content, VALID_1X1_PNG);

    // Verify tmp directory has no leftover temp files
    let tmp_entries = std::fs::read_dir(data_dir.join("tmp")).unwrap();
    assert_eq!(
        tmp_entries.count(),
        0,
        "Temporary directory should be clean after upload"
    );

    // 2. Upload SVG and verify 400 SVG_NOT_ALLOWED
    let svg_data = format!(
        "--{boundary}\r\n\
        Content-Disposition: form-data; name=\"file\"; filename=\"malicious.svg\"\r\n\
        Content-Type: image/svg+xml\r\n\r\n\
        <svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>\r\n\
        --{boundary}--\r\n"
    );

    let req_svg = Request::builder()
        .method("POST")
        .uri("/upload")
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(Body::from(svg_data))
        .unwrap();

    let resp_svg = router.clone().oneshot(req_svg).await.unwrap();
    assert_eq!(resp_svg.status(), StatusCode::BAD_REQUEST);
    let bytes_svg = resp_svg.into_body().collect().await.unwrap().to_bytes();
    let err_svg: ErrorResponse = serde_json::from_slice(&bytes_svg).unwrap();
    assert_eq!(err_svg.error.code, "SVG_NOT_ALLOWED");

    // 3. Size limit rejection (test with small custom router and 50-byte max)
    async fn small_limit_upload_handler(
        State(dir): State<PathBuf>,
        mut multipart: Multipart,
    ) -> Result<Json<UploadedFileMeta>, AppError> {
        let field = multipart
            .next_field()
            .await
            .map_err(|e| AppError::validation(e.to_string()))?
            .ok_or_else(|| AppError::validation("No multipart field received"))?;

        // 50 bytes maximum
        let meta = save_upload_field(field, &dir, None, 50, 50).await?;
        Ok(Json(meta))
    }

    let small_router = Router::new()
        .route("/upload", post(small_limit_upload_handler))
        .with_state(data_dir.clone());

    let large_payload = vec![0x41; 200]; // 200 bytes > 50 bytes limit
    let mut large_body = Vec::new();
    large_body.extend_from_slice(
        format!(
            "--{boundary}\r\n\
            Content-Disposition: form-data; name=\"file\"; filename=\"toolarge.txt\"\r\n\
            Content-Type: text/plain\r\n\r\n"
        )
        .as_bytes(),
    );
    large_body.extend_from_slice(&large_payload);
    large_body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

    let req_large = Request::builder()
        .method("POST")
        .uri("/upload")
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(Body::from(large_body))
        .unwrap();

    let resp_large = small_router.oneshot(req_large).await.unwrap();
    assert_eq!(resp_large.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let bytes_large = resp_large.into_body().collect().await.unwrap().to_bytes();
    let err_large: ErrorResponse = serde_json::from_slice(&bytes_large).unwrap();
    assert_eq!(err_large.error.code, "FILE_TOO_LARGE");

    // Verify temp file was cleaned up by TempFileGuard
    let tmp_entries2 = std::fs::read_dir(data_dir.join("tmp")).unwrap();
    assert_eq!(
        tmp_entries2.count(),
        0,
        "Temporary file must be deleted on size limit error"
    );
}
