//! Milestone 2 Integration Test Suite: Auth, Admin Content & Media Gating
//!
//! Validates:
//! 1. Admin bootstrap & Argon2id authentication
//! 2. Rate limiting on failed login attempts (429 RATE_LIMIT_EXCEEDED with Retry-After)
//! 3. Session tokens, HttpOnly cookies, and /api/admin/me
//! 4. CSRF / Origin protection on mutating requests (403 FORBIDDEN)
//! 5. Subject CRUD & cascade block (409 SUBJECT_NOT_EMPTY)
//! 6. Page draft CRUD & revision conflict detection (409 REVISION_CONFLICT)
//! 7. Publishing & dual-state lifecycle (draft edits do not leak to public view)
//! 8. Media asset uploads, listing, and deletion
//! 9. Dynamic visibility gating: draft-only returns 404 (NOT 403), published returns 200 with immutable headers
//! 10. Immediate revocation of media access on unpublish

use axum::{
    body::Body,
    extract::ConnectInfo,
    http::{header, Request, StatusCode},
    Extension,
};
use backend::{
    config::Config,
    db::{init_test_db, DbPool},
    error::ErrorResponse,
    models::{
        AdminPageDetail, AdminPageListItem, AssetResponse, PublishPageResponse, SubjectResponse,
        UpdatePageResponse,
    },
    routes::create_router,
    AppState,
};
use http_body_util::BodyExt;
use serde_json::json;
use tempfile::TempDir;
use tower::ServiceExt;

const VALID_PNG: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
    0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
    0x42, 0x60, 0x82,
];

const VALID_PDF: &[u8] = b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n";

struct TestContext {
    pub app: axum::Router,
    pub db: DbPool,
    #[allow(dead_code)]
    pub config: Config,
    pub _temp_dir: TempDir,
}

impl TestContext {
    pub async fn new() -> Self {
        let temp_dir = tempfile::tempdir().unwrap();
        let db = init_test_db().await.unwrap();

        let config = Config {
            host: "127.0.0.1".to_string(),
            port: 8080,
            base_url: "http://127.0.0.1:8080".to_string(),
            database_url: "sqlite::memory:".to_string(),
            data_dir: temp_dir.path().to_path_buf(),
            cookie_secure: false,
            admin_username: "admin".to_string(),
            admin_password: Some("valid_admin_password_123".to_string()),
            session_secret: "test_session_secret_32_characters_long".to_string(),
            max_image_bytes: 10 * 1024 * 1024,
            max_attachment_bytes: 50 * 1024 * 1024,
            trusted_proxy_ips: vec!["127.0.0.1".parse().unwrap()],
        };
        config.ensure_directories().unwrap();

        // Seed admin user
        backend::auth::bootstrap_admin(&db, &config.admin_username, "valid_admin_password_123")
            .await
            .unwrap();

        let state = AppState::new(db.clone(), config.clone());
        let app = create_router(state);

        Self {
            app,
            db,
            config,
            _temp_dir: temp_dir,
        }
    }

    /// Helper to login as admin and return (cookie_val, csrf_token)
    pub async fn login_as_admin(&self) -> (String, String) {
        let payload = json!({
            "username": "admin",
            "password": "valid_admin_password_123"
        });

        let req = Request::builder()
            .method("POST")
            .uri("/api/admin/login")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::to_vec(&payload).unwrap()))
            .unwrap();

        let resp = self.app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        let cookie_header = resp
            .headers()
            .get(header::SET_COOKIE)
            .expect("Expected Set-Cookie header")
            .to_str()
            .unwrap()
            .to_string();

        let cookie_val = cookie_header.split(';').next().unwrap().to_string();

        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let csrf = body["csrf_token"].as_str().unwrap().to_string();

        (cookie_val, csrf)
    }
}

// ---------------------------------------------------------------------------
// 1. Auth & Session Tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_auth_login_success_and_session_flow() {
    let ctx = TestContext::new().await;
    let (cookie, csrf) = ctx.login_as_admin().await;

    // Verify /api/admin/me with session
    let req = Request::builder()
        .method("GET")
        .uri("/api/admin/me")
        .header(header::COOKIE, &cookie)
        .body(Body::empty())
        .unwrap();

    let resp = ctx.app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["username"], "admin");
    assert_eq!(body["csrf_token"], csrf);

    // Verify logout
    let logout_req = Request::builder()
        .method("POST")
        .uri("/api/admin/logout")
        .header(header::COOKIE, &cookie)
        .header("X-CSRF-Token", &csrf)
        .body(Body::empty())
        .unwrap();

    let logout_resp = ctx.app.clone().oneshot(logout_req).await.unwrap();
    assert_eq!(logout_resp.status(), StatusCode::OK);
    let set_cookie = logout_resp
        .headers()
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap();
    assert!(set_cookie.contains("Max-Age=0"));

    // Verify subsequent /me returns 401
    let me_req2 = Request::builder()
        .method("GET")
        .uri("/api/admin/me")
        .header(header::COOKIE, &cookie)
        .body(Body::empty())
        .unwrap();

    let me_resp2 = ctx.app.clone().oneshot(me_req2).await.unwrap();
    assert_eq!(me_resp2.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn test_auth_invalid_credentials() {
    let ctx = TestContext::new().await;

    let payload = json!({
        "username": "admin",
        "password": "wrong_password_here"
    });

    let req = Request::builder()
        .method("POST")
        .uri("/api/admin/login")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::to_vec(&payload).unwrap()))
        .unwrap();

    let resp = ctx.app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let err_json: ErrorResponse = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(err_json.error.code, "INVALID_CREDENTIALS");
}

#[tokio::test]
async fn test_auth_rate_limiting_after_five_failed_attempts() {
    let ctx = TestContext::new().await;

    let proxy_addr = "127.0.0.1:8080".parse().unwrap();
    let app = ctx.app.clone().layer(Extension(ConnectInfo(proxy_addr)));

    for _ in 0..5 {
        let req = Request::builder()
            .method("POST")
            .uri("/api/admin/login")
            .header(header::CONTENT_TYPE, "application/json")
            .header("X-Forwarded-For", "203.0.113.10")
            .body(Body::from(r#"{"username":"admin","password":"wrong"}"#))
            .unwrap();

        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    // 6th attempt from the same IP must be rejected with 429 RATE_LIMIT_EXCEEDED
    let req = Request::builder()
        .method("POST")
        .uri("/api/admin/login")
        .header(header::CONTENT_TYPE, "application/json")
        .header("X-Forwarded-For", "203.0.113.10")
        .body(Body::from(r#"{"username":"admin","password":"wrong"}"#))
        .unwrap();

    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(resp.headers().contains_key(header::RETRY_AFTER));
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let err_json: ErrorResponse = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(err_json.error.code, "RATE_LIMIT_EXCEEDED");

    // Attempt from a different IP is permitted (returns 401, not 429)
    let diff_req = Request::builder()
        .method("POST")
        .uri("/api/admin/login")
        .header(header::CONTENT_TYPE, "application/json")
        .header("X-Forwarded-For", "203.0.113.11")
        .body(Body::from(r#"{"username":"admin","password":"wrong"}"#))
        .unwrap();

    let diff_resp = app.clone().oneshot(diff_req).await.unwrap();
    assert_eq!(diff_resp.status(), StatusCode::UNAUTHORIZED);
}

// ---------------------------------------------------------------------------
// 2. CSRF & Origin Protection Tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_csrf_and_origin_protection() {
    let ctx = TestContext::new().await;
    let (cookie, csrf) = ctx.login_as_admin().await;

    // Mutating request without CSRF token -> 403 FORBIDDEN
    let no_csrf_req = Request::builder()
        .method("POST")
        .uri("/api/admin/subjects")
        .header(header::COOKIE, &cookie)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{"name":"Physics"}"#))
        .unwrap();

    let resp = ctx.app.clone().oneshot(no_csrf_req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let err: ErrorResponse = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(err.error.code, "FORBIDDEN");

    // Mutating request with invalid CSRF token -> 403 FORBIDDEN
    let bad_csrf_req = Request::builder()
        .method("POST")
        .uri("/api/admin/subjects")
        .header(header::COOKIE, &cookie)
        .header("X-CSRF-Token", "invalid_token_here")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{"name":"Physics"}"#))
        .unwrap();

    let resp = ctx.app.clone().oneshot(bad_csrf_req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);

    // Mutating request with mismatched cross-origin -> 403 FORBIDDEN
    let cross_origin_req = Request::builder()
        .method("POST")
        .uri("/api/admin/subjects")
        .header(header::COOKIE, &cookie)
        .header("X-CSRF-Token", &csrf)
        .header(header::ORIGIN, "http://malicious-site.com")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{"name":"Physics"}"#))
        .unwrap();

    let resp = ctx.app.clone().oneshot(cross_origin_req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);

    // Mutating request with valid cookie, CSRF, and origin -> 201 CREATED
    let valid_req = Request::builder()
        .method("POST")
        .uri("/api/admin/subjects")
        .header(header::COOKIE, &cookie)
        .header("X-CSRF-Token", &csrf)
        .header(header::ORIGIN, "http://127.0.0.1:8080")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{"name":"Physics"}"#))
        .unwrap();

    let resp = ctx.app.clone().oneshot(valid_req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);
}

// ---------------------------------------------------------------------------
// 3. Subject Management & Cascade Guard
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_subject_crud_and_delete_block_when_not_empty() {
    let ctx = TestContext::new().await;
    let (cookie, csrf) = ctx.login_as_admin().await;

    // 1. Create subject
    let create_sub_req = Request::builder()
        .method("POST")
        .uri("/api/admin/subjects")
        .header(header::COOKIE, &cookie)
        .header("X-CSRF-Token", &csrf)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{"name":"Operating Systems","position":1}"#))
        .unwrap();

    let resp = ctx.app.clone().oneshot(create_sub_req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let sub: SubjectResponse = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(sub.name, "Operating Systems");
    assert_eq!(sub.page_count, 0);
    let sub_id = sub.id;

    // 2. List subjects
    let list_req = Request::builder()
        .method("GET")
        .uri("/api/admin/subjects")
        .header(header::COOKIE, &cookie)
        .body(Body::empty())
        .unwrap();
    let list_resp = ctx.app.clone().oneshot(list_req).await.unwrap();
    assert_eq!(list_resp.status(), StatusCode::OK);
    let subjects: Vec<SubjectResponse> =
        serde_json::from_slice(&list_resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert!(subjects.iter().any(|s| s.id == sub_id));

    // 3. Patch subject
    let patch_req = Request::builder()
        .method("PATCH")
        .uri(format!("/api/admin/subjects/{sub_id}"))
        .header(header::COOKIE, &cookie)
        .header("X-CSRF-Token", &csrf)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{"name":"Advanced OS","position":2}"#))
        .unwrap();

    let patch_resp = ctx.app.clone().oneshot(patch_req).await.unwrap();
    assert_eq!(patch_resp.status(), StatusCode::OK);
    let patched_sub: SubjectResponse =
        serde_json::from_slice(&patch_resp.into_body().collect().await.unwrap().to_bytes())
            .unwrap();
    assert_eq!(patched_sub.name, "Advanced OS");
    assert_eq!(patched_sub.position, 2);

    // 4. Create page referencing this subject
    let create_page_req = Request::builder()
        .method("POST")
        .uri("/api/admin/pages")
        .header(header::COOKIE, &cookie)
        .header("X-CSRF-Token", &csrf)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(format!(
            r#"{{"subject_id":"{sub_id}","title":"Lab 1"}}"#
        )))
        .unwrap();

    let p_resp = ctx.app.clone().oneshot(create_page_req).await.unwrap();
    assert_eq!(p_resp.status(), StatusCode::CREATED);
    let page: AdminPageDetail =
        serde_json::from_slice(&p_resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
    let page_id = page.id;

    // 5. Attempt to delete subject -> must return 409 SUBJECT_NOT_EMPTY
    let del_req = Request::builder()
        .method("DELETE")
        .uri(format!("/api/admin/subjects/{sub_id}"))
        .header(header::COOKIE, &cookie)
        .header("X-CSRF-Token", &csrf)
        .body(Body::empty())
        .unwrap();

    let del_resp = ctx.app.clone().oneshot(del_req).await.unwrap();
    assert_eq!(del_resp.status(), StatusCode::CONFLICT);
    let err_bytes = del_resp.into_body().collect().await.unwrap().to_bytes();
    let err_json: ErrorResponse = serde_json::from_slice(&err_bytes).unwrap();
    assert_eq!(err_json.error.code, "SUBJECT_NOT_EMPTY");

    // 6. Delete page first, then delete subject succeeds
    let del_page_req = Request::builder()
        .method("DELETE")
        .uri(format!("/api/admin/pages/{page_id}"))
        .header(header::COOKIE, &cookie)
        .header("X-CSRF-Token", &csrf)
        .body(Body::empty())
        .unwrap();
    let del_p_resp = ctx.app.clone().oneshot(del_page_req).await.unwrap();
    assert_eq!(del_p_resp.status(), StatusCode::OK);

    let del_sub_req2 = Request::builder()
        .method("DELETE")
        .uri(format!("/api/admin/subjects/{sub_id}"))
        .header(header::COOKIE, &cookie)
        .header("X-CSRF-Token", &csrf)
        .body(Body::empty())
        .unwrap();
    let del_sub_resp2 = ctx.app.clone().oneshot(del_sub_req2).await.unwrap();
    assert_eq!(del_sub_resp2.status(), StatusCode::OK);
}

// ---------------------------------------------------------------------------
// 4. Page CRUD & Concurrency Control (Revision 409)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_page_revision_conflict_409() {
    let ctx = TestContext::new().await;
    let (cookie, csrf) = ctx.login_as_admin().await;

    // Create subject
    sqlx::query("INSERT INTO subjects (id, name) VALUES ('sub-c', 'Compilers')")
        .execute(&ctx.db)
        .await
        .unwrap();

    // Create page
    let create_req = Request::builder()
        .method("POST")
        .uri("/api/admin/pages")
        .header(header::COOKIE, &cookie)
        .header("X-CSRF-Token", &csrf)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{"subject_id":"sub-c","title":"Draft 1"}"#))
        .unwrap();

    let resp = ctx.app.clone().oneshot(create_req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);
    let page: AdminPageDetail =
        serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
    let page_id = page.id;
    assert_eq!(page.revision, 1);

    // List admin pages
    let list_req = Request::builder()
        .method("GET")
        .uri("/api/admin/pages")
        .header(header::COOKIE, &cookie)
        .body(Body::empty())
        .unwrap();
    let list_resp = ctx.app.clone().oneshot(list_req).await.unwrap();
    assert_eq!(list_resp.status(), StatusCode::OK);
    let pages: Vec<AdminPageListItem> =
        serde_json::from_slice(&list_resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert!(pages.iter().any(|p| p.id == page_id));

    // Successful update with expected_revision: 1 -> becomes revision 2
    let update_req1 = Request::builder()
        .method("PATCH")
        .uri(format!("/api/admin/pages/{page_id}"))
        .header(header::COOKIE, &cookie)
        .header("X-CSRF-Token", &csrf)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            r##"{"expected_revision":1,"title":"Draft 1 Updated","markdown":"# Heading"}"##,
        ))
        .unwrap();

    let u_resp1 = ctx.app.clone().oneshot(update_req1).await.unwrap();
    assert_eq!(u_resp1.status(), StatusCode::OK);
    let u_res1: UpdatePageResponse =
        serde_json::from_slice(&u_resp1.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(u_res1.revision, 2);

    // Conflicting update with stale expected_revision: 1 -> returns 409 REVISION_CONFLICT
    let update_req2 = Request::builder()
        .method("PATCH")
        .uri(format!("/api/admin/pages/{page_id}"))
        .header(header::COOKIE, &cookie)
        .header("X-CSRF-Token", &csrf)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"expected_revision":1,"title":"Draft 1 Stale"}"#,
        ))
        .unwrap();

    let u_resp2 = ctx.app.clone().oneshot(update_req2).await.unwrap();
    assert_eq!(u_resp2.status(), StatusCode::CONFLICT);
    let err_bytes = u_resp2.into_body().collect().await.unwrap().to_bytes();
    let err_json: ErrorResponse = serde_json::from_slice(&err_bytes).unwrap();
    assert_eq!(err_json.error.code, "REVISION_CONFLICT");

    // Successful update with expected_revision: 2 -> becomes revision 3
    let update_req3 = Request::builder()
        .method("PATCH")
        .uri(format!("/api/admin/pages/{page_id}"))
        .header(header::COOKIE, &cookie)
        .header("X-CSRF-Token", &csrf)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"expected_revision":2,"title":"Draft 1 Final"}"#,
        ))
        .unwrap();

    let u_resp3 = ctx.app.clone().oneshot(update_req3).await.unwrap();
    assert_eq!(u_resp3.status(), StatusCode::OK);
    let u_res3: UpdatePageResponse =
        serde_json::from_slice(&u_resp3.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(u_res3.revision, 3);
}

// ---------------------------------------------------------------------------
// 5. Media Upload, Visibility Gating & Publish Synchronization
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_media_upload_gating_publish_and_unpublish_flow() {
    let ctx = TestContext::new().await;
    let (cookie, csrf) = ctx.login_as_admin().await;

    // 1. Setup Subject and Page
    sqlx::query("INSERT INTO subjects (id, name) VALUES ('sub-net', 'Networks')")
        .execute(&ctx.db)
        .await
        .unwrap();

    sqlx::query("INSERT INTO pages (id, draft_subject_id, draft_title, revision) VALUES ('page-m', 'sub-net', 'Networks Lab', 1)")
        .execute(&ctx.db)
        .await
        .unwrap();

    // 2. Upload PNG Image
    let boundary = "------------------------testboundary123";
    let img_body = format!(
        "--{boundary}\r\n\
        Content-Disposition: form-data; name=\"file\"; filename=\"diagram.png\"\r\n\
        Content-Type: image/png\r\n\r\n"
    );
    let mut payload = Vec::new();
    payload.extend_from_slice(img_body.as_bytes());
    payload.extend_from_slice(VALID_PNG);
    payload.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

    let upload_img_req = Request::builder()
        .method("POST")
        .uri("/api/admin/pages/page-m/assets")
        .header(header::COOKIE, &cookie)
        .header("X-CSRF-Token", &csrf)
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(Body::from(payload.clone()))
        .unwrap();

    let up_resp = ctx.app.clone().oneshot(upload_img_req).await.unwrap();
    assert_eq!(up_resp.status(), StatusCode::CREATED);
    let img_asset: AssetResponse =
        serde_json::from_slice(&up_resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(img_asset.kind, "image");
    let img_id = img_asset.id;

    // 3. Upload PDF Attachment
    let pdf_body = format!(
        "--{boundary}\r\n\
        Content-Disposition: form-data; name=\"file\"; filename=\"spec.pdf\"\r\n\
        Content-Type: application/pdf\r\n\r\n"
    );
    let mut pdf_payload = Vec::new();
    pdf_payload.extend_from_slice(pdf_body.as_bytes());
    pdf_payload.extend_from_slice(VALID_PDF);
    pdf_payload.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

    let upload_pdf_req = Request::builder()
        .method("POST")
        .uri("/api/admin/pages/page-m/assets")
        .header(header::COOKIE, &cookie)
        .header("X-CSRF-Token", &csrf)
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(Body::from(pdf_payload))
        .unwrap();

    let pdf_resp = ctx.app.clone().oneshot(upload_pdf_req).await.unwrap();
    assert_eq!(pdf_resp.status(), StatusCode::CREATED);
    let pdf_asset: AssetResponse =
        serde_json::from_slice(&pdf_resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(pdf_asset.kind, "attachment");
    let pdf_id = pdf_asset.id;

    // List page assets
    let list_assets_req = Request::builder()
        .method("GET")
        .uri("/api/admin/pages/page-m/assets")
        .header(header::COOKIE, &cookie)
        .body(Body::empty())
        .unwrap();
    let list_ast_resp = ctx.app.clone().oneshot(list_assets_req).await.unwrap();
    assert_eq!(list_ast_resp.status(), StatusCode::OK);
    let page_assets: Vec<AssetResponse> = serde_json::from_slice(
        &list_ast_resp
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes(),
    )
    .unwrap();
    assert_eq!(page_assets.len(), 2);

    // 4. Test Draft-Only Access Gating:
    // Anonymous request MUST return HTTP 404 MEDIA_NOT_FOUND (NOT 403 Forbidden!)
    let anon_req = Request::builder()
        .method("GET")
        .uri(format!("/media/{img_id}"))
        .body(Body::empty())
        .unwrap();

    let anon_resp = ctx.app.clone().oneshot(anon_req).await.unwrap();
    assert_eq!(anon_resp.status(), StatusCode::NOT_FOUND);
    let err_bytes = anon_resp.into_body().collect().await.unwrap().to_bytes();
    let err_json: ErrorResponse = serde_json::from_slice(&err_bytes).unwrap();
    assert_eq!(err_json.error.code, "MEDIA_NOT_FOUND");

    // Admin request with session cookie MUST return HTTP 200 with private cache headers
    let admin_media_req = Request::builder()
        .method("GET")
        .uri(format!("/media/{img_id}"))
        .header(header::COOKIE, &cookie)
        .body(Body::empty())
        .unwrap();

    let admin_media_resp = ctx.app.clone().oneshot(admin_media_req).await.unwrap();
    assert_eq!(admin_media_resp.status(), StatusCode::OK);
    assert_eq!(
        admin_media_resp
            .headers()
            .get(header::CACHE_CONTROL)
            .unwrap(),
        "private, no-cache"
    );
    assert_eq!(
        admin_media_resp
            .headers()
            .get("x-content-type-options")
            .unwrap(),
        "nosniff"
    );

    // 5. Update draft markdown to embed image
    let draft_md =
        format!("# Network Lab\nHere is the network diagram:\n![Topology](/media/{img_id})\n");
    sqlx::query("UPDATE pages SET draft_markdown = ? WHERE id = 'page-m'")
        .bind(&draft_md)
        .execute(&ctx.db)
        .await
        .unwrap();

    // 6. Publish Page (publishing revision 1, referencing img_id in markdown, and explicit pdf_id attachment)
    let publish_req = Request::builder()
        .method("POST")
        .uri("/api/admin/pages/page-m/publish")
        .header(header::COOKIE, &cookie)
        .header("X-CSRF-Token", &csrf)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(format!(
            r#"{{"expected_revision":1,"attachment_ids":["{pdf_id}"]}}"#
        )))
        .unwrap();

    let pub_resp = ctx.app.clone().oneshot(publish_req).await.unwrap();
    assert_eq!(pub_resp.status(), StatusCode::OK);
    let pub_res: PublishPageResponse =
        serde_json::from_slice(&pub_resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(pub_res.published_revision, 1);

    // 7. Verify Published Media Access:
    // Anonymous request for embedded image now returns HTTP 200 with public immutable cache
    let pub_img_req = Request::builder()
        .method("GET")
        .uri(format!("/media/{img_id}"))
        .body(Body::empty())
        .unwrap();

    let pub_img_resp = ctx.app.clone().oneshot(pub_img_req).await.unwrap();
    assert_eq!(pub_img_resp.status(), StatusCode::OK);
    assert_eq!(
        pub_img_resp.headers().get(header::CACHE_CONTROL).unwrap(),
        "public, max-age=31536000, immutable"
    );
    assert!(pub_img_resp
        .headers()
        .get(header::CONTENT_DISPOSITION)
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("inline"));

    // Anonymous request for attachment now returns HTTP 200 with public immutable cache and attachment disposition
    let pub_pdf_req = Request::builder()
        .method("GET")
        .uri(format!("/media/{pdf_id}"))
        .body(Body::empty())
        .unwrap();

    let pub_pdf_resp = ctx.app.clone().oneshot(pub_pdf_req).await.unwrap();
    assert_eq!(pub_pdf_resp.status(), StatusCode::OK);
    assert_eq!(
        pub_pdf_resp.headers().get(header::CACHE_CONTROL).unwrap(),
        "public, max-age=31536000, immutable"
    );
    assert!(pub_pdf_resp
        .headers()
        .get(header::CONTENT_DISPOSITION)
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("attachment"));

    // 8. Test Dual-State Isolation:
    // Modify draft markdown and upload a new draft image (img2_id)
    let upload_img2_req = Request::builder()
        .method("POST")
        .uri("/api/admin/pages/page-m/assets")
        .header(header::COOKIE, &cookie)
        .header("X-CSRF-Token", &csrf)
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(Body::from(payload))
        .unwrap();

    let up2_resp = ctx.app.clone().oneshot(upload_img2_req).await.unwrap();
    let img2_asset: AssetResponse =
        serde_json::from_slice(&up2_resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
    let img2_id = img2_asset.id;

    // Anonymous access to new draft image returns 404 (draft isolation)
    let anon_img2_req = Request::builder()
        .method("GET")
        .uri(format!("/media/{img2_id}"))
        .body(Body::empty())
        .unwrap();
    let anon_img2_resp = ctx.app.clone().oneshot(anon_img2_req).await.unwrap();
    assert_eq!(anon_img2_resp.status(), StatusCode::NOT_FOUND);

    // Old published image remains accessible
    let check_old_req = Request::builder()
        .method("GET")
        .uri(format!("/media/{img_id}"))
        .body(Body::empty())
        .unwrap();
    let check_old_resp = ctx.app.clone().oneshot(check_old_req).await.unwrap();
    assert_eq!(check_old_resp.status(), StatusCode::OK);

    // 9. Unpublish Page:
    // DELETE /api/admin/pages/page-m/publication immediately revokes public access
    let unpublish_req = Request::builder()
        .method("DELETE")
        .uri("/api/admin/pages/page-m/publication")
        .header(header::COOKIE, &cookie)
        .header("X-CSRF-Token", &csrf)
        .body(Body::empty())
        .unwrap();

    let unpub_resp = ctx.app.clone().oneshot(unpublish_req).await.unwrap();
    assert_eq!(unpub_resp.status(), StatusCode::OK);

    // Anonymous requests for previously published image and attachment must now immediately return 404
    let revoked_img_req = Request::builder()
        .method("GET")
        .uri(format!("/media/{img_id}"))
        .body(Body::empty())
        .unwrap();
    let revoked_img_resp = ctx.app.clone().oneshot(revoked_img_req).await.unwrap();
    assert_eq!(revoked_img_resp.status(), StatusCode::NOT_FOUND);

    let revoked_pdf_req = Request::builder()
        .method("GET")
        .uri(format!("/media/{pdf_id}"))
        .body(Body::empty())
        .unwrap();
    let revoked_pdf_resp = ctx.app.clone().oneshot(revoked_pdf_req).await.unwrap();
    assert_eq!(revoked_pdf_resp.status(), StatusCode::NOT_FOUND);

    // Admin still has access to the assets
    let admin_access_req = Request::builder()
        .method("GET")
        .uri(format!("/media/{img_id}"))
        .header(header::COOKIE, &cookie)
        .body(Body::empty())
        .unwrap();
    let admin_access_resp = ctx.app.clone().oneshot(admin_access_req).await.unwrap();
    assert_eq!(admin_access_resp.status(), StatusCode::OK);

    // 10. Delete Asset:
    // DELETE /api/admin/pages/:id/assets/:asset_id removes DB row and disk file
    let delete_asset_req = Request::builder()
        .method("DELETE")
        .uri(format!("/api/admin/pages/page-m/assets/{img_id}"))
        .header(header::COOKIE, &cookie)
        .header("X-CSRF-Token", &csrf)
        .body(Body::empty())
        .unwrap();

    let del_ast_resp = ctx.app.clone().oneshot(delete_asset_req).await.unwrap();
    assert_eq!(del_ast_resp.status(), StatusCode::OK);

    // Subsequent access (even with admin session) returns 404
    let dead_req = Request::builder()
        .method("GET")
        .uri(format!("/media/{img_id}"))
        .header(header::COOKIE, &cookie)
        .body(Body::empty())
        .unwrap();
    let dead_resp = ctx.app.clone().oneshot(dead_req).await.unwrap();
    assert_eq!(dead_resp.status(), StatusCode::NOT_FOUND);

    // 11. Delete Page cascades remaining assets
    let del_page_req = Request::builder()
        .method("DELETE")
        .uri("/api/admin/pages/page-m")
        .header(header::COOKIE, &cookie)
        .header("X-CSRF-Token", &csrf)
        .body(Body::empty())
        .unwrap();
    let del_page_resp = ctx.app.clone().oneshot(del_page_req).await.unwrap();
    assert_eq!(del_page_resp.status(), StatusCode::OK);
}

// ---------------------------------------------------------------------------
// 6. Bootstrap Idempotency, CLI Password Reset & Session Revocation
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_admin_bootstrap_idempotency_and_reset_password() {
    let ctx = TestContext::new().await;

    // 1. Re-running bootstrap on existing admin returns Ok(false)
    let re_boot = backend::auth::bootstrap_admin(&ctx.db, "admin", "new_attempted_password")
        .await
        .unwrap();
    assert!(
        !re_boot,
        "Bootstrap on populated DB must return false without modifying password"
    );

    // Verify original password still logs in
    let (cookie, _csrf) = ctx.login_as_admin().await;

    // 2. Short password reset rejected with validation error
    let short_err = backend::auth::reset_admin_password(&ctx.db, "admin", "short").await;
    assert!(short_err.is_err());

    // 3. Valid password reset succeeds and invalidates all existing sessions
    backend::auth::reset_admin_password(&ctx.db, "admin", "brand_new_admin_password_999")
        .await
        .unwrap();

    // Verify existing session cookie is now invalidated
    let me_req = Request::builder()
        .method("GET")
        .uri("/api/admin/me")
        .header(header::COOKIE, &cookie)
        .body(Body::empty())
        .unwrap();
    let me_resp = ctx.app.clone().oneshot(me_req).await.unwrap();
    assert_eq!(me_resp.status(), StatusCode::UNAUTHORIZED);

    // Old password no longer works
    let old_login = Request::builder()
        .method("POST")
        .uri("/api/admin/login")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"username":"admin","password":"valid_admin_password_123"}"#,
        ))
        .unwrap();
    let old_resp = ctx.app.clone().oneshot(old_login).await.unwrap();
    assert_eq!(old_resp.status(), StatusCode::UNAUTHORIZED);

    // New password works
    let new_login = Request::builder()
        .method("POST")
        .uri("/api/admin/login")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"username":"admin","password":"brand_new_admin_password_999"}"#,
        ))
        .unwrap();
    let new_resp = ctx.app.clone().oneshot(new_login).await.unwrap();
    assert_eq!(new_resp.status(), StatusCode::OK);
}

// ---------------------------------------------------------------------------
// 7. Validation & Edge Cases Tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_page_validation_and_not_found_errors() {
    let ctx = TestContext::new().await;
    let (cookie, csrf) = ctx.login_as_admin().await;

    // Empty page title -> 400 VALIDATION_ERROR
    let empty_title_req = Request::builder()
        .method("POST")
        .uri("/api/admin/pages")
        .header(header::COOKIE, &cookie)
        .header("X-CSRF-Token", &csrf)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{"subject_id":"nonexistent","title":"   "}"#))
        .unwrap();
    let resp1 = ctx.app.clone().oneshot(empty_title_req).await.unwrap();
    assert_eq!(resp1.status(), StatusCode::BAD_REQUEST);

    // Nonexistent subject -> 404 NOT_FOUND
    let bad_sub_req = Request::builder()
        .method("POST")
        .uri("/api/admin/pages")
        .header(header::COOKIE, &cookie)
        .header("X-CSRF-Token", &csrf)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"subject_id":"nonexistent","title":"Valid Title"}"#,
        ))
        .unwrap();
    let resp2 = ctx.app.clone().oneshot(bad_sub_req).await.unwrap();
    assert_eq!(resp2.status(), StatusCode::NOT_FOUND);

    // Get nonexistent page -> 404 PAGE_NOT_FOUND
    let get_none_req = Request::builder()
        .method("GET")
        .uri("/api/admin/pages/00000000-0000-0000-0000-000000000000")
        .header(header::COOKIE, &cookie)
        .body(Body::empty())
        .unwrap();
    let resp3 = ctx.app.clone().oneshot(get_none_req).await.unwrap();
    assert_eq!(resp3.status(), StatusCode::NOT_FOUND);

    // Patch nonexistent page -> 404 PAGE_NOT_FOUND
    let patch_none_req = Request::builder()
        .method("PATCH")
        .uri("/api/admin/pages/00000000-0000-0000-0000-000000000000")
        .header(header::COOKIE, &cookie)
        .header("X-CSRF-Token", &csrf)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{"expected_revision":1,"title":"Anything"}"#))
        .unwrap();
    let resp4 = ctx.app.clone().oneshot(patch_none_req).await.unwrap();
    assert_eq!(resp4.status(), StatusCode::NOT_FOUND);

    // Unpublish nonexistent page -> 404 PAGE_NOT_FOUND
    let unpub_none_req = Request::builder()
        .method("DELETE")
        .uri("/api/admin/pages/00000000-0000-0000-0000-000000000000/publication")
        .header(header::COOKIE, &cookie)
        .header("X-CSRF-Token", &csrf)
        .body(Body::empty())
        .unwrap();
    let resp5 = ctx.app.clone().oneshot(unpub_none_req).await.unwrap();
    assert_eq!(resp5.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn test_publish_foreign_attachment_rejected() {
    let ctx = TestContext::new().await;
    let (cookie, csrf) = ctx.login_as_admin().await;

    // Create subject and 2 pages
    sqlx::query("INSERT INTO subjects (id, name) VALUES ('sub-att', 'Attachments')")
        .execute(&ctx.db)
        .await
        .unwrap();

    sqlx::query("INSERT INTO pages (id, draft_subject_id, draft_title, revision) VALUES ('page-1', 'sub-att', 'Page 1', 1)")
        .execute(&ctx.db)
        .await
        .unwrap();

    sqlx::query("INSERT INTO pages (id, draft_subject_id, draft_title, revision) VALUES ('page-2', 'sub-att', 'Page 2', 1)")
        .execute(&ctx.db)
        .await
        .unwrap();

    // Insert an asset belonging to page-2
    sqlx::query("INSERT INTO assets (id, page_id, stored_name, original_name, mime, byte_size, kind) VALUES ('att-2', 'page-2', 'stored-2', 'file.pdf', 'application/pdf', 100, 'attachment')")
        .execute(&ctx.db)
        .await
        .unwrap();

    // Try to publish page-1 with attachment from page-2 -> must return 400 VALIDATION_ERROR
    let pub_req = Request::builder()
        .method("POST")
        .uri("/api/admin/pages/page-1/publish")
        .header(header::COOKIE, &cookie)
        .header("X-CSRF-Token", &csrf)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"expected_revision":1,"attachment_ids":["att-2"]}"#,
        ))
        .unwrap();

    let resp = ctx.app.clone().oneshot(pub_req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let err: ErrorResponse = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(err.error.code, "VALIDATION_ERROR");
}

#[tokio::test]
async fn test_media_invalid_uuid_and_missing_file_404() {
    let ctx = TestContext::new().await;

    // Non-UUID -> 404 MEDIA_NOT_FOUND
    let req1 = Request::builder()
        .method("GET")
        .uri("/media/not-a-valid-uuid")
        .body(Body::empty())
        .unwrap();
    let resp1 = ctx.app.clone().oneshot(req1).await.unwrap();
    assert_eq!(resp1.status(), StatusCode::NOT_FOUND);

    // Valid UUID but not in DB -> 404 MEDIA_NOT_FOUND
    let req2 = Request::builder()
        .method("GET")
        .uri("/media/00000000-0000-0000-0000-000000000001")
        .body(Body::empty())
        .unwrap();
    let resp2 = ctx.app.clone().oneshot(req2).await.unwrap();
    assert_eq!(resp2.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn test_media_disposition_formatting_and_scanner_unit() {
    // Test RFC 5987 / 6266 disposition formatting
    let inline_disp = backend::routes::media::format_content_disposition("image", "тест_фото.png");
    assert!(inline_disp.starts_with("inline; filename="));
    assert!(inline_disp.contains("filename*=UTF-8''"));

    let att_disp = backend::routes::media::format_content_disposition("attachment", "document.pdf");
    assert!(att_disp.starts_with("attachment; filename=\"document.pdf\""));

    // Test markdown UUID scanner
    let sample_md = "# Title\n\n![Image](/media/123e4567-e89b-12d3-a456-426614174000)\n\n[Doc](/media/987fcdeb-51a2-43f7-9abc-def012345678)\nInvalid /media/not-a-uuid-here\n";
    let extracted = backend::routes::admin_pages::extract_media_uuids(sample_md);
    assert_eq!(extracted.len(), 2);
    assert!(extracted.contains("123e4567-e89b-12d3-a456-426614174000"));
    assert!(extracted.contains("987fcdeb-51a2-43f7-9abc-def012345678"));
}
