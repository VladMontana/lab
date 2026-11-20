//! Challenger 1 Concurrency, Revision Race & Rate Limiting Stress Tests
//!
//! Validates under high concurrency:
//! 1. Concurrent draft updates with same expected_revision (strictly 1 winner, others 409 REVISION_CONFLICT).
//! 2. Sequential revision increments (N -> N+1 -> N+2 -> ...).
//! 3. Optimistic concurrency CAS retry loop with zero lost updates.
//! 4. Subject deletion vs concurrent page creation/publication (strictly preserves 409 SUBJECT_NOT_EMPTY).
//! 5. Burst login rate limiting (5 failures per IP -> 429 RATE_LIMIT_EXCEEDED with Retry-After; IP isolation).
//! 6. Dual-state publication race condition stress.
//! 7. Multi-connection SQLite WAL concurrency stress on disk-backed database.

use axum::{
    body::Body,
    http::{header, Request, StatusCode},
};
use backend::{
    config::Config,
    db::{init_db, init_test_db, DbPool},
    error::ErrorResponse,
    models::{AdminPageDetail, SubjectResponse, UpdatePageResponse},
    routes::create_router,
    AppState,
};
use http_body_util::BodyExt;
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use tempfile::TempDir;
use tower::ServiceExt;

/// Test fixture supporting both in-memory and disk-backed WAL SQLite instances.
struct ConcurrencyTestContext {
    pub app: axum::Router,
    pub db: DbPool,
    #[allow(dead_code)]
    pub config: Config,
    pub _temp_dir: TempDir,
}

impl ConcurrencyTestContext {
    /// In-memory test context with migrations applied.
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
            admin_password: Some("valid_admin_password_123".to_string()),
            session_secret: "test_session_secret_32_characters_long".to_string(),
            max_image_bytes: 10 * 1024 * 1024,
            max_attachment_bytes: 50 * 1024 * 1024,
            trusted_proxy_ips: Vec::new(),
        };
        config.ensure_directories().unwrap();

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

    /// Disk-backed WAL test context using 10 connections for realistic OS-level concurrency.
    pub async fn new_disk_wal() -> Self {
        let temp_dir = tempfile::tempdir().unwrap();
        let db_file = temp_dir.path().join("concurrency_wal.db");
        // Canonicalize or format sqlite path safely for Windows
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
            admin_password: Some("valid_admin_password_123".to_string()),
            session_secret: "test_session_secret_32_characters_long".to_string(),
            max_image_bytes: 10 * 1024 * 1024,
            max_attachment_bytes: 50 * 1024 * 1024,
            trusted_proxy_ips: Vec::new(),
        };
        config.ensure_directories().unwrap();

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

    /// Logs in as administrator and returns (session_cookie, csrf_token).
    pub async fn login_admin(&self) -> (String, String) {
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
            .expect("Expected Set-Cookie")
            .to_str()
            .unwrap()
            .to_string();
        let cookie_val = cookie_header.split(';').next().unwrap().to_string();

        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let csrf = body["csrf_token"].as_str().unwrap().to_string();

        (cookie_val, csrf)
    }

    /// Helper to create a subject.
    pub async fn create_subject(&self, name: &str, cookie: &str, csrf: &str) -> SubjectResponse {
        let payload = json!({ "name": name });
        let req = Request::builder()
            .method("POST")
            .uri("/api/admin/subjects")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::COOKIE, cookie)
            .header("x-csrf-token", csrf)
            .header(header::ORIGIN, "http://127.0.0.1:8080")
            .body(Body::from(serde_json::to_vec(&payload).unwrap()))
            .unwrap();

        let resp = self.app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).unwrap()
    }

    /// Helper to create a page draft.
    pub async fn create_page(
        &self,
        subject_id: &str,
        title: &str,
        cookie: &str,
        csrf: &str,
    ) -> AdminPageDetail {
        let payload = json!({
            "subject_id": subject_id,
            "title": title
        });
        let req = Request::builder()
            .method("POST")
            .uri("/api/admin/pages")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::COOKIE, cookie)
            .header("x-csrf-token", csrf)
            .header(header::ORIGIN, "http://127.0.0.1:8080")
            .body(Body::from(serde_json::to_vec(&payload).unwrap()))
            .unwrap();

        let resp = self.app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).unwrap()
    }

    /// Helper to fetch page draft details.
    pub async fn get_page(&self, page_id: &str, cookie: &str) -> AdminPageDetail {
        let req = Request::builder()
            .method("GET")
            .uri(format!("/api/admin/pages/{page_id}"))
            .header(header::COOKIE, cookie)
            .body(Body::empty())
            .unwrap();

        let resp = self.app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).unwrap()
    }
}

// ============================================================================
// 1. Concurrent Updates: Same Expected Revision Race
// ============================================================================

#[tokio::test]
async fn test_concurrent_updates_same_expected_revision_single_winner() {
    let ctx = Arc::new(ConcurrencyTestContext::new_in_memory().await);
    let (cookie, csrf) = ctx.login_admin().await;

    let subject = ctx
        .create_subject("Concurrency Physics", &cookie, &csrf)
        .await;
    let page = ctx
        .create_page(&subject.id, "Race Condition Lab", &cookie, &csrf)
        .await;
    assert_eq!(page.revision, 1);

    // Launch 20 concurrent tasks all attempting to update revision 1 with different content
    const CONCURRENT_WORKERS: usize = 20;
    let mut handles = Vec::with_capacity(CONCURRENT_WORKERS);

    for i in 0..CONCURRENT_WORKERS {
        let ctx = Arc::clone(&ctx);
        let page_id = page.id.clone();
        let cookie = cookie.clone();
        let csrf = csrf.clone();

        handles.push(tokio::spawn(async move {
            let payload = json!({
                "expected_revision": 1,
                "title": format!("Worker {i} Title"),
                "markdown": format!("Content submitted by worker {i}"),
            });

            let req = Request::builder()
                .method("PATCH")
                .uri(format!("/api/admin/pages/{page_id}"))
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::COOKIE, &cookie)
                .header("x-csrf-token", &csrf)
                .header(header::ORIGIN, "http://127.0.0.1:8080")
                .body(Body::from(serde_json::to_vec(&payload).unwrap()))
                .unwrap();

            let resp = ctx.app.clone().oneshot(req).await.unwrap();
            let status = resp.status();
            let bytes = resp.into_body().collect().await.unwrap().to_bytes();
            (i, status, bytes)
        }));
    }

    let mut successes = 0;
    let mut conflicts = 0;
    let mut winning_worker = None;

    for handle in handles {
        let (worker_id, status, bytes) = handle.await.unwrap();
        match status {
            StatusCode::OK => {
                successes += 1;
                winning_worker = Some(worker_id);
                let update_resp: UpdatePageResponse = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(update_resp.revision, 2);
                assert_eq!(update_resp.id, page.id);
            }
            StatusCode::CONFLICT => {
                conflicts += 1;
                let err: ErrorResponse = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(err.error.code, "REVISION_CONFLICT");
                assert!(
                    err.error.message.contains("expected revision 1"),
                    "Error message should mention expected revision 1: {}",
                    err.error.message
                );
            }
            other => {
                panic!("Worker {worker_id} got unexpected status code: {other}");
            }
        }
    }

    // STRICT INVARIANT: Exactly 1 winner, exactly N-1 conflicts, 0 unexpected errors
    assert_eq!(
        successes, 1,
        "Exactly ONE concurrent update must succeed for the same expected_revision"
    );
    assert_eq!(
        conflicts,
        CONCURRENT_WORKERS - 1,
        "All other concurrent updates must receive 409 REVISION_CONFLICT"
    );

    // Verify final state matches the winning worker's content and has revision = 2
    let winner_id = winning_worker.expect("Must have a winner");
    let final_page = ctx.get_page(&page.id, &cookie).await;
    assert_eq!(final_page.revision, 2);
    assert_eq!(final_page.draft_title, format!("Worker {winner_id} Title"));
    assert_eq!(
        final_page.draft_markdown,
        format!("Content submitted by worker {winner_id}")
    );
}

// ============================================================================
// 2. Sequential Revision Increments (N -> N+1 -> N+2 -> ...)
// ============================================================================

#[tokio::test]
async fn test_sequential_revision_increment_integrity() {
    let ctx = ConcurrencyTestContext::new_in_memory().await;
    let (cookie, csrf) = ctx.login_admin().await;

    let subject = ctx.create_subject("Sequential Math", &cookie, &csrf).await;
    let page = ctx
        .create_page(&subject.id, "Step 0 Title", &cookie, &csrf)
        .await;
    assert_eq!(page.revision, 1);

    const STEPS: i64 = 25;

    for rev in 1..=STEPS {
        let payload = json!({
            "expected_revision": rev,
            "title": format!("Step {rev} Title"),
            "markdown": format!("Step {rev} Content"),
        });

        let req = Request::builder()
            .method("PATCH")
            .uri(format!("/api/admin/pages/{}", page.id))
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::COOKIE, &cookie)
            .header("x-csrf-token", &csrf)
            .header(header::ORIGIN, "http://127.0.0.1:8080")
            .body(Body::from(serde_json::to_vec(&payload).unwrap()))
            .unwrap();

        let resp = ctx.app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let update_resp: UpdatePageResponse = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            update_resp.revision,
            rev + 1,
            "Revision should sequentially increment to N+1"
        );

        // Periodically verify that obsolete or premature revisions are strictly rejected
        if rev % 5 == 0 {
            // Obsolete revision check (rev - 1)
            let stale_payload = json!({
                "expected_revision": rev - 1,
                "title": "Stale Attempt"
            });
            let stale_req = Request::builder()
                .method("PATCH")
                .uri(format!("/api/admin/pages/{}", page.id))
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::COOKIE, &cookie)
                .header("x-csrf-token", &csrf)
                .header(header::ORIGIN, "http://127.0.0.1:8080")
                .body(Body::from(serde_json::to_vec(&stale_payload).unwrap()))
                .unwrap();
            let stale_resp = ctx.app.clone().oneshot(stale_req).await.unwrap();
            assert_eq!(stale_resp.status(), StatusCode::CONFLICT);
            let err: ErrorResponse =
                serde_json::from_slice(&stale_resp.into_body().collect().await.unwrap().to_bytes())
                    .unwrap();
            assert_eq!(err.error.code, "REVISION_CONFLICT");

            // Premature revision check (rev + 100)
            let future_payload = json!({
                "expected_revision": rev + 100,
                "title": "Future Attempt"
            });
            let future_req = Request::builder()
                .method("PATCH")
                .uri(format!("/api/admin/pages/{}", page.id))
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::COOKIE, &cookie)
                .header("x-csrf-token", &csrf)
                .header(header::ORIGIN, "http://127.0.0.1:8080")
                .body(Body::from(serde_json::to_vec(&future_payload).unwrap()))
                .unwrap();
            let future_resp = ctx.app.clone().oneshot(future_req).await.unwrap();
            assert_eq!(future_resp.status(), StatusCode::CONFLICT);
        }
    }

    // Final check
    let final_page = ctx.get_page(&page.id, &cookie).await;
    assert_eq!(final_page.revision, STEPS + 1);
    assert_eq!(final_page.draft_title, format!("Step {STEPS} Title"));
    assert_eq!(final_page.draft_markdown, format!("Step {STEPS} Content"));
}

// ============================================================================
// 3. Concurrent CAS Retry Loop (Collaborative Editing with Zero Lost Updates)
// ============================================================================

#[tokio::test]
async fn test_concurrent_optimistic_retry_loop_no_lost_updates() {
    let ctx = Arc::new(ConcurrencyTestContext::new_in_memory().await);
    let (cookie, csrf) = ctx.login_admin().await;

    let subject = ctx.create_subject("Collab Chemistry", &cookie, &csrf).await;
    let page = ctx
        .create_page(&subject.id, "Collab Lab Report", &cookie, &csrf)
        .await;
    assert_eq!(page.revision, 1);

    const WORKERS: usize = 10;
    let mut handles = Vec::with_capacity(WORKERS);

    for worker_id in 0..WORKERS {
        let ctx = Arc::clone(&ctx);
        let page_id = page.id.clone();
        let cookie = cookie.clone();
        let csrf = csrf.clone();

        handles.push(tokio::spawn(async move {
            let mut attempts = 0;
            loop {
                attempts += 1;
                // 1. Fetch current draft state and revision
                let current_page = ctx.get_page(&page_id, &cookie).await;
                let current_rev = current_page.revision;
                let mut lines: Vec<String> = current_page
                    .draft_markdown
                    .lines()
                    .map(str::to_string)
                    .collect();

                let worker_tag = format!("WORKER_{worker_id}_PAYLOAD");
                if lines.contains(&worker_tag) {
                    // Already applied
                    return attempts;
                }
                lines.push(worker_tag);
                let updated_markdown = lines.join("\n");

                // 2. Attempt conditional update with expected_revision = current_rev
                let payload = json!({
                    "expected_revision": current_rev,
                    "markdown": updated_markdown
                });

                let req = Request::builder()
                    .method("PATCH")
                    .uri(format!("/api/admin/pages/{page_id}"))
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(header::COOKIE, &cookie)
                    .header("x-csrf-token", &csrf)
                    .header(header::ORIGIN, "http://127.0.0.1:8080")
                    .body(Body::from(serde_json::to_vec(&payload).unwrap()))
                    .unwrap();

                let resp = ctx.app.clone().oneshot(req).await.unwrap();
                if resp.status() == StatusCode::OK {
                    return attempts;
                } else if resp.status() == StatusCode::CONFLICT {
                    // Back off briefly and retry
                    tokio::time::sleep(Duration::from_millis(5 + (worker_id as u64 % 3) * 5)).await;
                    continue;
                } else {
                    panic!(
                        "Worker {worker_id} received unexpected status: {}",
                        resp.status()
                    );
                }
            }
        }));
    }

    let mut total_attempts = 0;
    for handle in handles {
        let attempts = handle.await.unwrap();
        total_attempts += attempts;
    }
    tracing::info!("Completed all {WORKERS} CAS workers with {total_attempts} total attempts");

    // Verify final state: exactly WORKERS updates applied
    let final_page = ctx.get_page(&page.id, &cookie).await;
    assert_eq!(
        final_page.revision,
        1 + WORKERS as i64,
        "Revision should equal 1 + number of workers"
    );

    // Verify all workers' contributions are present (no lost updates)
    for worker_id in 0..WORKERS {
        let expected_tag = format!("WORKER_{worker_id}_PAYLOAD");
        assert!(
            final_page.draft_markdown.contains(&expected_tag),
            "Final markdown must contain contribution from worker {worker_id}"
        );
    }
}

// ============================================================================
// 4. Subject Deletion vs Concurrent Page Operations (Preserves 409)
// ============================================================================

#[tokio::test]
async fn test_concurrent_page_creation_during_subject_deletion() {
    let ctx = Arc::new(ConcurrencyTestContext::new_in_memory().await);
    let (cookie, csrf) = ctx.login_admin().await;

    let subject = ctx.create_subject("Volatile Subject", &cookie, &csrf).await;

    const WORKERS: usize = 12;
    let mut handles = Vec::new();

    // Spawn workers attempting to delete the subject
    for _ in 0..WORKERS / 2 {
        let ctx = Arc::clone(&ctx);
        let subject_id = subject.id.clone();
        let cookie = cookie.clone();
        let csrf = csrf.clone();

        handles.push(tokio::spawn(async move {
            let req = Request::builder()
                .method("DELETE")
                .uri(format!("/api/admin/subjects/{subject_id}"))
                .header(header::COOKIE, &cookie)
                .header("x-csrf-token", &csrf)
                .header(header::ORIGIN, "http://127.0.0.1:8080")
                .body(Body::empty())
                .unwrap();

            let resp = ctx.app.clone().oneshot(req).await.unwrap();
            ("delete", resp.status())
        }));
    }

    // Spawn workers attempting to create pages inside the subject
    for i in 0..WORKERS / 2 {
        let ctx = Arc::clone(&ctx);
        let subject_id = subject.id.clone();
        let cookie = cookie.clone();
        let csrf = csrf.clone();

        handles.push(tokio::spawn(async move {
            let payload = json!({
                "subject_id": subject_id,
                "title": format!("Concurrent Page {i}")
            });
            let req = Request::builder()
                .method("POST")
                .uri("/api/admin/pages")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::COOKIE, &cookie)
                .header("x-csrf-token", &csrf)
                .header(header::ORIGIN, "http://127.0.0.1:8080")
                .body(Body::from(serde_json::to_vec(&payload).unwrap()))
                .unwrap();

            let resp = ctx.app.clone().oneshot(req).await.unwrap();
            ("create_page", resp.status())
        }));
    }

    let mut delete_statuses = Vec::new();
    let mut create_statuses = Vec::new();

    for handle in handles {
        let (op, status) = handle.await.unwrap();
        if op == "delete" {
            delete_statuses.push(status);
        } else {
            create_statuses.push(status);
        }
    }

    // Strict Database Foreign-Key / Orphan Invariant:
    // No page can exist without a valid subject!
    let orphaned_count: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM pages WHERE draft_subject_id NOT IN (SELECT id FROM subjects)",
    )
    .fetch_one(&ctx.db)
    .await
    .unwrap();
    assert_eq!(
        orphaned_count.0, 0,
        "Orphaned pages must NEVER exist in database"
    );

    // If any page creation succeeded, verify that subject still exists and deletion fails with 409
    let page_count: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM pages WHERE draft_subject_id = ?")
            .bind(&subject.id)
            .fetch_one(&ctx.db)
            .await
            .unwrap();

    if page_count.0 > 0 {
        // Subsequent delete MUST fail with 409 SUBJECT_NOT_EMPTY
        let req = Request::builder()
            .method("DELETE")
            .uri(format!("/api/admin/subjects/{}", subject.id))
            .header(header::COOKIE, &cookie)
            .header("x-csrf-token", &csrf)
            .header(header::ORIGIN, "http://127.0.0.1:8080")
            .body(Body::empty())
            .unwrap();

        let resp = ctx.app.clone().oneshot(req).await.unwrap();
        assert_eq!(
            resp.status(),
            StatusCode::CONFLICT,
            "Deleting subject with pages MUST yield 409 Conflict"
        );
        let err: ErrorResponse =
            serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(err.error.code, "SUBJECT_NOT_EMPTY");
    }
}

// ============================================================================
// 5. Burst Login Rate Limiting & IP Isolation Under Concurrency
// ============================================================================

#[tokio::test]
async fn test_login_rate_limiting_concurrency_burst_and_ip_isolation() {
    let ctx = Arc::new(ConcurrencyTestContext::new_in_memory().await);

    let target_ip = "198.51.100.42";
    let independent_ip = "203.0.113.99";

    // Step 1: Burst 5 sequential/rapid bad login attempts for target_ip
    for attempt in 1..=5 {
        let payload = json!({
            "username": "admin",
            "password": format!("wrong_password_{attempt}")
        });

        let req = Request::builder()
            .method("POST")
            .uri("/api/admin/login")
            .header(header::CONTENT_TYPE, "application/json")
            .header("x-forwarded-for", target_ip)
            .body(Body::from(serde_json::to_vec(&payload).unwrap()))
            .unwrap();

        let resp = ctx.app.clone().oneshot(req).await.unwrap();
        assert_eq!(
            resp.status(),
            StatusCode::UNAUTHORIZED,
            "Attempts 1..5 must return 401 Unauthorized"
        );
        let err: ErrorResponse =
            serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(err.error.code, "INVALID_CREDENTIALS");
    }

    // Step 2: Concurrently burst 10 requests from target_ip
    // All 10 MUST receive 429 RATE_LIMIT_EXCEEDED with Retry-After header
    let mut handles = Vec::new();
    for i in 0..10 {
        let ctx = Arc::clone(&ctx);
        handles.push(tokio::spawn(async move {
            let payload = json!({
                "username": "admin",
                "password": format!("blocked_burst_pw_{i}")
            });

            let req = Request::builder()
                .method("POST")
                .uri("/api/admin/login")
                .header(header::CONTENT_TYPE, "application/json")
                .header("x-forwarded-for", target_ip)
                .body(Body::from(serde_json::to_vec(&payload).unwrap()))
                .unwrap();

            let resp = ctx.app.clone().oneshot(req).await.unwrap();
            let status = resp.status();
            let retry_after = resp
                .headers()
                .get(header::RETRY_AFTER)
                .map(|v| v.to_str().unwrap().to_string());
            let bytes = resp.into_body().collect().await.unwrap().to_bytes();
            (status, retry_after, bytes)
        }));
    }

    for handle in handles {
        let (status, retry_after, bytes) = handle.await.unwrap();
        assert_eq!(
            status,
            StatusCode::TOO_MANY_REQUESTS,
            "Requests exceeding 5 failures must strictly return 429"
        );
        let retry_val = retry_after.expect("429 response MUST include Retry-After header");
        let retry_secs: u64 = retry_val
            .parse()
            .expect("Retry-After must be integer seconds");
        assert!(
            retry_secs > 0 && retry_secs <= 900,
            "Retry-After must be between 1 and 900s: {retry_secs}"
        );

        let err: ErrorResponse = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(err.error.code, "RATE_LIMIT_EXCEEDED");
    }

    // Step 3: Verify that target_ip is locked out even when providing CORRECT password
    let valid_payload = json!({
        "username": "admin",
        "password": "valid_admin_password_123"
    });
    let locked_req = Request::builder()
        .method("POST")
        .uri("/api/admin/login")
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-forwarded-for", target_ip)
        .body(Body::from(serde_json::to_vec(&valid_payload).unwrap()))
        .unwrap();
    let locked_resp = ctx.app.clone().oneshot(locked_req).await.unwrap();
    assert_eq!(
        locked_resp.status(),
        StatusCode::TOO_MANY_REQUESTS,
        "Target IP must remain locked even with correct password until window expires"
    );

    // Step 4: Strict IP Isolation: Verify independent IP is completely UNBLOCKED
    // Can login successfully with valid password
    let indep_req = Request::builder()
        .method("POST")
        .uri("/api/admin/login")
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-forwarded-for", independent_ip)
        .body(Body::from(serde_json::to_vec(&valid_payload).unwrap()))
        .unwrap();
    let indep_resp = ctx.app.clone().oneshot(indep_req).await.unwrap();
    assert_eq!(
        indep_resp.status(),
        StatusCode::OK,
        "Independent IP must be unblocked and able to login"
    );
    assert!(
        indep_resp.headers().contains_key(header::SET_COOKIE),
        "Successful login must issue session cookie"
    );
}

// ============================================================================
// 6. Publish Race Condition & Dual-State Invariant Stress
// ============================================================================

#[tokio::test]
async fn test_publish_and_draft_update_race_condition() {
    let ctx = Arc::new(ConcurrencyTestContext::new_in_memory().await);
    let (cookie, csrf) = ctx.login_admin().await;

    let subject = ctx.create_subject("Race Subject", &cookie, &csrf).await;
    let page = ctx
        .create_page(&subject.id, "Initial Draft Title", &cookie, &csrf)
        .await;
    assert_eq!(page.revision, 1);

    // Concurrently trigger:
    // 1. Publish page with expected_revision = 1
    // 2. Update page draft with expected_revision = 1
    let ctx1 = Arc::clone(&ctx);
    let ctx2 = Arc::clone(&ctx);
    let page_id1 = page.id.clone();
    let page_id2 = page.id.clone();
    let cookie1 = cookie.clone();
    let cookie2 = cookie.clone();
    let csrf1 = csrf.clone();
    let csrf2 = csrf.clone();

    let publish_task = tokio::spawn(async move {
        let payload = json!({
            "expected_revision": 1,
            "attachment_ids": []
        });
        let req = Request::builder()
            .method("POST")
            .uri(format!("/api/admin/pages/{page_id1}/publish"))
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::COOKIE, &cookie1)
            .header("x-csrf-token", &csrf1)
            .header(header::ORIGIN, "http://127.0.0.1:8080")
            .body(Body::from(serde_json::to_vec(&payload).unwrap()))
            .unwrap();

        let resp = ctx1.app.clone().oneshot(req).await.unwrap();
        ("publish", resp.status())
    });

    let update_task = tokio::spawn(async move {
        let payload = json!({
            "expected_revision": 1,
            "title": "Edited While Publishing Title",
            "markdown": "Edited markdown body"
        });
        let req = Request::builder()
            .method("PATCH")
            .uri(format!("/api/admin/pages/{page_id2}"))
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::COOKIE, &cookie2)
            .header("x-csrf-token", &csrf2)
            .header(header::ORIGIN, "http://127.0.0.1:8080")
            .body(Body::from(serde_json::to_vec(&payload).unwrap()))
            .unwrap();

        let resp = ctx2.app.clone().oneshot(req).await.unwrap();
        ("update", resp.status())
    });

    let (op1, status1) = publish_task.await.unwrap();
    let (op2, status2) = update_task.await.unwrap();

    assert_eq!(op1, "publish");
    assert_eq!(op2, "update");

    // Both possible ordering outcomes must maintain data integrity:
    // Case A: Publish completed first (200 OK), then update completed (200 OK).
    //   - Publication table holds snapshot with revision 1
    //   - Pages draft table holds revision 2
    // Case B: Update completed first (200 OK, rev 2), then publish failed with 409 REVISION_CONFLICT.
    if status1 == StatusCode::OK && status2 == StatusCode::OK {
        // Dual-state verification: published snapshot must NOT leak draft edits!
        let pub_row: Option<(String, String, i64)> = sqlx::query_as(
            "SELECT title, markdown, published_revision FROM publications WHERE page_id = ?",
        )
        .bind(&page.id)
        .fetch_optional(&ctx.db)
        .await
        .unwrap();

        let (pub_title, _pub_md, pub_rev) = pub_row.expect("Publication must exist");
        assert_eq!(pub_rev, 1);
        assert_eq!(pub_title, "Initial Draft Title");

        let draft = ctx.get_page(&page.id, &cookie).await;
        assert_eq!(draft.revision, 2);
        assert_eq!(draft.draft_title, "Edited While Publishing Title");
        assert!(draft.is_published);
        assert_eq!(draft.published_revision, Some(1));
    } else if status1 == StatusCode::CONFLICT && status2 == StatusCode::OK {
        // Update won the race; publish was rejected due to revision conflict
        let draft = ctx.get_page(&page.id, &cookie).await;
        assert_eq!(draft.revision, 2);
        assert_eq!(draft.draft_title, "Edited While Publishing Title");
        assert!(!draft.is_published);
    } else {
        panic!("Unexpected race status combo: publish={status1}, update={status2}");
    }
}

// ============================================================================
// 7. Multi-Connection SQLite WAL Concurrency Stress (Disk-Backed)
// ============================================================================

#[tokio::test]
async fn test_multiconnection_wal_concurrency_stress() {
    let ctx = Arc::new(ConcurrencyTestContext::new_disk_wal().await);
    let (cookie, csrf) = ctx.login_admin().await;

    let subject = ctx.create_subject("WAL Subject", &cookie, &csrf).await;
    let page1 = ctx
        .create_page(&subject.id, "WAL Page 1", &cookie, &csrf)
        .await;
    let page2 = ctx
        .create_page(&subject.id, "WAL Page 2", &cookie, &csrf)
        .await;

    const WORKERS: usize = 20;
    let mut handles = Vec::with_capacity(WORKERS);

    // Concurrently execute mixed operations across 10-connection WAL pool
    for i in 0..WORKERS {
        let ctx = Arc::clone(&ctx);
        let cookie = cookie.clone();
        let csrf = csrf.clone();
        let p1_id = page1.id.clone();
        let p2_id = page2.id.clone();

        handles.push(tokio::spawn(async move {
            match i % 4 {
                0 => {
                    // Update page 1 with CAS loop
                    let mut retries = 0;
                    loop {
                        let cur = ctx.get_page(&p1_id, &cookie).await;
                        let payload = json!({
                            "expected_revision": cur.revision,
                            "markdown": format!("P1 Worker {i} line")
                        });
                        let req = Request::builder()
                            .method("PATCH")
                            .uri(format!("/api/admin/pages/{p1_id}"))
                            .header(header::CONTENT_TYPE, "application/json")
                            .header(header::COOKIE, &cookie)
                            .header("x-csrf-token", &csrf)
                            .header(header::ORIGIN, "http://127.0.0.1:8080")
                            .body(Body::from(serde_json::to_vec(&payload).unwrap()))
                            .unwrap();

                        let resp = ctx.app.clone().oneshot(req).await.unwrap();
                        if resp.status() == StatusCode::OK {
                            break;
                        }
                        retries += 1;
                        if retries > 50 {
                            panic!("Exceeded 50 retries on P1");
                        }
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                }
                1 => {
                    // Update page 2 with CAS loop
                    let mut retries = 0;
                    loop {
                        let cur = ctx.get_page(&p2_id, &cookie).await;
                        let payload = json!({
                            "expected_revision": cur.revision,
                            "markdown": format!("P2 Worker {i} line")
                        });
                        let req = Request::builder()
                            .method("PATCH")
                            .uri(format!("/api/admin/pages/{p2_id}"))
                            .header(header::CONTENT_TYPE, "application/json")
                            .header(header::COOKIE, &cookie)
                            .header("x-csrf-token", &csrf)
                            .header(header::ORIGIN, "http://127.0.0.1:8080")
                            .body(Body::from(serde_json::to_vec(&payload).unwrap()))
                            .unwrap();

                        let resp = ctx.app.clone().oneshot(req).await.unwrap();
                        if resp.status() == StatusCode::OK {
                            break;
                        }
                        retries += 1;
                        if retries > 50 {
                            panic!("Exceeded 50 retries on P2");
                        }
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                }
                2 => {
                    // Read list pages
                    let req = Request::builder()
                        .method("GET")
                        .uri("/api/admin/pages")
                        .header(header::COOKIE, &cookie)
                        .body(Body::empty())
                        .unwrap();
                    let resp = ctx.app.clone().oneshot(req).await.unwrap();
                    assert_eq!(resp.status(), StatusCode::OK);
                }
                _ => {
                    // Read /api/admin/me
                    let req = Request::builder()
                        .method("GET")
                        .uri("/api/admin/me")
                        .header(header::COOKIE, &cookie)
                        .body(Body::empty())
                        .unwrap();
                    let resp = ctx.app.clone().oneshot(req).await.unwrap();
                    assert_eq!(resp.status(), StatusCode::OK);
                }
            }
        }));
    }

    for handle in handles {
        handle.await.unwrap();
    }

    // Both pages must have incremented revisions without any database lock timeouts
    let p1_final = ctx.get_page(&page1.id, &cookie).await;
    let p2_final = ctx.get_page(&page2.id, &cookie).await;
    assert!(p1_final.revision > 1);
    assert!(p2_final.revision > 1);
}
