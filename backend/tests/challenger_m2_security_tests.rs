//! Empirical Security Challenge Suite for Milestone 2:
//! Media Gating, CSRF/Origin Boundaries, and Session Token Security
//!
//! Adversarial verification of:
//! 1. Anonymous draft media access strictly returns 404 MEDIA_NOT_FOUND (NOT 403 Forbidden).
//! 2. Authenticated admin access to draft media returns 200 OK with `Cache-Control: private, no-cache`.
//! 3. Published media returns 200 OK with `Cache-Control: public, max-age=31536000, immutable`.
//! 4. Immediate revocation on unpublish: public assets immediately revert to 404 MEDIA_NOT_FOUND.
//! 5. Cross-page asset hijacking and draft leakage prevention.
//! 6. Unreferenced draft assets remain private on publish.
//! 7. CSRF validation matrix: missing token, empty token, forged token rejected on all mutating endpoints.
//! 8. Origin & Referer spoofing attacks rejected (evil.com, subdomain spoofing, null origin).
//! 9. Cross-session CSRF token swapping rejected.
//! 10. Raw session tokens are NEVER stored in SQLite sessions table (SHA-256 only).
//! 11. Expired session rejection and SQLite session pruning.
//! 12. Logout and password reset immediate session revocation.
//! 13. Path traversal and malformed media ID safety.

use axum::{
    body::Body,
    http::{header, Request, StatusCode},
};
use backend::{
    auth::{hash_sha256, prune_expired_sessions, reset_admin_password},
    config::Config,
    db::{init_test_db, DbPool},
    error::ErrorResponse,
    models::AssetResponse,
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

struct TestHarness {
    pub app: axum::Router,
    pub db: DbPool,
    #[allow(dead_code)]
    pub config: Config,
    pub _temp_dir: TempDir,
}

impl TestHarness {
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
            admin_password: Some("challenger_admin_password_123".to_string()),
            session_secret: "challenger_session_secret_32_chars_long".to_string(),
            max_image_bytes: 10 * 1024 * 1024,
            max_attachment_bytes: 50 * 1024 * 1024,
            trusted_proxy_ips: Vec::new(),
        };
        config.ensure_directories().unwrap();

        backend::auth::bootstrap_admin(
            &db,
            &config.admin_username,
            "challenger_admin_password_123",
        )
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

    /// Logs in as admin and returns (cookie_str, csrf_token, raw_token)
    pub async fn login_as_admin(&self) -> (String, String, String) {
        let payload = json!({
            "username": "admin",
            "password": "challenger_admin_password_123"
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
        let raw_token = cookie_val
            .strip_prefix("labnotes_session=")
            .unwrap()
            .to_string();

        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let csrf = body["csrf_token"].as_str().unwrap().to_string();

        (cookie_val, csrf, raw_token)
    }

    /// Helper to upload an asset to a given page
    pub async fn upload_asset(
        &self,
        cookie: &str,
        csrf: &str,
        page_id: &str,
        filename: &str,
        mime: &str,
        bytes: &[u8],
    ) -> AssetResponse {
        let boundary = "------------------------challengerboundary456";
        let part_header = format!(
            "--{boundary}\r\n\
            Content-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\n\
            Content-Type: {mime}\r\n\r\n"
        );
        let mut payload = Vec::new();
        payload.extend_from_slice(part_header.as_bytes());
        payload.extend_from_slice(bytes);
        payload.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

        let req = Request::builder()
            .method("POST")
            .uri(format!("/api/admin/pages/{page_id}/assets"))
            .header(header::COOKIE, cookie)
            .header("X-CSRF-Token", csrf)
            .header(
                header::CONTENT_TYPE,
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(Body::from(payload))
            .unwrap();

        let resp = self.app.clone().oneshot(req).await.unwrap();
        assert_eq!(
            resp.status(),
            StatusCode::CREATED,
            "Asset upload should return 201 Created"
        );

        let body_bytes = resp.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&body_bytes).unwrap()
    }
}

// ============================================================================
// 1. Dynamic Media Gating & Enumeration Resistance Tests
// ============================================================================

#[tokio::test]
async fn test_challenge_anonymous_draft_media_strictly_returns_404_not_403() {
    let harness = TestHarness::new().await;
    let (cookie, csrf, _) = harness.login_as_admin().await;

    // Create subject and page
    sqlx::query("INSERT INTO subjects (id, name) VALUES ('sub-sec', 'Security')")
        .execute(&harness.db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO pages (id, draft_subject_id, draft_title, revision) VALUES ('page-draft', 'sub-sec', 'Secret Draft', 1)")
        .execute(&harness.db)
        .await
        .unwrap();

    // Upload draft image
    let asset = harness
        .upload_asset(
            &cookie,
            &csrf,
            "page-draft",
            "confidential.png",
            "image/png",
            VALID_PNG,
        )
        .await;

    // Vector 1: Anonymous request for existing draft asset
    let anon_req = Request::builder()
        .method("GET")
        .uri(format!("/media/{}", asset.id))
        .body(Body::empty())
        .unwrap();

    let anon_resp = harness.app.clone().oneshot(anon_req).await.unwrap();
    // MUST strictly be 404 Not Found (NOT 401 Unauthorized or 403 Forbidden)
    assert_eq!(anon_resp.status(), StatusCode::NOT_FOUND);
    assert_ne!(anon_resp.status(), StatusCode::FORBIDDEN);
    assert_ne!(anon_resp.status(), StatusCode::UNAUTHORIZED);

    let anon_body = anon_resp.into_body().collect().await.unwrap().to_bytes();
    let anon_err: ErrorResponse = serde_json::from_slice(&anon_body).unwrap();
    assert_eq!(anon_err.error.code, "MEDIA_NOT_FOUND");

    // Vector 2: Anonymous request for non-existent random UUID
    let non_existent_uuid = "a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d";
    let non_exist_req = Request::builder()
        .method("GET")
        .uri(format!("/media/{non_existent_uuid}"))
        .body(Body::empty())
        .unwrap();

    let non_exist_resp = harness.app.clone().oneshot(non_exist_req).await.unwrap();
    assert_eq!(non_exist_resp.status(), StatusCode::NOT_FOUND);

    let non_exist_body = non_exist_resp
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
    let non_exist_err: ErrorResponse = serde_json::from_slice(&non_exist_body).unwrap();
    assert_eq!(non_exist_err.error.code, "MEDIA_NOT_FOUND");

    // Enumeration Resistance: Both existing draft media and non-existent media return
    // identical status code (404) and identical error code (MEDIA_NOT_FOUND)
    assert_eq!(anon_err.error.code, non_exist_err.error.code);
}

#[tokio::test]
async fn test_challenge_admin_access_to_draft_media_returns_200_private_cache() {
    let harness = TestHarness::new().await;
    let (cookie, csrf, _) = harness.login_as_admin().await;

    sqlx::query("INSERT INTO subjects (id, name) VALUES ('sub-sec2', 'Security 2')")
        .execute(&harness.db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO pages (id, draft_subject_id, draft_title, revision) VALUES ('page-draft2', 'sub-sec2', 'Draft 2', 1)")
        .execute(&harness.db)
        .await
        .unwrap();

    let asset = harness
        .upload_asset(
            &cookie,
            &csrf,
            "page-draft2",
            "draft_schematic.png",
            "image/png",
            VALID_PNG,
        )
        .await;

    // Authenticated admin request to draft media
    let admin_req = Request::builder()
        .method("GET")
        .uri(format!("/media/{}", asset.id))
        .header(header::COOKIE, &cookie)
        .body(Body::empty())
        .unwrap();

    let admin_resp = harness.app.clone().oneshot(admin_req).await.unwrap();
    assert_eq!(admin_resp.status(), StatusCode::OK);

    // Verify cache control is private and non-cacheable
    let cache_control = admin_resp
        .headers()
        .get(header::CACHE_CONTROL)
        .expect("Missing Cache-Control header")
        .to_str()
        .unwrap();
    assert_eq!(cache_control, "private, no-cache");

    // Verify security headers
    let nosniff = admin_resp
        .headers()
        .get("x-content-type-options")
        .expect("Missing x-content-type-options header")
        .to_str()
        .unwrap();
    assert_eq!(nosniff, "nosniff");

    let content_type = admin_resp
        .headers()
        .get(header::CONTENT_TYPE)
        .expect("Missing Content-Type header")
        .to_str()
        .unwrap();
    assert_eq!(content_type, "image/png");

    let content_disp = admin_resp
        .headers()
        .get(header::CONTENT_DISPOSITION)
        .expect("Missing Content-Disposition header")
        .to_str()
        .unwrap();
    assert!(content_disp.starts_with("inline;"));

    // Verify response body matches exact uploaded bytes
    let served_bytes = admin_resp.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(served_bytes.as_ref(), VALID_PNG);
}

#[tokio::test]
async fn test_challenge_published_media_returns_200_public_immutable_cache() {
    let harness = TestHarness::new().await;
    let (cookie, csrf, _) = harness.login_as_admin().await;

    sqlx::query("INSERT INTO subjects (id, name) VALUES ('sub-pub', 'Publishing')")
        .execute(&harness.db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO pages (id, draft_subject_id, draft_title, revision) VALUES ('page-pub', 'sub-pub', 'Public Article', 1)")
        .execute(&harness.db)
        .await
        .unwrap();

    // Upload an image and a PDF attachment
    let img_asset = harness
        .upload_asset(
            &cookie,
            &csrf,
            "page-pub",
            "diagram.png",
            "image/png",
            VALID_PNG,
        )
        .await;

    let pdf_asset = harness
        .upload_asset(
            &cookie,
            &csrf,
            "page-pub",
            "document.pdf",
            "application/pdf",
            VALID_PDF,
        )
        .await;

    // Embed image in markdown
    let md = format!(
        "# Public Article\n![Diagram](/media/{})\nRead the spec below.\n",
        img_asset.id
    );
    sqlx::query("UPDATE pages SET draft_markdown = ? WHERE id = 'page-pub'")
        .bind(&md)
        .execute(&harness.db)
        .await
        .unwrap();

    // Publish page with expected_revision = 1 and attachment_ids = [pdf_asset.id]
    let pub_req = Request::builder()
        .method("POST")
        .uri("/api/admin/pages/page-pub/publish")
        .header(header::COOKIE, &cookie)
        .header("X-CSRF-Token", &csrf)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            json!({
                "expected_revision": 1,
                "attachment_ids": [pdf_asset.id]
            })
            .to_string(),
        ))
        .unwrap();

    let pub_resp = harness.app.clone().oneshot(pub_req).await.unwrap();
    assert_eq!(pub_resp.status(), StatusCode::OK);

    // 1. Anonymous access to published image: 200 OK + public immutable
    let anon_img_req = Request::builder()
        .method("GET")
        .uri(format!("/media/{}", img_asset.id))
        .body(Body::empty())
        .unwrap();

    let anon_img_resp = harness.app.clone().oneshot(anon_img_req).await.unwrap();
    assert_eq!(anon_img_resp.status(), StatusCode::OK);
    assert_eq!(
        anon_img_resp
            .headers()
            .get(header::CACHE_CONTROL)
            .unwrap()
            .to_str()
            .unwrap(),
        "public, max-age=31536000, immutable"
    );
    assert!(anon_img_resp
        .headers()
        .get(header::CONTENT_DISPOSITION)
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("inline"));

    // 2. Anonymous access to published attachment: 200 OK + public immutable + attachment disposition
    let anon_pdf_req = Request::builder()
        .method("GET")
        .uri(format!("/media/{}", pdf_asset.id))
        .body(Body::empty())
        .unwrap();

    let anon_pdf_resp = harness.app.clone().oneshot(anon_pdf_req).await.unwrap();
    assert_eq!(anon_pdf_resp.status(), StatusCode::OK);
    assert_eq!(
        anon_pdf_resp
            .headers()
            .get(header::CACHE_CONTROL)
            .unwrap()
            .to_str()
            .unwrap(),
        "public, max-age=31536000, immutable"
    );
    assert!(anon_pdf_resp
        .headers()
        .get(header::CONTENT_DISPOSITION)
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("attachment"));
}

#[tokio::test]
async fn test_challenge_immediate_revocation_on_unpublish() {
    let harness = TestHarness::new().await;
    let (cookie, csrf, _) = harness.login_as_admin().await;

    sqlx::query("INSERT INTO subjects (id, name) VALUES ('sub-unpub', 'Unpublish Subject')")
        .execute(&harness.db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO pages (id, draft_subject_id, draft_title, revision) VALUES ('page-unpub', 'sub-unpub', 'Revocation Test', 1)")
        .execute(&harness.db)
        .await
        .unwrap();

    let asset = harness
        .upload_asset(
            &cookie,
            &csrf,
            "page-unpub",
            "sensitive_diagram.png",
            "image/png",
            VALID_PNG,
        )
        .await;

    // Publish page with asset
    let md = format!("# Secret\n![Chart](/media/{})\n", asset.id);
    sqlx::query("UPDATE pages SET draft_markdown = ? WHERE id = 'page-unpub'")
        .bind(&md)
        .execute(&harness.db)
        .await
        .unwrap();

    let pub_req = Request::builder()
        .method("POST")
        .uri("/api/admin/pages/page-unpub/publish")
        .header(header::COOKIE, &cookie)
        .header("X-CSRF-Token", &csrf)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            json!({
                "expected_revision": 1,
                "attachment_ids": []
            })
            .to_string(),
        ))
        .unwrap();
    let pub_resp = harness.app.clone().oneshot(pub_req).await.unwrap();
    assert_eq!(pub_resp.status(), StatusCode::OK);

    // Verify it is currently accessible anonymously
    let req_pub = Request::builder()
        .method("GET")
        .uri(format!("/media/{}", asset.id))
        .body(Body::empty())
        .unwrap();
    let resp_pub = harness.app.clone().oneshot(req_pub).await.unwrap();
    assert_eq!(resp_pub.status(), StatusCode::OK);

    // UNPUBLISH the page
    let unpub_req = Request::builder()
        .method("DELETE")
        .uri("/api/admin/pages/page-unpub/publication")
        .header(header::COOKIE, &cookie)
        .header("X-CSRF-Token", &csrf)
        .body(Body::empty())
        .unwrap();
    let unpub_resp = harness.app.clone().oneshot(unpub_req).await.unwrap();
    assert_eq!(unpub_resp.status(), StatusCode::OK);

    // Database verification: page_public_assets table must have 0 rows for this page
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM page_public_assets WHERE page_id = 'page-unpub'")
            .fetch_one(&harness.db)
            .await
            .unwrap();
    assert_eq!(count, 0, "page_public_assets must be completely cleared");

    // Immediate Revocation Check: anonymous request MUST immediately return 404 MEDIA_NOT_FOUND
    let req_after = Request::builder()
        .method("GET")
        .uri(format!("/media/{}", asset.id))
        .body(Body::empty())
        .unwrap();
    let resp_after = harness.app.clone().oneshot(req_after).await.unwrap();
    assert_eq!(
        resp_after.status(),
        StatusCode::NOT_FOUND,
        "Unpublished media must be immediately 404 to anonymous users"
    );

    let err_after: ErrorResponse =
        serde_json::from_slice(&resp_after.into_body().collect().await.unwrap().to_bytes())
            .unwrap();
    assert_eq!(err_after.error.code, "MEDIA_NOT_FOUND");

    // Admin request must still be able to access the draft media with private cache headers
    let admin_req_after = Request::builder()
        .method("GET")
        .uri(format!("/media/{}", asset.id))
        .header(header::COOKIE, &cookie)
        .body(Body::empty())
        .unwrap();
    let admin_resp_after = harness.app.clone().oneshot(admin_req_after).await.unwrap();
    assert_eq!(admin_resp_after.status(), StatusCode::OK);
    assert_eq!(
        admin_resp_after
            .headers()
            .get(header::CACHE_CONTROL)
            .unwrap()
            .to_str()
            .unwrap(),
        "private, no-cache"
    );
}

#[tokio::test]
async fn test_challenge_cross_page_asset_hijack_prevention() {
    let harness = TestHarness::new().await;
    let (cookie, csrf, _) = harness.login_as_admin().await;

    sqlx::query("INSERT INTO subjects (id, name) VALUES ('sub-cross', 'Cross Page Subject')")
        .execute(&harness.db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO pages (id, draft_subject_id, draft_title, revision) VALUES ('page-victim', 'sub-cross', 'Victim Draft', 1)")
        .execute(&harness.db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO pages (id, draft_subject_id, draft_title, revision) VALUES ('page-attacker', 'sub-cross', 'Attacker Draft', 1)")
        .execute(&harness.db)
        .await
        .unwrap();

    // Victim uploads private draft asset
    let victim_asset = harness
        .upload_asset(
            &cookie,
            &csrf,
            "page-victim",
            "victim_secret.png",
            "image/png",
            VALID_PNG,
        )
        .await;

    // Attack Vector 1: Attacker attempts to publish page-attacker including victim_asset in attachment_ids
    let evil_publish_att = Request::builder()
        .method("POST")
        .uri("/api/admin/pages/page-attacker/publish")
        .header(header::COOKIE, &cookie)
        .header("X-CSRF-Token", &csrf)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            json!({
                "expected_revision": 1,
                "attachment_ids": [victim_asset.id]
            })
            .to_string(),
        ))
        .unwrap();

    let evil_att_resp = harness.app.clone().oneshot(evil_publish_att).await.unwrap();
    assert_eq!(
        evil_att_resp.status(),
        StatusCode::BAD_REQUEST,
        "Cross-page attachment ownership injection must be rejected"
    );

    // Attack Vector 2: Attacker embeds victim's asset UUID into page-attacker's markdown
    let evil_md = format!("# Attacker Page\n![Hijacked](/media/{})\n", victim_asset.id);
    sqlx::query("UPDATE pages SET draft_markdown = ? WHERE id = 'page-attacker'")
        .bind(&evil_md)
        .execute(&harness.db)
        .await
        .unwrap();

    let evil_pub_req = Request::builder()
        .method("POST")
        .uri("/api/admin/pages/page-attacker/publish")
        .header(header::COOKIE, &cookie)
        .header("X-CSRF-Token", &csrf)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            json!({
                "expected_revision": 1,
                "attachment_ids": []
            })
            .to_string(),
        ))
        .unwrap();

    let evil_pub_resp = harness.app.clone().oneshot(evil_pub_req).await.unwrap();
    assert_eq!(
        evil_pub_resp.status(),
        StatusCode::OK,
        "Publish succeeds for attacker page"
    );

    // Verification: page_public_assets MUST NOT contain victim_asset linked to page-attacker
    let public_link_exists: Option<(String,)> = sqlx::query_as(
        "SELECT asset_id FROM page_public_assets WHERE page_id = 'page-attacker' AND asset_id = ?",
    )
    .bind(&victim_asset.id)
    .fetch_optional(&harness.db)
    .await
    .unwrap();

    assert!(
        public_link_exists.is_none(),
        "Victim asset must not be leaked into page_public_assets by a foreign page"
    );

    // Anonymous request to victim's asset must STILL be 404 MEDIA_NOT_FOUND
    let anon_req = Request::builder()
        .method("GET")
        .uri(format!("/media/{}", victim_asset.id))
        .body(Body::empty())
        .unwrap();
    let anon_resp = harness.app.clone().oneshot(anon_req).await.unwrap();
    assert_eq!(anon_resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn test_challenge_unreferenced_draft_assets_remain_private_on_publish() {
    let harness = TestHarness::new().await;
    let (cookie, csrf, _) = harness.login_as_admin().await;

    sqlx::query("INSERT INTO subjects (id, name) VALUES ('sub-unref', 'Unreferenced Subject')")
        .execute(&harness.db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO pages (id, draft_subject_id, draft_title, revision) VALUES ('page-unref', 'sub-unref', 'Unreferenced Assets Page', 1)")
        .execute(&harness.db)
        .await
        .unwrap();

    // Asset 1: Embedded in markdown
    let asset_embedded = harness
        .upload_asset(
            &cookie,
            &csrf,
            "page-unref",
            "embedded.png",
            "image/png",
            VALID_PNG,
        )
        .await;

    // Asset 2: Explicit attachment
    let asset_attachment = harness
        .upload_asset(
            &cookie,
            &csrf,
            "page-unref",
            "manual.pdf",
            "application/pdf",
            VALID_PDF,
        )
        .await;

    // Asset 3: Uploaded to page, but NEVER embedded in markdown and NOT in attachment_ids
    let asset_orphaned = harness
        .upload_asset(
            &cookie,
            &csrf,
            "page-unref",
            "unreferenced_private.png",
            "image/png",
            VALID_PNG,
        )
        .await;

    // Update draft markdown with ONLY asset_embedded
    let md = format!(
        "# Page\nHere is the embedded picture: ![Pic](/media/{})\n",
        asset_embedded.id
    );
    sqlx::query("UPDATE pages SET draft_markdown = ? WHERE id = 'page-unref'")
        .bind(&md)
        .execute(&harness.db)
        .await
        .unwrap();

    // Publish with ONLY asset_attachment in attachment_ids
    let pub_req = Request::builder()
        .method("POST")
        .uri("/api/admin/pages/page-unref/publish")
        .header(header::COOKIE, &cookie)
        .header("X-CSRF-Token", &csrf)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            json!({
                "expected_revision": 1,
                "attachment_ids": [asset_attachment.id]
            })
            .to_string(),
        ))
        .unwrap();
    let pub_resp = harness.app.clone().oneshot(pub_req).await.unwrap();
    assert_eq!(pub_resp.status(), StatusCode::OK);

    // Verify Asset 1 (embedded) is public
    let r1 = harness
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/media/{}", asset_embedded.id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r1.status(), StatusCode::OK);

    // Verify Asset 2 (attachment) is public
    let r2 = harness
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/media/{}", asset_attachment.id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r2.status(), StatusCode::OK);

    // Verify Asset 3 (unreferenced draft asset) is STRICTLY 404 to anonymous users!
    let r3 = harness
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/media/{}", asset_orphaned.id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        r3.status(),
        StatusCode::NOT_FOUND,
        "Unreferenced asset must not accidentally be made public"
    );

    // Admin can still access Asset 3 privately
    let r3_admin = harness
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/media/{}", asset_orphaned.id))
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r3_admin.status(), StatusCode::OK);
    assert_eq!(
        r3_admin
            .headers()
            .get(header::CACHE_CONTROL)
            .unwrap()
            .to_str()
            .unwrap(),
        "private, no-cache"
    );
}

// ============================================================================
// 2. CSRF & Origin Attack Matrix Tests
// ============================================================================

#[tokio::test]
async fn test_challenge_csrf_rejection_matrix_on_all_mutating_endpoints() {
    let harness = TestHarness::new().await;
    let (cookie, valid_csrf, _) = harness.login_as_admin().await;

    // Seed baseline subject and page for testing mutation targets
    sqlx::query("INSERT INTO subjects (id, name) VALUES ('sub-target', 'Target Subject')")
        .execute(&harness.db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO pages (id, draft_subject_id, draft_title, revision) VALUES ('page-target', 'sub-target', 'Target Page', 1)")
        .execute(&harness.db)
        .await
        .unwrap();

    let asset = harness
        .upload_asset(
            &cookie,
            &valid_csrf,
            "page-target",
            "dummy.png",
            "image/png",
            VALID_PNG,
        )
        .await;

    let delete_asset_uri = format!("/api/admin/pages/page-target/assets/{}", asset.id);

    // List of mutating endpoints to test
    let mutating_endpoints = vec![
        (
            "POST",
            "/api/admin/subjects",
            json!({"name": "New Sub"}).to_string(),
            "application/json",
        ),
        (
            "PATCH",
            "/api/admin/subjects/sub-target",
            json!({"name": "Renamed"}).to_string(),
            "application/json",
        ),
        (
            "DELETE",
            "/api/admin/subjects/sub-target",
            "".to_string(),
            "application/json",
        ),
        (
            "POST",
            "/api/admin/pages",
            json!({"subject_id": "sub-target", "title": "New Page"}).to_string(),
            "application/json",
        ),
        (
            "PATCH",
            "/api/admin/pages/page-target",
            json!({"expected_revision": 1, "title": "Updated"}).to_string(),
            "application/json",
        ),
        (
            "POST",
            "/api/admin/pages/page-target/publish",
            json!({"expected_revision": 1}).to_string(),
            "application/json",
        ),
        (
            "DELETE",
            "/api/admin/pages/page-target/publication",
            "".to_string(),
            "application/json",
        ),
        (
            "DELETE",
            delete_asset_uri.as_str(),
            "".to_string(),
            "application/json",
        ),
        (
            "DELETE",
            "/api/admin/pages/page-target",
            "".to_string(),
            "application/json",
        ),
        (
            "POST",
            "/api/admin/logout",
            "".to_string(),
            "application/json",
        ),
    ];

    for (method, uri, body_str, content_type) in &mutating_endpoints {
        // Scenario A: Missing X-CSRF-Token header
        let req_missing = Request::builder()
            .method(*method)
            .uri(*uri)
            .header(header::COOKIE, &cookie)
            .header(header::CONTENT_TYPE, *content_type)
            .body(Body::from(body_str.clone()))
            .unwrap();

        let resp_missing = harness.app.clone().oneshot(req_missing).await.unwrap();
        assert_eq!(
            resp_missing.status(),
            StatusCode::FORBIDDEN,
            "Endpoint {method} {uri} MUST reject request missing X-CSRF-Token"
        );

        // Scenario B: Empty X-CSRF-Token header
        let req_empty = Request::builder()
            .method(*method)
            .uri(*uri)
            .header(header::COOKIE, &cookie)
            .header("X-CSRF-Token", "")
            .header(header::CONTENT_TYPE, *content_type)
            .body(Body::from(body_str.clone()))
            .unwrap();

        let resp_empty = harness.app.clone().oneshot(req_empty).await.unwrap();
        assert_eq!(
            resp_empty.status(),
            StatusCode::FORBIDDEN,
            "Endpoint {method} {uri} MUST reject request with empty X-CSRF-Token"
        );

        // Scenario C: Forged / Fake X-CSRF-Token header
        let req_forged = Request::builder()
            .method(*method)
            .uri(*uri)
            .header(header::COOKIE, &cookie)
            .header(
                "X-CSRF-Token",
                "attacker_forged_csrf_token_1234567890abcdef",
            )
            .header(header::CONTENT_TYPE, *content_type)
            .body(Body::from(body_str.clone()))
            .unwrap();

        let resp_forged = harness.app.clone().oneshot(req_forged).await.unwrap();
        assert_eq!(
            resp_forged.status(),
            StatusCode::FORBIDDEN,
            "Endpoint {method} {uri} MUST reject request with forged X-CSRF-Token"
        );
    }
}

#[tokio::test]
async fn test_challenge_origin_and_referer_spoofing_attacks() {
    let harness = TestHarness::new().await;
    let (cookie, valid_csrf, _) = harness.login_as_admin().await;

    // Mutating action payload
    let sub_payload = json!({"name": "Origin Test"}).to_string();

    let malicious_origins = [
        "http://evil.com",
        "https://evil.com",
        "http://attacker.com:8080",
        "http://localhost.attacker.com",
        "http://127.0.0.1.evilcorp.org",
        "https://127.0.0.1.attacker.com:8080",
        "null",
        "about:blank",
    ];

    for evil_origin in malicious_origins {
        let req = Request::builder()
            .method("POST")
            .uri("/api/admin/subjects")
            .header(header::COOKIE, &cookie)
            .header("X-CSRF-Token", &valid_csrf)
            .header(header::ORIGIN, evil_origin)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(sub_payload.clone()))
            .unwrap();

        let resp = harness.app.clone().oneshot(req).await.unwrap();
        assert_eq!(
            resp.status(),
            StatusCode::FORBIDDEN,
            "Malicious origin '{evil_origin}' must be strictly rejected with HTTP 403"
        );
    }

    let malicious_referers = [
        "http://evil.com/phishing.html",
        "http://attacker.com/exploit?victim=127.0.0.1",
        "http://localhost.evil.com/post",
    ];

    for evil_ref in malicious_referers {
        let req = Request::builder()
            .method("POST")
            .uri("/api/admin/subjects")
            .header(header::COOKIE, &cookie)
            .header("X-CSRF-Token", &valid_csrf)
            .header(header::REFERER, evil_ref)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(sub_payload.clone()))
            .unwrap();

        let resp = harness.app.clone().oneshot(req).await.unwrap();
        assert_eq!(
            resp.status(),
            StatusCode::FORBIDDEN,
            "Malicious referer '{evil_ref}' must be strictly rejected with HTTP 403"
        );
    }

    // Legitimate Origin check
    let valid_origins = [
        "http://127.0.0.1:8080",
        "http://localhost:8080",
        "http://localhost:3000",
    ];

    for (idx, good_origin) in valid_origins.iter().enumerate() {
        let req = Request::builder()
            .method("POST")
            .uri("/api/admin/subjects")
            .header(header::COOKIE, &cookie)
            .header("X-CSRF-Token", &valid_csrf)
            .header(header::ORIGIN, *good_origin)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                json!({"name": format!("Valid Sub {idx}")}).to_string(),
            ))
            .unwrap();

        let resp = harness.app.clone().oneshot(req).await.unwrap();
        assert_eq!(
            resp.status(),
            StatusCode::CREATED,
            "Legitimate origin '{good_origin}' must be accepted"
        );
    }
}

#[tokio::test]
async fn test_challenge_cross_session_csrf_token_swap_rejected() {
    let harness = TestHarness::new().await;

    // Create Session 1
    let (cookie1, csrf1, _) = harness.login_as_admin().await;

    // Create Session 2
    let (cookie2, csrf2, _) = harness.login_as_admin().await;

    // Tokens must be unique per session
    assert_ne!(
        cookie1, cookie2,
        "Two logins must yield distinct session cookies"
    );
    assert_ne!(
        csrf1, csrf2,
        "Two sessions must have distinct derived CSRF tokens"
    );

    // Cross-session swap 1: Cookie 1 with CSRF 2 -> MUST BE REJECTED 403
    let req1 = Request::builder()
        .method("POST")
        .uri("/api/admin/subjects")
        .header(header::COOKIE, &cookie1)
        .header("X-CSRF-Token", &csrf2)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({"name": "Swap 1"}).to_string()))
        .unwrap();

    let resp1 = harness.app.clone().oneshot(req1).await.unwrap();
    assert_eq!(
        resp1.status(),
        StatusCode::FORBIDDEN,
        "CSRF token from Session 2 must be rejected when presented with Session 1 cookie"
    );

    // Cross-session swap 2: Cookie 2 with CSRF 1 -> MUST BE REJECTED 403
    let req2 = Request::builder()
        .method("POST")
        .uri("/api/admin/subjects")
        .header(header::COOKIE, &cookie2)
        .header("X-CSRF-Token", &csrf1)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({"name": "Swap 2"}).to_string()))
        .unwrap();

    let resp2 = harness.app.clone().oneshot(req2).await.unwrap();
    assert_eq!(
        resp2.status(),
        StatusCode::FORBIDDEN,
        "CSRF token from Session 1 must be rejected when presented with Session 2 cookie"
    );

    // Matching pairs must succeed
    let req_ok = Request::builder()
        .method("POST")
        .uri("/api/admin/subjects")
        .header(header::COOKIE, &cookie1)
        .header("X-CSRF-Token", &csrf1)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({"name": "Legit Sub"}).to_string()))
        .unwrap();
    let resp_ok = harness.app.clone().oneshot(req_ok).await.unwrap();
    assert_eq!(resp_ok.status(), StatusCode::CREATED);
}

// ============================================================================
// 3. Session Security & Token Cryptographic Hygiene Tests
// ============================================================================

#[tokio::test]
async fn test_challenge_raw_session_tokens_never_stored_in_sqlite() {
    let harness = TestHarness::new().await;
    let (_, _, raw_token) = harness.login_as_admin().await;

    // Assert raw token is 64 hex characters (32 random bytes)
    assert_eq!(raw_token.len(), 64);
    assert!(raw_token.chars().all(|c| c.is_ascii_hexdigit()));

    // Query SQLite sessions table
    let rows = sqlx::query_as::<_, (String, i64, String)>(
        "SELECT token_hash, admin_id, expires_at FROM sessions",
    )
    .fetch_all(&harness.db)
    .await
    .unwrap();

    assert_eq!(rows.len(), 1, "Expected exactly 1 session row");
    let (token_hash, admin_id, _) = &rows[0];

    // Cryptographic hygiene assertion:
    // 1. Raw token must NEVER match the stored token_hash
    assert_ne!(
        &raw_token, token_hash,
        "CRITICAL SECURITY FLAW: Raw session token was stored in plain text in database!"
    );

    // 2. Stored token_hash must be the exact SHA-256 hash of the raw token
    let expected_hash = hash_sha256(&raw_token);
    assert_eq!(
        token_hash, &expected_hash,
        "Stored token_hash must be SHA-256(raw_token)"
    );
    assert_eq!(*admin_id, 1);

    // 3. Confirm raw token cannot be found anywhere in the sessions table
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE token_hash = ?")
        .bind(&raw_token)
        .fetch_one(&harness.db)
        .await
        .unwrap();
    assert_eq!(
        count, 0,
        "Searching SQLite for raw session token returned a row!"
    );
}

#[tokio::test]
async fn test_challenge_session_lifecycle_expiration_and_revocation() {
    let harness = TestHarness::new().await;
    let (cookie, csrf, raw_token) = harness.login_as_admin().await;

    // Upload draft asset to test media gating with expired session
    sqlx::query("INSERT INTO subjects (id, name) VALUES ('sub-exp', 'Expiration Sub')")
        .execute(&harness.db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO pages (id, draft_subject_id, draft_title, revision) VALUES ('page-exp', 'sub-exp', 'Expiration Page', 1)")
        .execute(&harness.db)
        .await
        .unwrap();

    let asset = harness
        .upload_asset(
            &cookie,
            &csrf,
            "page-exp",
            "exp_test.png",
            "image/png",
            VALID_PNG,
        )
        .await;

    // 1. Manually expire the session in SQLite: set expires_at = 1 hour ago
    let token_hash = hash_sha256(&raw_token);
    sqlx::query("UPDATE sessions SET expires_at = datetime('now', '-1 hour') WHERE token_hash = ?")
        .bind(&token_hash)
        .execute(&harness.db)
        .await
        .unwrap();

    // 2. Request GET /api/admin/me with expired cookie -> MUST return 401 UNAUTHORIZED
    let me_req = Request::builder()
        .method("GET")
        .uri("/api/admin/me")
        .header(header::COOKIE, &cookie)
        .body(Body::empty())
        .unwrap();

    let me_resp = harness.app.clone().oneshot(me_req).await.unwrap();
    assert_eq!(
        me_resp.status(),
        StatusCode::UNAUTHORIZED,
        "Expired session must be rejected with HTTP 401"
    );

    // 3. Request draft media with expired cookie -> MUST return 404 MEDIA_NOT_FOUND (NOT 401 or 403)
    let media_req = Request::builder()
        .method("GET")
        .uri(format!("/media/{}", asset.id))
        .header(header::COOKIE, &cookie)
        .body(Body::empty())
        .unwrap();

    let media_resp = harness.app.clone().oneshot(media_req).await.unwrap();
    assert_eq!(
        media_resp.status(),
        StatusCode::NOT_FOUND,
        "Expired admin session accessing draft media must return 404 MEDIA_NOT_FOUND"
    );

    // 4. Test database pruning of expired sessions
    let pruned = prune_expired_sessions(&harness.db).await.unwrap();
    assert_eq!(
        pruned, 1,
        "prune_expired_sessions should remove the 1 expired session"
    );

    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions")
        .fetch_one(&harness.db)
        .await
        .unwrap();
    assert_eq!(count, 0, "Sessions table must be empty after pruning");
}

#[tokio::test]
async fn test_challenge_logout_and_password_reset_session_invalidation() {
    let harness = TestHarness::new().await;
    let (cookie, csrf, raw_token) = harness.login_as_admin().await;

    // Verify session exists
    let token_hash = hash_sha256(&raw_token);
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE token_hash = ?")
        .bind(&token_hash)
        .fetch_one(&harness.db)
        .await
        .unwrap();
    assert_eq!(count, 1);

    // 1. Perform logout with valid CSRF
    let logout_req = Request::builder()
        .method("POST")
        .uri("/api/admin/logout")
        .header(header::COOKIE, &cookie)
        .header("X-CSRF-Token", &csrf)
        .body(Body::empty())
        .unwrap();

    let logout_resp = harness.app.clone().oneshot(logout_req).await.unwrap();
    assert_eq!(logout_resp.status(), StatusCode::OK);

    // Verify Set-Cookie clears cookie with Max-Age=0
    let set_cookie = logout_resp
        .headers()
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap();
    assert!(set_cookie.contains("Max-Age=0"));

    // Verify session record is deleted from SQLite
    let count_after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE token_hash = ?")
        .bind(&token_hash)
        .fetch_one(&harness.db)
        .await
        .unwrap();
    assert_eq!(
        count_after, 0,
        "Session row must be completely deleted upon logout"
    );

    // Verify old cookie is rejected on GET /api/admin/me
    let me_req = Request::builder()
        .method("GET")
        .uri("/api/admin/me")
        .header(header::COOKIE, &cookie)
        .body(Body::empty())
        .unwrap();
    let me_resp = harness.app.clone().oneshot(me_req).await.unwrap();
    assert_eq!(me_resp.status(), StatusCode::UNAUTHORIZED);

    // 2. Multi-Session Invalidation on Password Reset
    // Create 3 concurrent sessions
    let (c1, _, _) = harness.login_as_admin().await;
    let (c2, _, _) = harness.login_as_admin().await;
    let (c3, _, _) = harness.login_as_admin().await;

    let sess_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions")
        .fetch_one(&harness.db)
        .await
        .unwrap();
    assert_eq!(sess_count, 3, "Expected 3 active sessions");

    // Admin resets password
    reset_admin_password(&harness.db, "admin", "new_super_secure_admin_password_999")
        .await
        .unwrap();

    // Verify ALL sessions in SQLite are revoked
    let sess_count_after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions")
        .fetch_one(&harness.db)
        .await
        .unwrap();
    assert_eq!(
        sess_count_after, 0,
        "Password reset must immediately revoke ALL active sessions"
    );

    // Check all 3 old cookies now return 401 UNAUTHORIZED
    for (i, c) in [&c1, &c2, &c3].iter().enumerate() {
        let req = Request::builder()
            .method("GET")
            .uri("/api/admin/me")
            .header(header::COOKIE, *c)
            .body(Body::empty())
            .unwrap();
        let resp = harness.app.clone().oneshot(req).await.unwrap();
        assert_eq!(
            resp.status(),
            StatusCode::UNAUTHORIZED,
            "Session {i} must be revoked after password reset"
        );
    }
}

// ============================================================================
// 4. Path Traversal & Malformed Media ID Safety Tests
// ============================================================================

#[tokio::test]
async fn test_challenge_media_uuid_path_traversal_and_malformed_ids() {
    let harness = TestHarness::new().await;

    // Vector Group 1: Malformed media IDs hitting the /media/{id} route handler
    let malformed_single_segment_ids = [
        "non-existent-file",
        "%27%20OR%20%271%27=%271",              // SQL injection attempt
        "12345",                                // Short numeric
        "%3Cscript%3Ealert(1)",                 // XSS fragment without slashes
        "00000000-0000-0000-0000-00000000000g", // invalid hex digit
        "uuid-with-null%00byte",                // null byte injection attempt
        "invalid-uuid-format-that-is-too-long-to-be-a-uuid",
    ];

    for malicious_id in malformed_single_segment_ids {
        let req = Request::builder()
            .method("GET")
            .uri(format!("/media/{malicious_id}"))
            .body(Body::empty())
            .unwrap();

        let resp = harness.app.clone().oneshot(req).await.unwrap();
        assert_eq!(
            resp.status(),
            StatusCode::NOT_FOUND,
            "Malformed ID '{malicious_id}' must return 404 NOT_FOUND"
        );

        let body = resp.into_body().collect().await.unwrap().to_bytes();
        let err: ErrorResponse = serde_json::from_slice(&body).unwrap();
        assert_eq!(err.error.code, "MEDIA_NOT_FOUND");
    }

    // Vector Group 2: Path traversal and directory escaping attempts
    let traversal_uris = [
        "/media/..",
        "/media/../etc/passwd",
        "/media/../../Cargo.toml",
        "/media/../../../windows/win.ini",
        "/media/..%2f..%2fetc%2fpasswd",
        "/media/..%5c..%5cboot.ini",
        "/media/%3Cscript%3Ealert(1)%3C/script%3E",
    ];

    for traversal_uri in traversal_uris {
        let req = Request::builder()
            .method("GET")
            .uri(traversal_uri)
            .body(Body::empty())
            .unwrap();

        let resp = harness.app.clone().oneshot(req).await.unwrap();
        assert_eq!(
            resp.status(),
            StatusCode::NOT_FOUND,
            "Path traversal '{traversal_uri}' must not resolve or leak files"
        );
    }
}
