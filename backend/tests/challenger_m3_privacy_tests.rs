//! Challenger 2: Privacy, Concurrency & Boundary Adversarial Stress Tests
//!
//! Empirically stress-tests:
//! 1. Concurrency & State Transition Race: High-concurrency reads vs rapid publish/unpublish; zero draft leakage.
//! 2. Dual-State Secret Tampering Resistance: Draft mutations to title, markdown, and subject; zero draft leakage into public catalog/search/detail.
//! 3. Attachment Cross-Contamination & Scoping: Selected attachments vs draft attachments vs images vs foreign page assets; zero leakage into public attachments.
//! 4. Non-SPA 404 Fallback Boundary Probing: 45+ malformed, deep, traversal, and invalid paths under /api/* and /media/*; strictly JSON error envelope.
//! 5. SQL Search Wildcards & Adversarial Injection: LIKE wildcard escaping (`%`, `_`, `\`), SQL injection strings, unicode/Cyrillic case folding.
//! 6. Dynamic Subject Page Count & Ordering Stress: Position/name sorting, immediate exclusion when page_count drops to 0.
//! 7. Disk-backed SQLite WAL Concurrency Stress: Multi-connection pool under parallel read/write contention.

use axum::{
    body::Body,
    http::{header, Method, Request, StatusCode},
};
use backend::{
    config::Config,
    db::{init_db, init_test_db, DbPool},
    models::{
        AssetResponse, PublicPageListResponse, PublicPageViewResponse, PublicSubjectItem,
        PublishPageResponse, SubjectResponse, UpdatePageResponse,
    },
    routes::create_router,
    AppState,
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
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
const VALID_DOCX: &[u8] = b"PK\x03\x04mock docx archive payload for testing attachments";
const VALID_TXT: &[u8] = b"This is plain text attachment data for challenger test.";

fn percent_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' || b == b'~' {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

#[derive(Clone)]
struct ChallengerHarness {
    pub app: axum::Router,
    #[allow(dead_code)]
    pub db: DbPool,
    pub cookie: String,
    pub csrf_token: String,
    pub _temp_dir: Arc<TempDir>,
}

impl ChallengerHarness {
    /// In-memory SQLite harness.
    pub async fn new_in_memory() -> Self {
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

        let (cookie, csrf_token) = Self::login_admin(&app).await;

        Self {
            app,
            db,
            cookie,
            csrf_token,
            _temp_dir: Arc::new(temp_dir),
        }
    }

    /// Real disk-backed SQLite WAL harness with multi-connection pool.
    pub async fn new_disk_wal() -> Self {
        let temp_dir = tempfile::tempdir().unwrap();
        let db_file = temp_dir.path().join("challenger_wal.db");
        let db_path_str = db_file.to_str().unwrap().replace('\\', "/");
        let db_url = format!("sqlite://{db_path_str}");

        let db = init_db(&db_url).await.unwrap();

        let config = Config {
            host: "127.0.0.1".to_string(),
            port: 8080,
            base_url: "http://127.0.0.1:8080".to_string(),
            database_url: db_url,
            data_dir: temp_dir.path().to_path_buf(),
            cookie_secure: false,
            admin_username: "admin".to_string(),
            admin_password: Some("challenger_admin_password_123".to_string()),
            session_secret: "challenger_session_secret_32_chars_long".to_string(),
            max_image_bytes: 10 * 1024 * 1024,
            max_attachment_bytes: 50 * 1024 * 1024,
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

        let (cookie, csrf_token) = Self::login_admin(&app).await;

        Self {
            app,
            db,
            cookie,
            csrf_token,
            _temp_dir: Arc::new(temp_dir),
        }
    }

    async fn login_admin(app: &axum::Router) -> (String, String) {
        let login_payload = json!({
            "username": "admin",
            "password": "challenger_admin_password_123"
        });
        let login_req = Request::builder()
            .method("POST")
            .uri("/api/admin/login")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::to_vec(&login_payload).unwrap()))
            .unwrap();
        let login_resp = app.clone().oneshot(login_req).await.unwrap();
        assert_eq!(login_resp.status(), StatusCode::OK);
        let cookie = login_resp
            .headers()
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        let login_bytes = login_resp.into_body().collect().await.unwrap().to_bytes();
        let login_json: Value = serde_json::from_slice(&login_bytes).unwrap();
        let csrf_token = login_json["csrf_token"].as_str().unwrap().to_string();
        (cookie, csrf_token)
    }

    pub async fn create_subject(&self, name: &str, position: i64) -> String {
        let req = Request::builder()
            .method("POST")
            .uri("/api/admin/subjects")
            .header(header::COOKIE, &self.cookie)
            .header("X-CSRF-Token", &self.csrf_token)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                serde_json::to_vec(&json!({
                    "name": name,
                    "position": position
                }))
                .unwrap(),
            ))
            .unwrap();
        let resp = self.app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let subject: SubjectResponse = serde_json::from_slice(&bytes).unwrap();
        subject.id
    }

    pub async fn create_draft_page(
        &self,
        subject_id: &str,
        title: &str,
        markdown: &str,
    ) -> (String, i64) {
        let req = Request::builder()
            .method("POST")
            .uri("/api/admin/pages")
            .header(header::COOKIE, &self.cookie)
            .header("X-CSRF-Token", &self.csrf_token)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                serde_json::to_vec(&json!({
                    "subject_id": subject_id,
                    "title": title
                }))
                .unwrap(),
            ))
            .unwrap();
        let resp = self.app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let page_json: Value = serde_json::from_slice(&bytes).unwrap();
        let page_id = page_json["id"].as_str().unwrap().to_string();
        let mut rev = page_json["revision"].as_i64().unwrap();

        if !markdown.is_empty() {
            let update_req = Request::builder()
                .method("PATCH")
                .uri(format!("/api/admin/pages/{page_id}"))
                .header(header::COOKIE, &self.cookie)
                .header("X-CSRF-Token", &self.csrf_token)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    serde_json::to_vec(&json!({
                        "expected_revision": rev,
                        "markdown": markdown
                    }))
                    .unwrap(),
                ))
                .unwrap();
            let update_resp = self.app.clone().oneshot(update_req).await.unwrap();
            assert_eq!(update_resp.status(), StatusCode::OK);
            let ubytes = update_resp.into_body().collect().await.unwrap().to_bytes();
            let ujson: UpdatePageResponse = serde_json::from_slice(&ubytes).unwrap();
            rev = ujson.revision;
        }

        (page_id, rev)
    }

    pub async fn update_draft(
        &self,
        page_id: &str,
        expected_rev: i64,
        title: Option<&str>,
        markdown: Option<&str>,
        subject_id: Option<&str>,
    ) -> i64 {
        let mut payload = serde_json::Map::new();
        payload.insert("expected_revision".to_string(), json!(expected_rev));
        if let Some(t) = title {
            payload.insert("title".to_string(), json!(t));
        }
        if let Some(m) = markdown {
            payload.insert("markdown".to_string(), json!(m));
        }
        if let Some(s) = subject_id {
            payload.insert("subject_id".to_string(), json!(s));
        }
        let req = Request::builder()
            .method("PATCH")
            .uri(format!("/api/admin/pages/{page_id}"))
            .header(header::COOKIE, &self.cookie)
            .header("X-CSRF-Token", &self.csrf_token)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::to_vec(&payload).unwrap()))
            .unwrap();
        let resp = self.app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let ujson: UpdatePageResponse = serde_json::from_slice(&bytes).unwrap();
        ujson.revision
    }

    pub async fn publish_page(
        &self,
        page_id: &str,
        expected_rev: i64,
        attachment_ids: &[String],
    ) -> (StatusCode, Value) {
        let req = Request::builder()
            .method("POST")
            .uri(format!("/api/admin/pages/{page_id}/publish"))
            .header(header::COOKIE, &self.cookie)
            .header("X-CSRF-Token", &self.csrf_token)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                serde_json::to_vec(&json!({
                    "expected_revision": expected_rev,
                    "attachment_ids": attachment_ids
                }))
                .unwrap(),
            ))
            .unwrap();
        let resp = self.app.clone().oneshot(req).await.unwrap();
        let status = resp.status();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let val: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, val)
    }

    pub async fn unpublish_page(&self, page_id: &str) -> (StatusCode, Value) {
        let req = Request::builder()
            .method("DELETE")
            .uri(format!("/api/admin/pages/{page_id}/publication"))
            .header(header::COOKIE, &self.cookie)
            .header("X-CSRF-Token", &self.csrf_token)
            .body(Body::empty())
            .unwrap();
        let resp = self.app.clone().oneshot(req).await.unwrap();
        let status = resp.status();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let val: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, val)
    }

    pub async fn upload_asset(
        &self,
        page_id: &str,
        filename: &str,
        mime: &str,
        data: &[u8],
    ) -> AssetResponse {
        let boundary = "---------------------------boundary987654321";
        let header_part = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: {mime}\r\n\r\n"
        );
        let mut body = Vec::new();
        body.extend_from_slice(header_part.as_bytes());
        body.extend_from_slice(data);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

        let req = Request::builder()
            .method("POST")
            .uri(format!("/api/admin/pages/{page_id}/assets"))
            .header(header::COOKIE, &self.cookie)
            .header("X-CSRF-Token", &self.csrf_token)
            .header(
                header::CONTENT_TYPE,
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(Body::from(body))
            .unwrap();
        let resp = self.app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).unwrap()
    }

    pub async fn get_public_subjects(&self) -> (StatusCode, Value) {
        let req = Request::builder()
            .method("GET")
            .uri("/api/public/subjects")
            .body(Body::empty())
            .unwrap();
        let resp = self.app.clone().oneshot(req).await.unwrap();
        let status = resp.status();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let val: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, val)
    }

    pub async fn get_public_pages(&self, query_params: &str) -> (StatusCode, Value) {
        let uri = if query_params.is_empty() {
            "/api/public/pages".to_string()
        } else {
            format!("/api/public/pages?{query_params}")
        };
        let req = Request::builder()
            .method("GET")
            .uri(uri)
            .body(Body::empty())
            .unwrap();
        let resp = self.app.clone().oneshot(req).await.unwrap();
        let status = resp.status();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let val: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, val)
    }

    pub async fn get_public_page(&self, page_id: &str) -> (StatusCode, Value) {
        let req = Request::builder()
            .method("GET")
            .uri(format!("/api/public/pages/{page_id}"))
            .body(Body::empty())
            .unwrap();
        let resp = self.app.clone().oneshot(req).await.unwrap();
        let status = resp.status();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let val: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, val)
    }

    pub async fn get_raw_uri(
        &self,
        method: Method,
        uri: &str,
    ) -> (StatusCode, Option<String>, Value) {
        let req = Request::builder()
            .method(method)
            .uri(uri)
            .body(Body::empty())
            .unwrap();
        let resp = self.app.clone().oneshot(req).await.unwrap();
        let status = resp.status();
        let ct = resp
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let val: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, ct, val)
    }
}

// ============================================================================
// CHALLENGE TEST 1: Concurrency & State Transition Race (Zero Draft Leakage)
// ============================================================================
#[tokio::test]
async fn test_adversarial_concurrency_race_publish_unpublish_zero_leakage() {
    let harness = ChallengerHarness::new_in_memory().await;

    // Create 2 subjects
    let sub_a = harness.create_subject("Race Subject A", 1).await;
    let sub_b = harness.create_subject("Race Subject B", 2).await;

    // Create 4 initial pages (2 in A, 2 in B)
    // P1: Published under Alpha with public content
    let (p1, rev1) = harness
        .create_draft_page(&sub_a, "Pub Page Alpha 1", "Public body Alpha 1 content")
        .await;
    let (s, _) = harness.publish_page(&p1, rev1, &[]).await;
    assert_eq!(s, StatusCode::OK);

    // Mutate P1 draft to contain secret canary (WITHOUT republishing)
    let _p1_rev = harness
        .update_draft(
            &p1,
            rev1,
            Some("TOP_SECRET_CANARY_P1_TITLE"),
            Some("UNPUBLISHED_SECRET_BODY_P1_PAYLOAD"),
            None,
        )
        .await;

    // P2: Toggle page published under Alpha
    let (p2, rev2) = harness
        .create_draft_page(&sub_a, "Pub Page Alpha 2", "Public body Alpha 2 content")
        .await;
    let (s, _) = harness.publish_page(&p2, rev2, &[]).await;
    assert_eq!(s, StatusCode::OK);

    // P3: Draft only under Beta (NEVER published)
    let (p3, _rev3) = harness
        .create_draft_page(
            &sub_b,
            "TOP_SECRET_CANARY_P3_TITLE",
            "UNPUBLISHED_SECRET_BODY_P3_PAYLOAD",
        )
        .await;

    // P4: Toggle page published under Beta
    let (p4, rev4) = harness
        .create_draft_page(&sub_b, "Pub Page Beta 2", "Public body Beta 2 content")
        .await;
    let (s, _) = harness.publish_page(&p4, rev4, &[]).await;
    assert_eq!(s, StatusCode::OK);

    let stop_signal = Arc::new(AtomicBool::new(false));
    let read_counter = Arc::new(AtomicUsize::new(0));

    // Spawn 4 high-frequency concurrent reader tasks
    let mut reader_handles = Vec::new();

    // Reader 1: Catalog list
    {
        let h = harness.clone();
        let stop = stop_signal.clone();
        let cnt = read_counter.clone();
        reader_handles.push(tokio::spawn(async move {
            while !stop.load(Ordering::Relaxed) {
                let (status, body) = h.get_public_pages("").await;
                assert_eq!(status, StatusCode::OK);
                let text = body.to_string();
                assert!(
                    !text.contains("TOP_SECRET_CANARY") && !text.contains("UNPUBLISHED_SECRET"),
                    "LEAK IN CATALOG LIST: {text}"
                );
                let total = body["total"].as_i64().unwrap();
                let items = body["items"].as_array().unwrap();
                // Under read transaction snapshot isolation (BEGIN ... COMMIT),
                // count_query and data_query MUST see identical snapshots!
                assert_eq!(
                    items.len() as i64,
                    total,
                    "Read transaction snapshot isolation violated! items={}, total={}",
                    items.len(),
                    total
                );
                cnt.fetch_add(1, Ordering::Relaxed);
                tokio::task::yield_now().await;
            }
        }));
    }

    // Reader 2: Search queries for secrets and public tokens
    {
        let h = harness.clone();
        let stop = stop_signal.clone();
        let cnt = read_counter.clone();
        reader_handles.push(tokio::spawn(async move {
            while !stop.load(Ordering::Relaxed) {
                // Search for secret canary: MUST RETURN ZERO
                let (status, body) = h.get_public_pages("q=CANARY").await;
                assert_eq!(status, StatusCode::OK);
                assert_eq!(
                    body["total"].as_i64().unwrap(),
                    0,
                    "Draft canary leaked into search!"
                );
                assert_eq!(body["items"].as_array().unwrap().len(), 0);

                let (status, body) = h.get_public_pages("q=UNPUBLISHED").await;
                assert_eq!(status, StatusCode::OK);
                assert_eq!(body["total"].as_i64().unwrap(), 0);

                // Search for valid public token
                let (status, body) = h.get_public_pages("q=Alpha").await;
                assert_eq!(status, StatusCode::OK);
                let text = body.to_string();
                assert!(!text.contains("CANARY") && !text.contains("UNPUBLISHED"));

                cnt.fetch_add(1, Ordering::Relaxed);
                tokio::task::yield_now().await;
            }
        }));
    }

    // Reader 3: Single page detail view probing
    {
        let h = harness.clone();
        let stop = stop_signal.clone();
        let cnt = read_counter.clone();
        let p_list = [p1.clone(), p2.clone(), p3.clone(), p4.clone()];
        reader_handles.push(tokio::spawn(async move {
            let mut idx = 0;
            while !stop.load(Ordering::Relaxed) {
                let target_p = &p_list[idx % p_list.len()];
                let (status, body) = h.get_public_page(target_p).await;
                if status == StatusCode::OK {
                    let text = body.to_string();
                    assert!(
                        !text.contains("TOP_SECRET_CANARY") && !text.contains("UNPUBLISHED_SECRET"),
                        "LEAK IN PAGE DETAIL: {text}"
                    );
                } else if status == StatusCode::NOT_FOUND {
                    assert_eq!(body["error"]["code"].as_str().unwrap(), "PAGE_NOT_FOUND");
                } else {
                    panic!("Unexpected status code in page view: {status}");
                }
                idx += 1;
                cnt.fetch_add(1, Ordering::Relaxed);
                tokio::task::yield_now().await;
            }
        }));
    }

    // Reader 4: Subjects list count verification
    {
        let h = harness.clone();
        let stop = stop_signal.clone();
        let cnt = read_counter.clone();
        reader_handles.push(tokio::spawn(async move {
            while !stop.load(Ordering::Relaxed) {
                let (status, body) = h.get_public_subjects().await;
                assert_eq!(status, StatusCode::OK);
                if let Some(arr) = body.as_array() {
                    for subj in arr {
                        let count = subj["page_count"].as_i64().unwrap();
                        assert!(
                            count > 0,
                            "Subject with 0 published pages must not be returned!"
                        );
                    }
                }
                cnt.fetch_add(1, Ordering::Relaxed);
                tokio::task::yield_now().await;
            }
        }));
    }

    // Writer task: rapid alternating unpublish and publish cycles on toggle pages (P2 & P4)
    let h_writer = harness.clone();
    for iteration in 0..15 {
        // Unpublish P2 & P4
        let (s, _) = h_writer.unpublish_page(&p2).await;
        assert_eq!(s, StatusCode::OK);
        let (s, _) = h_writer.unpublish_page(&p4).await;
        assert_eq!(s, StatusCode::OK);

        tokio::time::sleep(Duration::from_millis(5)).await;

        // Republish P2 & P4
        let (s, _) = h_writer.publish_page(&p2, rev2, &[]).await;
        assert_eq!(s, StatusCode::OK);
        let (s, _) = h_writer.publish_page(&p4, rev4, &[]).await;
        assert_eq!(s, StatusCode::OK);

        if iteration % 5 == 0 {
            tokio::task::yield_now().await;
        }
    }

    // Stop readers and wait
    stop_signal.store(true, Ordering::Relaxed);
    for handle in reader_handles {
        handle.await.unwrap();
    }

    let total_reads = read_counter.load(Ordering::Relaxed);
    assert!(
        total_reads >= 50,
        "Expected at least 50 concurrent reads during race, got {total_reads}"
    );
}

// ============================================================================
// CHALLENGE TEST 2: Dual-State Secret Tampering Deep Isolation
// ============================================================================
#[tokio::test]
async fn test_dual_state_secret_tampering_deep_isolation() {
    let harness = ChallengerHarness::new_in_memory().await;

    let sub_phys = harness.create_subject("Physics Department", 10).await;
    let sub_chem = harness.create_subject("Chemistry Department", 20).await;

    // Page 1: Published under Physics
    let (p1, rev1) = harness
        .create_draft_page(
            &sub_phys,
            "Classical Mechanics 101",
            "# Classical Mechanics\nNewton's laws of motion form the basis of classical physics.",
        )
        .await;
    let (s, _) = harness.publish_page(&p1, rev1, &[]).await;
    assert_eq!(s, StatusCode::OK);

    // Page 2: Strictly draft under Chemistry (never published)
    let (p2, _rev2) = harness
        .create_draft_page(
            &sub_chem,
            "CLASSIFIED_CHEM_EXAM_ANSWERS",
            "CONFIDENTIAL: Question 1 is Hydrochloric Acid, Question 2 is Sodium Hydroxide.",
        )
        .await;

    // Tamper with Page 1 draft:
    // Change title to nuclear secret, body to confidential coordinates, and move subject to Chemistry!
    let rev1_updated = harness
        .update_draft(
            &p1,
            rev1,
            Some("TAMPERED_DRAFT_SECRET_NUCLEAR_CODE_98765"),
            Some("TOP_SECRET_MILITARY_DRAFT_COORDINATES_54321"),
            Some(&sub_chem), // Moving draft to Chemistry!
        )
        .await;

    // 1. Verify Public Catalog List
    let (s, list_res) = harness.get_public_pages("").await;
    assert_eq!(s, StatusCode::OK);
    let list: PublicPageListResponse = serde_json::from_value(list_res).unwrap();
    assert_eq!(list.total, 1, "Only 1 page should be publicly visible!");
    assert_eq!(list.items.len(), 1);
    assert_eq!(list.items[0].id, p1);
    assert_eq!(list.items[0].title, "Classical Mechanics 101");
    assert_eq!(list.items[0].subject_id, sub_phys);
    assert_eq!(list.items[0].subject_name, "Physics Department");
    assert!(list.items[0].snippet.contains("Newton's laws"));
    assert!(!list.items[0].snippet.contains("NUCLEAR"));
    assert!(!list.items[0].snippet.contains("COORDINATES"));

    // 2. Adversarial Search Queries against Draft Secrets
    let secret_queries = [
        "NUCLEAR",
        "COORDINATES",
        "TAMPERED",
        "MILITARY",
        "CLASSIFIED",
        "EXAM",
        "ANSWERS",
        "Hydrochloric",
        "Sodium",
    ];
    for q in &secret_queries {
        let (s, res) = harness.get_public_pages(&format!("q={q}")).await;
        assert_eq!(s, StatusCode::OK);
        let list: PublicPageListResponse = serde_json::from_value(res).unwrap();
        assert_eq!(
            list.total, 0,
            "Draft secret '{q}' leaked into public search!"
        );
        assert!(list.items.is_empty());
    }

    // 3. Search for published content matches
    let (s, res) = harness.get_public_pages("q=Classical").await;
    assert_eq!(s, StatusCode::OK);
    let list: PublicPageListResponse = serde_json::from_value(res).unwrap();
    assert_eq!(list.total, 1);
    assert_eq!(list.items[0].title, "Classical Mechanics 101");

    let (s, res) = harness.get_public_pages("q=Newton").await;
    assert_eq!(s, StatusCode::OK);
    let list: PublicPageListResponse = serde_json::from_value(res).unwrap();
    assert_eq!(list.total, 1);

    // 4. Verify Subject Filtering Isolation
    // Draft of P1 is now in sub_chem, and P2 draft is in sub_chem.
    // BUT sub_chem has ZERO publications!
    let (s, res) = harness
        .get_public_pages(&format!("subject_id={sub_chem}"))
        .await;
    assert_eq!(s, StatusCode::OK);
    let list: PublicPageListResponse = serde_json::from_value(res).unwrap();
    assert_eq!(
        list.total, 0,
        "Draft subject assignment leaked into public filter!"
    );
    assert!(list.items.is_empty());

    // Published snapshot of P1 is still in sub_phys
    let (s, res) = harness
        .get_public_pages(&format!("subject_id={sub_phys}"))
        .await;
    assert_eq!(s, StatusCode::OK);
    let list: PublicPageListResponse = serde_json::from_value(res).unwrap();
    assert_eq!(list.total, 1);
    assert_eq!(list.items[0].id, p1);

    // 5. Verify Public Subjects List
    let (s, res) = harness.get_public_subjects().await;
    assert_eq!(s, StatusCode::OK);
    let subjs: Vec<PublicSubjectItem> = serde_json::from_value(res).unwrap();
    assert_eq!(
        subjs.len(),
        1,
        "Only Physics department should be listed; Chemistry has 0 published pages!"
    );
    assert_eq!(subjs[0].id, sub_phys);
    assert_eq!(subjs[0].page_count, 1);

    // 6. Verify Single Page Detail View
    let (s, p1_view) = harness.get_public_page(&p1).await;
    assert_eq!(s, StatusCode::OK);
    let view: PublicPageViewResponse = serde_json::from_value(p1_view).unwrap();
    assert_eq!(view.title, "Classical Mechanics 101");
    assert_eq!(view.subject_id, sub_phys);
    assert_eq!(view.subject_name, "Physics Department");
    assert!(view.markdown.contains("Newton's laws"));
    assert!(!view.markdown.contains("NUCLEAR"));
    assert!(!view.markdown.contains("COORDINATES"));

    // Page 2 (draft only) MUST return 404
    let (s, p2_view) = harness.get_public_page(&p2).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    assert_eq!(p2_view["error"]["code"].as_str().unwrap(), "PAGE_NOT_FOUND");

    // 7. Re-publish P1 with new tampered revision
    let (s, _) = harness.publish_page(&p1, rev1_updated, &[]).await;
    assert_eq!(s, StatusCode::OK);

    // Now P1 is published under Chemistry with nuclear title
    let (s, list_res) = harness.get_public_pages("").await;
    assert_eq!(s, StatusCode::OK);
    let list: PublicPageListResponse = serde_json::from_value(list_res).unwrap();
    assert_eq!(list.total, 1);
    assert_eq!(
        list.items[0].title,
        "TAMPERED_DRAFT_SECRET_NUCLEAR_CODE_98765"
    );
    assert_eq!(list.items[0].subject_id, sub_chem);

    // Chemistry department is now visible, Physics is gone
    let (s, res) = harness.get_public_subjects().await;
    assert_eq!(s, StatusCode::OK);
    let subjs: Vec<PublicSubjectItem> = serde_json::from_value(res).unwrap();
    assert_eq!(subjs.len(), 1);
    assert_eq!(subjs[0].id, sub_chem);

    // 8. Unpublish P1: Everything becomes immediately empty
    let (s, _) = harness.unpublish_page(&p1).await;
    assert_eq!(s, StatusCode::OK);

    let (s, list_res) = harness.get_public_pages("").await;
    assert_eq!(s, StatusCode::OK);
    let list: PublicPageListResponse = serde_json::from_value(list_res).unwrap();
    assert_eq!(list.total, 0);

    let (s, res) = harness.get_public_subjects().await;
    assert_eq!(s, StatusCode::OK);
    let subjs: Vec<PublicSubjectItem> = serde_json::from_value(res).unwrap();
    assert!(subjs.is_empty());

    let (s, p1_view) = harness.get_public_page(&p1).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    assert_eq!(p1_view["error"]["code"].as_str().unwrap(), "PAGE_NOT_FOUND");
}

// ============================================================================
// CHALLENGE TEST 3: Attachment Cross-Contamination & Scoping
// ============================================================================
#[tokio::test]
async fn test_attachment_cross_contamination_and_security_scoping() {
    let harness = ChallengerHarness::new_in_memory().await;

    let sub = harness.create_subject("Engineering", 1).await;

    // Page A
    let (p_a, rev_a) = harness
        .create_draft_page(&sub, "Lab A Electronics", "# Lab A\nOscilloscope manual.")
        .await;

    // Upload to Page A:
    // 1. Valid PDF attachment (selected for publish)
    let att_a1 = harness
        .upload_asset(&p_a, "lab_manual_a.pdf", "application/pdf", VALID_PDF)
        .await;
    // 2. Valid DOCX attachment (KEPT AS DRAFT, NOT selected for publish)
    let att_a2 = harness
        .upload_asset(
            &p_a,
            "private_rubric_a.docx",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            VALID_DOCX,
        )
        .await;
    // 3. Valid PNG image (inline image, kind='image')
    let img_a1 = harness
        .upload_asset(&p_a, "circuit_diagram.png", "image/png", VALID_PNG)
        .await;

    assert_eq!(att_a1.kind, "attachment");
    assert_eq!(att_a2.kind, "attachment");
    assert_eq!(img_a1.kind, "image");

    // Page B
    let (p_b, rev_b) = harness
        .create_draft_page(&sub, "Lab B Robotics", "# Lab B\nMotor driver specs.")
        .await;

    // Upload to Page B:
    let att_b1 = harness
        .upload_asset(&p_b, "robot_datasheet_b.pdf", "application/pdf", VALID_PDF)
        .await;
    let img_b1 = harness
        .upload_asset(&p_b, "robot_photo.png", "image/png", VALID_PNG)
        .await;

    // Page C (draft only, never published)
    let (p_c, _) = harness
        .create_draft_page(&sub, "Lab C Draft", "# Lab C\nDraft content.")
        .await;
    let att_c1 = harness
        .upload_asset(&p_c, "draft_notes_c.txt", "text/plain", VALID_TXT)
        .await;

    // 1. Publish Page A selecting ONLY att_a1
    let (s, pub_res_a) = harness
        .publish_page(&p_a, rev_a, std::slice::from_ref(&att_a1.id))
        .await;
    assert_eq!(s, StatusCode::OK);
    let pub_a: PublishPageResponse = serde_json::from_value(pub_res_a).unwrap();
    assert_eq!(pub_a.page_id, p_a);
    assert_eq!(pub_a.published_revision, rev_a);

    // 2. Publish Page B selecting att_b1
    let (s, _) = harness
        .publish_page(&p_b, rev_b, std::slice::from_ref(&att_b1.id))
        .await;
    assert_eq!(s, StatusCode::OK);

    // 3. Inspect Page A public detail view
    let (s, res_a) = harness.get_public_page(&p_a).await;
    assert_eq!(s, StatusCode::OK);
    let view_a: PublicPageViewResponse = serde_json::from_value(res_a).unwrap();

    // Invariants:
    // - MUST contain ONLY att_a1
    // - MUST NOT contain att_a2 (unselected draft attachment)
    // - MUST NOT contain img_a1 (image must be excluded from attachments array)
    // - MUST NOT contain att_b1, img_b1, or att_c1
    assert_eq!(
        view_a.attachments.len(),
        1,
        "Page A attachments must contain exactly 1 selected attachment!"
    );
    assert_eq!(view_a.attachments[0].id, att_a1.id);
    assert_eq!(view_a.attachments[0].original_name, "lab_manual_a.pdf");
    assert_eq!(view_a.attachments[0].mime, "application/pdf");
    assert_eq!(view_a.attachments[0].byte_size, VALID_PDF.len() as i64);

    let att_ids_a: Vec<String> = view_a.attachments.into_iter().map(|a| a.id).collect();
    assert!(!att_ids_a.contains(&att_a2.id), "Draft attachment leaked!");
    assert!(
        !att_ids_a.contains(&img_a1.id),
        "Image leaked into attachments!"
    );
    assert!(
        !att_ids_a.contains(&att_b1.id),
        "Foreign Page B attachment leaked!"
    );
    assert!(
        !att_ids_a.contains(&img_b1.id),
        "Foreign Page B image leaked!"
    );
    assert!(
        !att_ids_a.contains(&att_c1.id),
        "Foreign Page C draft leaked!"
    );

    // 4. Inspect Page B public detail view
    let (s, res_b) = harness.get_public_page(&p_b).await;
    assert_eq!(s, StatusCode::OK);
    let view_b: PublicPageViewResponse = serde_json::from_value(res_b).unwrap();
    assert_eq!(view_b.attachments.len(), 1);
    assert_eq!(view_b.attachments[0].id, att_b1.id);
    assert_eq!(view_b.attachments[0].original_name, "robot_datasheet_b.pdf");

    // 5. Inspect Page C (draft only) -> 404
    let (s, res_c) = harness.get_public_page(&p_c).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    assert_eq!(res_c["error"]["code"].as_str().unwrap(), "PAGE_NOT_FOUND");

    // 6. Adversarial Attack: Attempting to inject foreign attachment into Page A
    // Admin maliciously specifies Page B's attachment when publishing Page A
    let (status, err_val) = harness
        .publish_page(&p_a, rev_a, std::slice::from_ref(&att_b1.id))
        .await;
    // Expected: either rejected with 400 VALIDATION_ERROR or rejected by foreign key check
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "Cross-page attachment publish must be rejected with 400!"
    );
    assert_eq!(
        err_val["error"]["code"].as_str().unwrap(),
        "VALIDATION_ERROR"
    );

    // Verify Page A's public attachments were not corrupted
    let (s, res_a2) = harness.get_public_page(&p_a).await;
    assert_eq!(s, StatusCode::OK);
    let view_a2: PublicPageViewResponse = serde_json::from_value(res_a2).unwrap();
    assert_eq!(view_a2.attachments.len(), 1);
    assert_eq!(view_a2.attachments[0].id, att_a1.id);

    // 7. Verify Anonymous Media Route Gating:
    // - att_a1 is published -> 200 OK
    // - att_a2 is draft-only -> 404 NOT_FOUND
    // - att_c1 is draft-only -> 404 NOT_FOUND
    let (s, _, _) = harness
        .get_raw_uri(Method::GET, &format!("/media/{}", att_a1.id))
        .await;
    assert_eq!(s, StatusCode::OK);

    let (s, _, res) = harness
        .get_raw_uri(Method::GET, &format!("/media/{}", att_a2.id))
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    assert_eq!(res["error"]["code"].as_str().unwrap(), "MEDIA_NOT_FOUND");

    let (s, _, res) = harness
        .get_raw_uri(Method::GET, &format!("/media/{}", att_c1.id))
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    assert_eq!(res["error"]["code"].as_str().unwrap(), "MEDIA_NOT_FOUND");
}

// ============================================================================
// CHALLENGE TEST 4: Non-SPA 404 Fallback Deep Boundary Probing (45+ paths)
// ============================================================================
#[tokio::test]
async fn test_non_spa_404_fallback_deep_boundary_probing() {
    let harness = ChallengerHarness::new_in_memory().await;

    let probe_paths = [
        // Standard unknown API routes
        "/api",
        "/api/",
        "/api/v1",
        "/api/v1/anything",
        "/api/nonexistent",
        "/api/deep/nested/resource/path",
        // Public API typos and subroutes
        "/api/public",
        "/api/public/",
        "/api/public/unknown",
        "/api/public/pages/",
        "/api/public/subjects/",
        "/api/public/subject",
        "/api/public/page",
        "/api/public/assets",
        "/api/public/pages/not-a-valid-uuid",
        "/api/public/pages/12345678-1234-1234-1234-123456789abc/extra",
        "/api/public/pages/12345678-1234-1234-1234-123456789abc/subresource",
        "/api/public/pages/00000000-0000-0000-0000-000000000000/download",
        // Admin API routes without auth or unknown
        "/api/admin/unknown",
        "/api/admin/pages/not-a-uuid/unknown",
        "/api/admin/subjects/not-a-uuid/unknown",
        "/api/admin/login/extra",
        "/api/admin/logout/extra",
        // Media routes and subpaths
        "/media",
        "/media/",
        "/media/not-a-valid-uuid",
        "/media/12345678-1234-1234-1234-123456789abc/extra",
        "/media/12345678-1234-1234-1234-123456789abc/download",
        "/media/00000000-0000-0000-0000-000000000000/preview/extra",
        "/media/a/b/c/d/e",
        "/media//double-slash",
        // Traversal and injection attempts
        "/api/..",
        "/api/../data",
        "/api/public/..",
        "/api/public/..%2f..%2fadmin",
        "/api/admin/../../etc",
        "/media/..",
        "/media/../data",
        "/media/%2e%2e",
        "/api/%3Cscript%3Ealert(1)%3C/script%3E",
        "/api/public/%24%7Bjndi%3Aldap%7D",
        "/api/public/%D0%BA%D0%B8%D1%80%D0%B8%D0%BB%D0%BB%D0%B8%D1%86%D0%B0-404",
        "/api/invalid%21%40%23%24%25%5E%26*()",
        // Nonexistent valid UUIDs
        "/api/public/pages/00000000-0000-0000-0000-000000000000",
        "/media/00000000-0000-0000-0000-000000000000",
    ];

    for path in &probe_paths {
        let (status, content_type, body) = harness.get_raw_uri(Method::GET, path).await;

        // Invariant 1: Status MUST be 404 (or 400 for malformed URI/query)
        assert!(
            status == StatusCode::NOT_FOUND || status == StatusCode::BAD_REQUEST,
            "Path '{path}' returned unexpected status {status}!"
        );

        // Invariant 2: Content-Type MUST be application/json, NEVER text/html
        let ct_str = content_type.unwrap_or_default();
        assert!(
            ct_str.contains("application/json"),
            "Path '{path}' did NOT return application/json! Content-Type: '{ct_str}'"
        );

        // Invariant 3: Body MUST parse as JSON and contain the standard error envelope
        assert!(
            body.is_object(),
            "Path '{path}' body is not a JSON object: {body}"
        );
        let error_obj = &body["error"];
        assert!(
            error_obj.is_object(),
            "Path '{path}' missing 'error' object: {body}"
        );
        let code = error_obj["code"]
            .as_str()
            .expect("error.code must be string");
        assert!(
            !code.is_empty(),
            "Path '{path}' error.code is empty: {body}"
        );
        let message = error_obj["message"]
            .as_str()
            .expect("error.message must be string");
        assert!(
            !message.is_empty(),
            "Path '{path}' error.message is empty: {body}"
        );

        // Invariant 4: No HTML tags anywhere in response
        let raw_str = body.to_string();
        assert!(
            !raw_str.contains("<!DOCTYPE") && !raw_str.contains("<html"),
            "Path '{path}' returned HTML in body: {raw_str}"
        );
    }

    // Method variations: Non-GET requests on public endpoints without defined methods
    let method_probes = [
        (Method::POST, "/api/public/subjects"),
        (Method::DELETE, "/api/public/subjects"),
        (Method::PUT, "/api/public/pages"),
        (Method::PATCH, "/api/public/pages"),
        (
            Method::POST,
            "/api/public/pages/00000000-0000-0000-0000-000000000000",
        ),
    ];

    for (method, path) in method_probes {
        let (status, content_type, body) = harness.get_raw_uri(method.clone(), path).await;
        // In axum with .fallback(), unmatched method/path falls back to 404 NOT_FOUND (or 405)
        assert!(
            status == StatusCode::NOT_FOUND || status == StatusCode::METHOD_NOT_ALLOWED,
            "Method {method} on '{path}' returned unexpected status {status}"
        );
        let ct_str = content_type.unwrap_or_default();
        if status == StatusCode::NOT_FOUND {
            assert!(
                ct_str.contains("application/json"),
                "Method {method} on '{path}' did not return application/json: '{ct_str}'"
            );
            assert_eq!(body["error"]["code"].as_str().unwrap(), "NOT_FOUND");
        }
    }
}

// ============================================================================
// CHALLENGE TEST 5: SQL Search Adversarial Wildcards & Injection
// ============================================================================
#[tokio::test]
async fn test_sql_search_adversarial_wildcards_and_injection() {
    let harness = ChallengerHarness::new_in_memory().await;

    let sub = harness.create_subject("Computer Science", 1).await;

    // Seed 1: Literal '%' character in title and body
    let (p1, r1) = harness
        .create_draft_page(
            &sub,
            "100% Efficiency In Rust Systems",
            "Achieved 50% speedup and 0% memory regression in high-load tests.",
        )
        .await;
    let (s, _) = harness.publish_page(&p1, r1, &[]).await;
    assert_eq!(s, StatusCode::OK);

    // Seed 2: Literal '_' character and '\' in title and body
    let (p2, r2) = harness
        .create_draft_page(
            &sub,
            "Internal_Handler_Specification",
            "The handler uses __internal_dispatch with path C:\\System\\Logs and _temp_buffer.",
        )
        .await;
    let (s, _) = harness.publish_page(&p2, r2, &[]).await;
    assert_eq!(s, StatusCode::OK);

    // Seed 3: Normal text without '%' or '_' or '\'
    let (p3, r3) = harness
        .create_draft_page(
            &sub,
            "General Algorithms Overview",
            "Sorting algorithms like QuickSort and Binary Search trees.",
        )
        .await;
    let (s, _) = harness.publish_page(&p3, r3, &[]).await;
    assert_eq!(s, StatusCode::OK);

    // Seed 4: Cyrillic and unicode symbols
    let (p4, r4) = harness
        .create_draft_page(
            &sub,
            "Лабораторная работа: Квантовая физика",
            "Изучение уравнения Шрёдингера для атома водорода. Эксперимент с фотонами и электронами.",
        )
        .await;
    let (s, _) = harness.publish_page(&p4, r4, &[]).await;
    assert_eq!(s, StatusCode::OK);

    // 1. Literal '%' wildcard escape testing
    // Search for '%': MUST match Page 1 ONLY, NOT Page 2, 3, or 4!
    let (s, res) = harness.get_public_pages("q=%25").await;
    assert_eq!(s, StatusCode::OK);
    let list: PublicPageListResponse = serde_json::from_value(res).unwrap();
    assert_eq!(list.total, 1, "LIKE '%' must match literal '%' only!");
    assert_eq!(list.items[0].id, p1);

    // Search for '50%': matches Page 1
    let (s, res) = harness.get_public_pages("q=50%25").await;
    assert_eq!(s, StatusCode::OK);
    let list: PublicPageListResponse = serde_json::from_value(res).unwrap();
    assert_eq!(list.total, 1);
    assert_eq!(list.items[0].id, p1);

    // Search for '100%': matches Page 1
    let (s, res) = harness.get_public_pages("q=100%25").await;
    assert_eq!(s, StatusCode::OK);
    let list: PublicPageListResponse = serde_json::from_value(res).unwrap();
    assert_eq!(list.total, 1);
    assert_eq!(list.items[0].id, p1);

    // 2. Literal '_' wildcard escape testing
    // Search for '_': MUST match Page 2 ONLY, NOT Page 1, 3, or 4!
    let (s, res) = harness.get_public_pages("q=_").await;
    assert_eq!(s, StatusCode::OK);
    let list: PublicPageListResponse = serde_json::from_value(res).unwrap();
    assert_eq!(list.total, 1, "LIKE '_' must match literal '_' only!");
    assert_eq!(list.items[0].id, p2);

    // Search for '__internal': matches Page 2
    let (s, res) = harness.get_public_pages("q=__internal").await;
    assert_eq!(s, StatusCode::OK);
    let list: PublicPageListResponse = serde_json::from_value(res).unwrap();
    assert_eq!(list.total, 1);
    assert_eq!(list.items[0].id, p2);

    // 3. Literal '\\' escape testing
    let (s, res) = harness.get_public_pages("q=%5C").await;
    assert_eq!(s, StatusCode::OK);
    let list: PublicPageListResponse = serde_json::from_value(res).unwrap();
    assert_eq!(list.total, 1);
    assert_eq!(list.items[0].id, p2);

    // 4. SQL Injection payload vectors
    let injection_payloads = [
        "' OR '1'='1",
        "\" OR \"1\"=\"1",
        "'; DROP TABLE publications; --",
        "'; DELETE FROM subjects; --",
        "1' UNION SELECT id, draft_subject_id, draft_title, draft_markdown, revision, created_at FROM pages --",
        "admin'--",
        "/**/OR/**/1=1",
        "' OR 1=1 OR ''='",
    ];

    for inj in &injection_payloads {
        let encoded = percent_encode(inj);
        let (s, res) = harness.get_public_pages(&format!("q={encoded}")).await;
        assert_eq!(s, StatusCode::OK, "SQL injection query crashed: {inj}");
        let list: PublicPageListResponse = serde_json::from_value(res).unwrap();
        assert_eq!(
            list.total, 0,
            "SQL injection payload '{inj}' returned results!"
        );
        assert!(list.items.is_empty());
    }

    // Verify database tables are completely intact after DROP/DELETE attempts
    let (s, res) = harness.get_public_pages("").await;
    assert_eq!(s, StatusCode::OK);
    let list: PublicPageListResponse = serde_json::from_value(res).unwrap();
    assert_eq!(
        list.total, 4,
        "Publications table was modified or dropped by injection!"
    );

    // 5. Malformed subject_id SQL injection attempts
    let bad_subject_ids = [
        "' OR 1=1 --",
        "00000000-0000-0000-0000-000000000000' OR '1'='1",
        "non-uuid-string",
    ];
    for bad_id in &bad_subject_ids {
        let encoded = percent_encode(bad_id);
        let (s, res) = harness
            .get_public_pages(&format!("subject_id={encoded}"))
            .await;
        assert_eq!(
            s,
            StatusCode::BAD_REQUEST,
            "Malformed subject_id '{bad_id}' was not rejected with 400!"
        );
        assert_eq!(res["error"]["code"].as_str().unwrap(), "VALIDATION_ERROR");
    }

    // 6. Cyrillic and Multibyte Search Precision
    // Note: Due to SQLite's built-in lower() being ASCII-only, Cyrillic uppercase letters
    // in database columns are not lowered by SQLite, while Rust's .to_lowercase() lowers the pattern.
    // Testing lowercase Cyrillic in body: "водорода"
    let q_v = percent_encode("водорода");
    let (s, res) = harness.get_public_pages(&format!("q={q_v}")).await;
    assert_eq!(s, StatusCode::OK);
    let list: PublicPageListResponse = serde_json::from_value(res).unwrap();
    assert_eq!(list.total, 1, "Lowercase Cyrillic 'водорода' must match");
    assert_eq!(list.items[0].id, p4);

    // Uppercase query for lowercase text in body: "ВОДОРОДА" -> Rust lowers to "водорода", matching DB
    let q_v_upper = percent_encode("ВОДОРОДА");
    let (s, res) = harness.get_public_pages(&format!("q={q_v_upper}")).await;
    assert_eq!(s, StatusCode::OK);
    let list: PublicPageListResponse = serde_json::from_value(res).unwrap();
    assert_eq!(
        list.total, 1,
        "Uppercase query 'ВОДОРОДА' must match lowercase DB text"
    );
    assert_eq!(list.items[0].id, p4);

    // 7. Ultra-long search string (buffer / regex DOS prevention)
    let giant_query = "A".repeat(5000);
    let (s, res) = harness.get_public_pages(&format!("q={giant_query}")).await;
    assert_eq!(s, StatusCode::OK);
    let list: PublicPageListResponse = serde_json::from_value(res).unwrap();
    assert_eq!(list.total, 0);

    // 8. Empty / whitespace search query
    let (s, res) = harness.get_public_pages("q=%20%20%20").await;
    assert_eq!(s, StatusCode::OK);
    let list: PublicPageListResponse = serde_json::from_value(res).unwrap();
    assert_eq!(
        list.total, 4,
        "Whitespace query must return all publications"
    );
}

// ============================================================================
// CHALLENGE TEST 6: Dynamic Subject Page Count & Ordering Stress
// ============================================================================
#[tokio::test]
async fn test_public_subjects_dynamic_transition_and_ordering_stress() {
    let harness = ChallengerHarness::new_in_memory().await;

    // Create 4 subjects with distinct positions and names
    let sub_z = harness.create_subject("Zeta Subject", 30).await;
    let sub_m = harness.create_subject("Middle Subject B", 20).await;
    let sub_a = harness.create_subject("Middle Subject A", 20).await;
    let sub_f = harness.create_subject("First Subject", 10).await;

    // Sub F: draft only (never published)
    let (p_f, rev_f) = harness
        .create_draft_page(&sub_f, "Draft F", "Unpublished content.")
        .await;

    // Initial check: 0 published pages -> subjects list MUST be empty
    let (s, res) = harness.get_public_subjects().await;
    assert_eq!(s, StatusCode::OK);
    let subjs: Vec<PublicSubjectItem> = serde_json::from_value(res).unwrap();
    assert!(
        subjs.is_empty(),
        "No subjects should be returned when total publications == 0"
    );

    // Publish 1 page in Sub M
    let (p_m1, r_m1) = harness
        .create_draft_page(&sub_m, "Page M1", "Content M1")
        .await;
    let (s, _) = harness.publish_page(&p_m1, r_m1, &[]).await;
    assert_eq!(s, StatusCode::OK);

    // Publish 2 pages in Sub A
    let (p_a1, r_a1) = harness
        .create_draft_page(&sub_a, "Page A1", "Content A1")
        .await;
    let (s, _) = harness.publish_page(&p_a1, r_a1, &[]).await;
    assert_eq!(s, StatusCode::OK);

    let (p_a2, r_a2) = harness
        .create_draft_page(&sub_a, "Page A2", "Content A2")
        .await;
    let (s, _) = harness.publish_page(&p_a2, r_a2, &[]).await;
    assert_eq!(s, StatusCode::OK);

    // Publish 3 pages in Sub Z
    let (p_z1, r_z1) = harness
        .create_draft_page(&sub_z, "Page Z1", "Content Z1")
        .await;
    let (s, _) = harness.publish_page(&p_z1, r_z1, &[]).await;
    assert_eq!(s, StatusCode::OK);

    let (p_z2, r_z2) = harness
        .create_draft_page(&sub_z, "Page Z2", "Content Z2")
        .await;
    let (s, _) = harness.publish_page(&p_z2, r_z2, &[]).await;
    assert_eq!(s, StatusCode::OK);

    let (p_z3, r_z3) = harness
        .create_draft_page(&sub_z, "Page Z3", "Content Z3")
        .await;
    let (s, _) = harness.publish_page(&p_z3, r_z3, &[]).await;
    assert_eq!(s, StatusCode::OK);

    // Verify ordering and counts:
    // Sub F is excluded (0 published pages).
    // Position 20 tie: "Middle Subject A" comes before "Middle Subject B" (name ASC).
    // Position 30: "Zeta Subject" comes last.
    let (s, res) = harness.get_public_subjects().await;
    assert_eq!(s, StatusCode::OK);
    let subjs: Vec<PublicSubjectItem> = serde_json::from_value(res).unwrap();
    assert_eq!(subjs.len(), 3);

    assert_eq!(subjs[0].id, sub_a);
    assert_eq!(subjs[0].name, "Middle Subject A");
    assert_eq!(subjs[0].position, 20);
    assert_eq!(subjs[0].page_count, 2);

    assert_eq!(subjs[1].id, sub_m);
    assert_eq!(subjs[1].name, "Middle Subject B");
    assert_eq!(subjs[1].position, 20);
    assert_eq!(subjs[1].page_count, 1);

    assert_eq!(subjs[2].id, sub_z);
    assert_eq!(subjs[2].name, "Zeta Subject");
    assert_eq!(subjs[2].position, 30);
    assert_eq!(subjs[2].page_count, 3);

    // Unpublish Page M1 -> Sub M count becomes 0 -> Sub M must disappear immediately
    let (s, _) = harness.unpublish_page(&p_m1).await;
    assert_eq!(s, StatusCode::OK);

    let (s, res) = harness.get_public_subjects().await;
    assert_eq!(s, StatusCode::OK);
    let subjs: Vec<PublicSubjectItem> = serde_json::from_value(res).unwrap();
    assert_eq!(subjs.len(), 2);
    assert_eq!(subjs[0].id, sub_a);
    assert_eq!(subjs[1].id, sub_z);

    // Now publish Page F under Sub F (position 10)
    let (s, _) = harness.publish_page(&p_f, rev_f, &[]).await;
    assert_eq!(s, StatusCode::OK);

    // Sub F must now appear first in the list (position 10 < 20 < 30)
    let (s, res) = harness.get_public_subjects().await;
    assert_eq!(s, StatusCode::OK);
    let subjs: Vec<PublicSubjectItem> = serde_json::from_value(res).unwrap();
    assert_eq!(subjs.len(), 3);
    assert_eq!(subjs[0].id, sub_f);
    assert_eq!(subjs[0].position, 10);
    assert_eq!(subjs[0].page_count, 1);
    assert_eq!(subjs[1].id, sub_a);
    assert_eq!(subjs[2].id, sub_z);
}

// ============================================================================
// CHALLENGE TEST 7: Disk-backed SQLite WAL Concurrency Stress (Multi-Connection)
// ============================================================================
#[tokio::test]
async fn test_disk_wal_multi_connection_concurrency_stress() {
    let harness = ChallengerHarness::new_disk_wal().await;

    let sub1 = harness.create_subject("WAL Disk Subject 1", 10).await;
    let sub2 = harness.create_subject("WAL Disk Subject 2", 20).await;

    // Seed 4 published pages
    let (p1, r1) = harness
        .create_draft_page(&sub1, "WAL Page 1", "WAL content body 1")
        .await;
    let (p2, r2) = harness
        .create_draft_page(&sub1, "WAL Page 2", "WAL content body 2")
        .await;
    let (p3, r3) = harness
        .create_draft_page(&sub2, "WAL Page 3", "WAL content body 3")
        .await;
    let (p4, r4) = harness
        .create_draft_page(&sub2, "WAL Page 4", "WAL content body 4")
        .await;

    harness.publish_page(&p1, r1, &[]).await;
    harness.publish_page(&p2, r2, &[]).await;
    harness.publish_page(&p3, r3, &[]).await;
    harness.publish_page(&p4, r4, &[]).await;

    // Mutate drafts to secret tokens
    let _p1_r = harness
        .update_draft(
            &p1,
            r1,
            Some("DISK_SECRET_DRAFT_P1"),
            Some("DISK_SECRET_BODY_P1"),
            None,
        )
        .await;

    let stop_signal = Arc::new(AtomicBool::new(false));
    let success_reads = Arc::new(AtomicUsize::new(0));

    // Spawn 6 concurrent reader tasks across disk-backed WAL database
    let mut tasks = Vec::new();

    for reader_id in 0..6 {
        let h = harness.clone();
        let stop = stop_signal.clone();
        let count = success_reads.clone();
        let p_list = [p1.clone(), p2.clone(), p3.clone(), p4.clone()];

        tasks.push(tokio::spawn(async move {
            let mut iter = 0;
            while !stop.load(Ordering::Relaxed) {
                match iter % 3 {
                    0 => {
                        let (s, res) = h.get_public_pages("").await;
                        assert_eq!(s, StatusCode::OK);
                        let total = res["total"].as_i64().unwrap();
                        let items = res["items"].as_array().unwrap();
                        assert_eq!(
                            items.len() as i64,
                            total,
                            "Disk WAL read transaction snapshot isolation violated! items={}, total={}",
                            items.len(),
                            total
                        );
                        let text = res.to_string();
                        assert!(
                            !text.contains("DISK_SECRET"),
                            "DISK WAL LEAK IN CATALOG: {text}"
                        );
                    }
                    1 => {
                        let target = &p_list[(reader_id + iter) % p_list.len()];
                        let (s, res) = h.get_public_page(target).await;
                        if s == StatusCode::OK {
                            let text = res.to_string();
                            assert!(
                                !text.contains("DISK_SECRET"),
                                "DISK WAL LEAK IN DETAIL: {text}"
                            );
                        } else {
                            assert_eq!(s, StatusCode::NOT_FOUND);
                        }
                    }
                    _ => {
                        let (s, res) = h.get_public_subjects().await;
                        assert_eq!(s, StatusCode::OK);
                        assert!(res.is_array());
                    }
                }
                count.fetch_add(1, Ordering::Relaxed);
                iter += 1;
                tokio::task::yield_now().await;
            }
        }));
    }

    // Run writer toggling publications on P2 (toggle page)
    let h_w = harness.clone();
    for _ in 0..10 {
        h_w.unpublish_page(&p2).await;
        tokio::time::sleep(Duration::from_millis(10)).await;
        h_w.publish_page(&p2, r2, &[]).await;
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    stop_signal.store(true, Ordering::Relaxed);
    for t in tasks {
        t.await.unwrap();
    }

    let reads = success_reads.load(Ordering::Relaxed);
    assert!(
        reads >= 30,
        "Expected at least 30 disk WAL reads, got {reads}"
    );
}

// ============================================================================
// CHALLENGE TEST 8: Explicit Read Transaction Snapshot Isolation & Writer Contention
// ============================================================================
#[tokio::test]
async fn test_read_transaction_snapshot_isolation_and_writer_contention() {
    let harness = ChallengerHarness::new_disk_wal().await;

    let sub_a = harness.create_subject("Snapshot Subject A", 10).await;
    let sub_b = harness.create_subject("Snapshot Subject B", 20).await;

    // Seed 5 pages in Sub A and 5 in Sub B
    let mut pages_a = Vec::new();
    for i in 1..=5 {
        let (p, rev) = harness
            .create_draft_page(
                &sub_a,
                &format!("Page A {i}"),
                &format!("Content body A {i}"),
            )
            .await;
        let (s, _) = harness.publish_page(&p, rev, &[]).await;
        assert_eq!(s, StatusCode::OK);
        pages_a.push((p, rev));
    }

    let mut pages_b = Vec::new();
    for i in 1..=5 {
        let (p, rev) = harness
            .create_draft_page(
                &sub_b,
                &format!("Page B {i}"),
                &format!("Content body B {i}"),
            )
            .await;
        let (s, _) = harness.publish_page(&p, rev, &[]).await;
        assert_eq!(s, StatusCode::OK);
        pages_b.push((p, rev));
    }

    let stop_signal = Arc::new(AtomicBool::new(false));
    let read_counter = Arc::new(AtomicUsize::new(0));

    // Spawn 8 concurrent readers
    let mut reader_handles = Vec::new();
    for r_idx in 0..8 {
        let h = harness.clone();
        let stop = stop_signal.clone();
        let cnt = read_counter.clone();
        let s_a = sub_a.clone();
        let s_b = sub_b.clone();

        reader_handles.push(tokio::spawn(async move {
            let mut round = 0;
            while !stop.load(Ordering::Relaxed) {
                let query = match (r_idx + round) % 4 {
                    0 => String::new(),
                    1 => format!("subject_id={s_a}"),
                    2 => format!("subject_id={s_b}&q=Content"),
                    _ => "limit=5&offset=2".to_string(),
                };

                let (status, body) = h.get_public_pages(&query).await;
                assert_eq!(status, StatusCode::OK);

                let total = body["total"].as_i64().expect("total field");
                let items = body["items"].as_array().expect("items array");

                if query.contains("limit=5&offset=2") {
                    let expected_len = (total - 2).clamp(0, 5) as usize;
                    assert_eq!(
                        items.len(),
                        expected_len,
                        "Snapshot isolation failed for paginated query: total={total}, items={}",
                        items.len()
                    );
                } else {
                    let expected_len = total.min(20) as usize;
                    assert_eq!(
                        items.len(),
                        expected_len,
                        "Snapshot isolation failed for catalog query: total={total}, items={}",
                        items.len()
                    );
                }

                cnt.fetch_add(1, Ordering::Relaxed);
                round += 1;
                tokio::task::yield_now().await;
            }
        }));
    }

    // Writer 1: Toggles publication on pages_a[0] and pages_a[1]
    // Writer 2: Updates draft text and toggles publication on pages_b[0]
    let h1 = harness.clone();
    let p_a0 = pages_a[0].0.clone();
    let rev_a0 = pages_a[0].1;
    let p_a1 = pages_a[1].0.clone();
    let rev_a1 = pages_a[1].1;

    let h2 = harness.clone();
    let p_b0 = pages_b[0].0.clone();
    let mut rev_b0 = pages_b[0].1;

    let writer1 = tokio::spawn(async move {
        for _ in 0..12 {
            h1.unpublish_page(&p_a0).await;
            h1.unpublish_page(&p_a1).await;
            tokio::time::sleep(Duration::from_millis(5)).await;
            h1.publish_page(&p_a0, rev_a0, &[]).await;
            h1.publish_page(&p_a1, rev_a1, &[]).await;
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    });

    let writer2 = tokio::spawn(async move {
        for iter in 0..12 {
            rev_b0 = h2
                .update_draft(
                    &p_b0,
                    rev_b0,
                    Some(&format!("Page B 1 draft secret {iter}")),
                    Some(&format!("Confidential secret body {iter}")),
                    None,
                )
                .await;
            h2.unpublish_page(&p_b0).await;
            tokio::time::sleep(Duration::from_millis(5)).await;
            h2.publish_page(&p_b0, rev_b0, &[]).await;
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    });

    writer1.await.unwrap();
    writer2.await.unwrap();

    stop_signal.store(true, Ordering::Relaxed);
    for handle in reader_handles {
        handle.await.unwrap();
    }

    let total_reads = read_counter.load(Ordering::Relaxed);
    assert!(
        total_reads >= 50,
        "Expected at least 50 reads, got {total_reads}"
    );
}
