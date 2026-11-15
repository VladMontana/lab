//! Milestone 3 Integration Test Suite: Public Catalog, SQL Search & Read APIs
//!
//! Validates:
//! 1. Public Subjects: only subjects with published pages (`page_count > 0`), ordered by position ASC, name ASC.
//! 2. Public Catalog & Filter: subject_id filtering, pagination, total counts, default ordering.
//! 3. Pagination & Clamping: limit [1, 100], offset >= 0.
//! 4. SQL Search & Snippet: LIKE title/body search, case insensitivity, whitespace trimming,
//!    LIKE escaping (`%`, `_`), clean UTF-8 snippet stripping and query centering.
//! 5. Privacy Barrier & Draft Isolation: zero leakage of drafts, draft edits, or unpublished pages.
//! 6. Public Page Detail & Attachments: snapshot view, only kind='attachment' public assets included.
//! 7. Non-SPA 404 Fallback: unmatched `/api/*` and `/media/*` return JSON error envelope `{ "error": { "code": "NOT_FOUND", ... } }`.

use axum::{
    body::Body,
    http::{header, HeaderMap, Request, StatusCode},
};
use backend::{
    config::Config,
    db::{init_test_db, DbPool},
    models::{
        AssetResponse, PublicPageListResponse, PublicPageViewResponse, PublicSubjectItem,
        PublishPageResponse, SubjectResponse, UpdatePageResponse,
    },
    routes::create_router,
    AppState,
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
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

fn percent_encode(s: &str) -> String {
    let mut out = String::new();
    for &b in s.as_bytes() {
        match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => {
                out.push_str(&format!("%{:02X}", b));
            }
        }
    }
    out
}

struct M3TestHarness {
    pub app: axum::Router,
    #[allow(dead_code)]
    pub db: DbPool,
    pub cookie: String,
    pub csrf_token: String,
    pub _temp_dir: TempDir,
}

impl M3TestHarness {
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
        };
        config.ensure_directories().unwrap();

        // Bootstrap seed admin user
        backend::auth::bootstrap_admin(&db, &config.admin_username, "valid_admin_password_123")
            .await
            .unwrap();

        let state = AppState::new(db.clone(), config.clone());
        let app = create_router(state);

        // Pre-authenticate as admin to obtain cookie and CSRF token
        let login_payload = json!({
            "username": "admin",
            "password": "valid_admin_password_123"
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

        Self {
            app,
            db,
            cookie,
            csrf_token,
            _temp_dir: temp_dir,
        }
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
    ) -> i64 {
        let mut payload = serde_json::Map::new();
        payload.insert("expected_revision".to_string(), json!(expected_rev));
        if let Some(t) = title {
            payload.insert("title".to_string(), json!(t));
        }
        if let Some(m) = markdown {
            payload.insert("markdown".to_string(), json!(m));
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
    ) -> PublishPageResponse {
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
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).unwrap()
    }

    pub async fn unpublish_page(&self, page_id: &str) {
        let req = Request::builder()
            .method("DELETE")
            .uri(format!("/api/admin/pages/{page_id}/publication"))
            .header(header::COOKIE, &self.cookie)
            .header("X-CSRF-Token", &self.csrf_token)
            .body(Body::empty())
            .unwrap();
        let resp = self.app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
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

    pub async fn get_raw(&self, uri: &str) -> (StatusCode, HeaderMap, Value) {
        let req = Request::builder()
            .method("GET")
            .uri(uri)
            .body(Body::empty())
            .unwrap();
        let resp = self.app.clone().oneshot(req).await.unwrap();
        let status = resp.status();
        let headers = resp.headers().clone();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let val: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, headers, val)
    }
}

// ============================================================================
// MODULE 1: PUBLIC SUBJECTS TESTS
// ============================================================================

#[tokio::test]
async fn test_public_subjects_empty_database() {
    let harness = M3TestHarness::new().await;
    let (status, val) = harness.get_public_subjects().await;
    assert_eq!(status, StatusCode::OK);
    let subjects: Vec<PublicSubjectItem> = serde_json::from_value(val).unwrap();
    assert!(subjects.is_empty());
}

#[tokio::test]
async fn test_public_subjects_zero_published_pages_excluded() {
    let harness = M3TestHarness::new().await;

    // Create Subject 1 with 0 pages
    let _sub1_id = harness.create_subject("Empty Subject", 1).await;

    // Create Subject 2 with 2 draft pages, none published
    let sub2_id = harness.create_subject("Draft Only Subject", 2).await;
    let _d1 = harness
        .create_draft_page(&sub2_id, "Draft 1", "# Draft 1")
        .await;
    let _d2 = harness
        .create_draft_page(&sub2_id, "Draft 2", "# Draft 2")
        .await;

    // GET /api/public/subjects MUST return empty list []
    let (status, val) = harness.get_public_subjects().await;
    assert_eq!(status, StatusCode::OK);
    let subjects: Vec<PublicSubjectItem> = serde_json::from_value(val).unwrap();
    assert!(
        subjects.is_empty(),
        "Subjects with 0 published pages must never appear in public subjects"
    );
}

#[tokio::test]
async fn test_public_subjects_count_accuracy_and_ordering() {
    let harness = M3TestHarness::new().await;

    // Subject 1: position=2, name="Zeta Physics", 2 published pages + 1 draft page
    let sub1_id = harness.create_subject("Zeta Physics", 2).await;
    let (p1, r1) = harness
        .create_draft_page(&sub1_id, "Zeta 1", "# Zeta 1")
        .await;
    let (p2, r2) = harness
        .create_draft_page(&sub1_id, "Zeta 2", "# Zeta 2")
        .await;
    let (_p3, _r3) = harness
        .create_draft_page(&sub1_id, "Zeta Draft", "# Draft")
        .await;
    harness.publish_page(&p1, r1, &[]).await;
    harness.publish_page(&p2, r2, &[]).await;

    // Subject 2: position=1, name="Chemistry", 1 published page
    let sub2_id = harness.create_subject("Chemistry", 1).await;
    let (p4, r4) = harness
        .create_draft_page(&sub2_id, "Chem 1", "# Chem 1")
        .await;
    harness.publish_page(&p4, r4, &[]).await;

    // Subject 3: position=1, name="Biology", 3 published pages
    let sub3_id = harness.create_subject("Biology", 1).await;
    let (p5, r5) = harness
        .create_draft_page(&sub3_id, "Bio 1", "# Bio 1")
        .await;
    let (p6, r6) = harness
        .create_draft_page(&sub3_id, "Bio 2", "# Bio 2")
        .await;
    let (p7, r7) = harness
        .create_draft_page(&sub3_id, "Bio 3", "# Bio 3")
        .await;
    harness.publish_page(&p5, r5, &[]).await;
    harness.publish_page(&p6, r6, &[]).await;
    harness.publish_page(&p7, r7, &[]).await;

    let (status, val) = harness.get_public_subjects().await;
    assert_eq!(status, StatusCode::OK);
    let subjects: Vec<PublicSubjectItem> = serde_json::from_value(val).unwrap();

    assert_eq!(subjects.len(), 3);

    // Assert ordering: position ASC, name ASC
    // 1. Biology (pos=1, count=3)
    // 2. Chemistry (pos=1, count=1) (alphabetical tie-breaker)
    // 3. Zeta Physics (pos=2, count=2) (draft page not counted!)
    assert_eq!(subjects[0].name, "Biology");
    assert_eq!(subjects[0].position, 1);
    assert_eq!(subjects[0].page_count, 3);

    assert_eq!(subjects[1].name, "Chemistry");
    assert_eq!(subjects[1].position, 1);
    assert_eq!(subjects[1].page_count, 1);

    assert_eq!(subjects[2].name, "Zeta Physics");
    assert_eq!(subjects[2].position, 2);
    assert_eq!(subjects[2].page_count, 2);
}

#[tokio::test]
async fn test_public_subjects_dynamic_transition_on_publish_and_unpublish() {
    let harness = M3TestHarness::new().await;

    let sub_id = harness.create_subject("Robotics", 1).await;
    let (p1, r1) = harness
        .create_draft_page(&sub_id, "Robo 1", "Robotics intro")
        .await;

    // Initially unpublished -> subjects list is empty
    let (_, val1) = harness.get_public_subjects().await;
    let list1: Vec<PublicSubjectItem> = serde_json::from_value(val1).unwrap();
    assert!(list1.is_empty());

    // Publish page -> appears in subjects list with page_count = 1
    harness.publish_page(&p1, r1, &[]).await;
    let (_, val2) = harness.get_public_subjects().await;
    let list2: Vec<PublicSubjectItem> = serde_json::from_value(val2).unwrap();
    assert_eq!(list2.len(), 1);
    assert_eq!(list2[0].name, "Robotics");
    assert_eq!(list2[0].page_count, 1);

    // Unpublish page -> immediately disappears from subjects list
    harness.unpublish_page(&p1).await;
    let (_, val3) = harness.get_public_subjects().await;
    let list3: Vec<PublicSubjectItem> = serde_json::from_value(val3).unwrap();
    assert!(list3.is_empty());
}

// ============================================================================
// MODULE 2: CATALOG LISTING & SUBJECT FILTERING TESTS
// ============================================================================

#[tokio::test]
async fn test_public_catalog_empty_when_no_publications() {
    let harness = M3TestHarness::new().await;
    let (status, val) = harness.get_public_pages("").await;
    assert_eq!(status, StatusCode::OK);
    let res: PublicPageListResponse = serde_json::from_value(val).unwrap();
    assert_eq!(res.items.len(), 0);
    assert_eq!(res.total, 0);
    assert_eq!(res.limit, 20);
    assert_eq!(res.offset, 0);
}

#[tokio::test]
async fn test_public_catalog_returns_all_published_pages() {
    let harness = M3TestHarness::new().await;
    let sub_id = harness.create_subject("Physics", 1).await;

    let (p1, r1) = harness
        .create_draft_page(&sub_id, "Optics Lab", "Intro to lasers and lenses.")
        .await;
    let (p2, r2) = harness
        .create_draft_page(
            &sub_id,
            "Mechanics Lab",
            "Newtonian mechanics and friction.",
        )
        .await;
    harness.publish_page(&p1, r1, &[]).await;
    harness.publish_page(&p2, r2, &[]).await;

    let (status, val) = harness.get_public_pages("").await;
    assert_eq!(status, StatusCode::OK);
    let res: PublicPageListResponse = serde_json::from_value(val).unwrap();
    assert_eq!(res.total, 2);
    assert_eq!(res.items.len(), 2);

    for item in &res.items {
        assert_eq!(item.subject_id, sub_id);
        assert_eq!(item.subject_name, "Physics");
        assert!(!item.id.is_empty());
        assert!(!item.title.is_empty());
        assert!(!item.snippet.is_empty());
        assert!(!item.published_at.is_empty());
    }
}

#[tokio::test]
async fn test_public_catalog_filter_by_valid_subject_id() {
    let harness = M3TestHarness::new().await;
    let sub1_id = harness.create_subject("Physics", 1).await;
    let sub2_id = harness.create_subject("Math", 2).await;

    let (p1, r1) = harness
        .create_draft_page(&sub1_id, "Phys 1", "Physics text")
        .await;
    let (p2, r2) = harness
        .create_draft_page(&sub2_id, "Math 1", "Calculus text")
        .await;
    harness.publish_page(&p1, r1, &[]).await;
    harness.publish_page(&p2, r2, &[]).await;

    // Filter by Subject 1
    let (status, val) = harness
        .get_public_pages(&format!("subject_id={sub1_id}"))
        .await;
    assert_eq!(status, StatusCode::OK);
    let res: PublicPageListResponse = serde_json::from_value(val).unwrap();
    assert_eq!(res.total, 1);
    assert_eq!(res.items.len(), 1);
    assert_eq!(res.items[0].id, p1);
    assert_eq!(res.items[0].subject_name, "Physics");

    // Filter by Subject 2
    let (status2, val2) = harness
        .get_public_pages(&format!("subject_id={sub2_id}"))
        .await;
    assert_eq!(status2, StatusCode::OK);
    let res2: PublicPageListResponse = serde_json::from_value(val2).unwrap();
    assert_eq!(res2.total, 1);
    assert_eq!(res2.items[0].id, p2);
    assert_eq!(res2.items[0].subject_name, "Math");
}

#[tokio::test]
async fn test_public_catalog_filter_by_nonexistent_valid_uuid() {
    let harness = M3TestHarness::new().await;
    let sub_id = harness.create_subject("Physics", 1).await;
    let (p1, r1) = harness
        .create_draft_page(&sub_id, "Phys 1", "Physics text")
        .await;
    harness.publish_page(&p1, r1, &[]).await;

    let random_uuid = "00000000-0000-0000-0000-000000000000";
    let (status, val) = harness
        .get_public_pages(&format!("subject_id={random_uuid}"))
        .await;
    assert_eq!(status, StatusCode::OK);
    let res: PublicPageListResponse = serde_json::from_value(val).unwrap();
    assert_eq!(res.total, 0);
    assert!(res.items.is_empty());
}

#[tokio::test]
async fn test_public_catalog_filter_by_malformed_subject_id() {
    let harness = M3TestHarness::new().await;
    let (status, val) = harness
        .get_public_pages("subject_id=not-a-valid-uuid")
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(val["error"]["code"], "VALIDATION_ERROR");
}

// ============================================================================
// MODULE 3: PAGINATION & CLAMPING TESTS
// ============================================================================

#[tokio::test]
async fn test_public_catalog_default_pagination() {
    let harness = M3TestHarness::new().await;
    let sub_id = harness.create_subject("CompSci", 1).await;

    // Create and publish 25 pages
    for i in 1..=25 {
        let (pid, rev) = harness
            .create_draft_page(
                &sub_id,
                &format!("Lab {i}"),
                &format!("Content for lab {i}"),
            )
            .await;
        harness.publish_page(&pid, rev, &[]).await;
    }

    let (status, val) = harness.get_public_pages("").await;
    assert_eq!(status, StatusCode::OK);
    let res: PublicPageListResponse = serde_json::from_value(val).unwrap();
    assert_eq!(res.total, 25);
    assert_eq!(res.items.len(), 20); // default limit is 20
    assert_eq!(res.limit, 20);
    assert_eq!(res.offset, 0);
}

#[tokio::test]
async fn test_public_catalog_custom_limit_and_offset() {
    let harness = M3TestHarness::new().await;
    let sub_id = harness.create_subject("CompSci", 1).await;

    let mut published_ids = Vec::new();
    for i in 1..=25 {
        let (pid, rev) = harness
            .create_draft_page(&sub_id, &format!("Lab {i:02}"), &format!("Content {i}"))
            .await;
        harness.publish_page(&pid, rev, &[]).await;
        published_ids.push(pid);
    }

    // Page 1: limit=10, offset=0
    let (_, val1) = harness.get_public_pages("limit=10&offset=0").await;
    let res1: PublicPageListResponse = serde_json::from_value(val1).unwrap();
    assert_eq!(res1.items.len(), 10);
    assert_eq!(res1.total, 25);
    assert_eq!(res1.offset, 0);

    // Page 2: limit=10, offset=10
    let (_, val2) = harness.get_public_pages("limit=10&offset=10").await;
    let res2: PublicPageListResponse = serde_json::from_value(val2).unwrap();
    assert_eq!(res2.items.len(), 10);
    assert_eq!(res2.offset, 10);

    // Page 3: limit=10, offset=20 (remaining 5)
    let (_, val3) = harness.get_public_pages("limit=10&offset=20").await;
    let res3: PublicPageListResponse = serde_json::from_value(val3).unwrap();
    assert_eq!(res3.items.len(), 5);
    assert_eq!(res3.offset, 20);

    // Ensure pages 1 and 2 are strictly disjoint
    let ids1: Vec<String> = res1.items.into_iter().map(|it| it.id).collect();
    let ids2: Vec<String> = res2.items.into_iter().map(|it| it.id).collect();
    for id in &ids1 {
        assert!(!ids2.contains(id), "Page items must not overlap");
    }
}

#[tokio::test]
async fn test_public_catalog_offset_beyond_total() {
    let harness = M3TestHarness::new().await;
    let sub_id = harness.create_subject("Bio", 1).await;
    let (p1, r1) = harness.create_draft_page(&sub_id, "Bio 1", "Text").await;
    harness.publish_page(&p1, r1, &[]).await;

    let (status, val) = harness.get_public_pages("limit=10&offset=100").await;
    assert_eq!(status, StatusCode::OK);
    let res: PublicPageListResponse = serde_json::from_value(val).unwrap();
    assert_eq!(res.total, 1);
    assert!(res.items.is_empty());
}

#[tokio::test]
async fn test_public_catalog_limit_and_offset_clamping() {
    let harness = M3TestHarness::new().await;
    let sub_id = harness.create_subject("Bio", 1).await;
    let (p1, r1) = harness.create_draft_page(&sub_id, "Bio 1", "Text").await;
    harness.publish_page(&p1, r1, &[]).await;

    // limit=0 clamped to min 1
    let (_, val1) = harness.get_public_pages("limit=0").await;
    let res1: PublicPageListResponse = serde_json::from_value(val1).unwrap();
    assert_eq!(res1.limit, 1);

    // limit=500 clamped to max 100
    let (_, val2) = harness.get_public_pages("limit=500").await;
    let res2: PublicPageListResponse = serde_json::from_value(val2).unwrap();
    assert_eq!(res2.limit, 100);

    // offset=-10 clamped to min 0
    let (_, val3) = harness.get_public_pages("offset=-10").await;
    let res3: PublicPageListResponse = serde_json::from_value(val3).unwrap();
    assert_eq!(res3.offset, 0);

    // non-numeric limit mapped to 400 VALIDATION_ERROR
    let (status4, val4) = harness.get_public_pages("limit=abc").await;
    assert_eq!(status4, StatusCode::BAD_REQUEST);
    assert_eq!(val4["error"]["code"], "VALIDATION_ERROR");
}

// ============================================================================
// MODULE 4: SQL SEARCH & SNIPPET EXTRACTION TESTS
// ============================================================================

#[tokio::test]
async fn test_sql_search_match_by_title() {
    let harness = M3TestHarness::new().await;
    let sub_id = harness.create_subject("Physics", 1).await;

    let (p1, r1) = harness
        .create_draft_page(&sub_id, "Optics Laboratory", "Standard experiment.")
        .await;
    let (p2, r2) = harness
        .create_draft_page(
            &sub_id,
            "Thermodynamics Analysis",
            "Heat transfer measurements.",
        )
        .await;
    harness.publish_page(&p1, r1, &[]).await;
    harness.publish_page(&p2, r2, &[]).await;

    let (_, val) = harness.get_public_pages("q=Optics").await;
    let res: PublicPageListResponse = serde_json::from_value(val).unwrap();
    assert_eq!(res.total, 1);
    assert_eq!(res.items[0].id, p1);
    assert_eq!(res.items[0].title, "Optics Laboratory");
}

#[tokio::test]
async fn test_sql_search_match_by_markdown_body() {
    let harness = M3TestHarness::new().await;
    let sub_id = harness.create_subject("Physics", 1).await;

    let (p1, r1) = harness
        .create_draft_page(
            &sub_id,
            "Lab 1",
            "Investigation of diffraction grating with helium-neon laser.",
        )
        .await;
    let (p2, r2) = harness
        .create_draft_page(
            &sub_id,
            "Lab 2",
            "Calorimetry of metals in water bath at equilibrium.",
        )
        .await;
    harness.publish_page(&p1, r1, &[]).await;
    harness.publish_page(&p2, r2, &[]).await;

    let (_, val) = harness.get_public_pages("q=diffraction").await;
    let res: PublicPageListResponse = serde_json::from_value(val).unwrap();
    assert_eq!(res.total, 1);
    assert_eq!(res.items[0].id, p1);
}

#[tokio::test]
async fn test_sql_search_case_insensitivity() {
    let harness = M3TestHarness::new().await;
    let sub_id = harness.create_subject("Physics", 1).await;

    let (p1, r1) = harness
        .create_draft_page(&sub_id, "Quantum Oscillations", "Landau levels.")
        .await;
    harness.publish_page(&p1, r1, &[]).await;

    for query in &["quantum", "QUANTUM", "QuAnTuM"] {
        let (_, val) = harness.get_public_pages(&format!("q={query}")).await;
        let res: PublicPageListResponse = serde_json::from_value(val).unwrap();
        assert_eq!(
            res.total, 1,
            "Query '{query}' must match 'Quantum Oscillations'"
        );
        assert_eq!(res.items[0].id, p1);
    }
}

#[tokio::test]
async fn test_sql_search_cyrillic_case_insensitivity() {
    let harness = M3TestHarness::new().await;
    let sub_id = harness.create_subject("Физика", 1).await;

    let (p1, r1) = harness
        .create_draft_page(
            &sub_id,
            "Лабораторная работа №1: Квантовая оптика",
            "Изучение явления фотоэффекта, уравнения Эйнштейна и интерференции лазерного луча.",
        )
        .await;
    harness.publish_page(&p1, r1, &[]).await;

    // 1. Search by title across lowercase, capitalized, and ALL-CAPS
    let title_queries = [
        "лабораторная",
        "Лабораторная",
        "ЛАБОРАТОРНАЯ",
        "квантовая",
        "Квантовая",
        "КВАНТОВАЯ",
        "оптика",
        "Оптика",
        "ОПТИКА",
    ];

    for query in title_queries {
        let (status, val) = harness
            .get_public_pages(&format!("q={}", percent_encode(query)))
            .await;
        assert_eq!(status, StatusCode::OK);
        let res: PublicPageListResponse = serde_json::from_value(val).unwrap();
        assert_eq!(
            res.total, 1,
            "Title query '{query}' must match 'Лабораторная работа №1: Квантовая оптика'"
        );
        assert_eq!(res.items[0].id, p1);
    }

    // 2. Search by markdown body across lowercase, capitalized, and ALL-CAPS
    let body_queries = [
        "фотоэффекта",
        "Фотоэффекта",
        "ФОТОЭФФЕКТА",
        "эйнштейна",
        "Эйнштейна",
        "ЭЙНШТЕЙНА",
        "интерференции",
        "Интерференции",
        "ИНТЕРФЕРЕНЦИИ",
        "лазерного",
        "Лазерного",
        "ЛАЗЕРНОГО",
    ];

    for query in body_queries {
        let (status, val) = harness
            .get_public_pages(&format!("q={}", percent_encode(query)))
            .await;
        assert_eq!(status, StatusCode::OK);
        let res: PublicPageListResponse = serde_json::from_value(val).unwrap();
        assert_eq!(
            res.total, 1,
            "Body query '{query}' must match '... уравнения Эйнштейна и фотоэффекта.'"
        );
        assert_eq!(res.items[0].id, p1);
    }
}

#[tokio::test]
async fn test_sql_search_whitespace_trimming_and_empty_query() {
    let harness = M3TestHarness::new().await;
    let sub_id = harness.create_subject("Physics", 1).await;

    let (p1, r1) = harness
        .create_draft_page(&sub_id, "Mechanics", "Gravity experiments.")
        .await;
    harness.publish_page(&p1, r1, &[]).await;

    // Empty query `q=` returns all pages
    let (_, val1) = harness.get_public_pages("q=").await;
    let res1: PublicPageListResponse = serde_json::from_value(val1).unwrap();
    assert_eq!(res1.total, 1);

    // Whitespace only `q=   ` returns all pages
    let (_, val2) = harness.get_public_pages("q=%20%20%20").await;
    let res2: PublicPageListResponse = serde_json::from_value(val2).unwrap();
    assert_eq!(res2.total, 1);

    // Whitespace padded `q=  mechanics  ` correctly matches
    let (_, val3) = harness.get_public_pages("q=%20%20mechanics%20%20").await;
    let res3: PublicPageListResponse = serde_json::from_value(val3).unwrap();
    assert_eq!(res3.total, 1);
    assert_eq!(res3.items[0].id, p1);
}

#[tokio::test]
async fn test_sql_search_combined_with_subject_filter() {
    let harness = M3TestHarness::new().await;
    let sub1_id = harness.create_subject("Subject A", 1).await;
    let sub2_id = harness.create_subject("Subject B", 2).await;

    let (p1, r1) = harness
        .create_draft_page(&sub1_id, "Optics Lab A", "Shared term optics.")
        .await;
    let (p2, r2) = harness
        .create_draft_page(&sub2_id, "Optics Lab B", "Shared term optics.")
        .await;
    harness.publish_page(&p1, r1, &[]).await;
    harness.publish_page(&p2, r2, &[]).await;

    // Search optics within Subject A only
    let (_, val) = harness
        .get_public_pages(&format!("subject_id={sub1_id}&q=optics"))
        .await;
    let res: PublicPageListResponse = serde_json::from_value(val).unwrap();
    assert_eq!(res.total, 1);
    assert_eq!(res.items[0].id, p1);
}

#[tokio::test]
async fn test_sql_search_like_escaping_percent_and_underscore() {
    let harness = M3TestHarness::new().await;
    let sub_id = harness.create_subject("Special", 1).await;

    let (p_norm, r_norm) = harness
        .create_draft_page(&sub_id, "Normal Page", "Normal text")
        .await;
    let (p_pct, r_pct) = harness
        .create_draft_page(&sub_id, "Accuracy 100%", "Measurement with 100% precision.")
        .await;
    let (p_und, r_und) = harness
        .create_draft_page(&sub_id, "file_name_test", "Underline identifier")
        .await;
    let (p_x, r_x) = harness
        .create_draft_page(&sub_id, "fileXnameXtest", "No underscore here")
        .await;

    harness.publish_page(&p_norm, r_norm, &[]).await;
    harness.publish_page(&p_pct, r_pct, &[]).await;
    harness.publish_page(&p_und, r_und, &[]).await;
    harness.publish_page(&p_x, r_x, &[]).await;

    // Searching literal `100%` must match ONLY p_pct, not all pages!
    let (_, val_pct) = harness.get_public_pages("q=100%25").await;
    let res_pct: PublicPageListResponse = serde_json::from_value(val_pct).unwrap();
    assert_eq!(res_pct.total, 1);
    assert_eq!(res_pct.items[0].id, p_pct);

    // Searching literal `file_name` must match ONLY p_und, NOT p_x!
    let (_, val_und) = harness.get_public_pages("q=file_name").await;
    let res_und: PublicPageListResponse = serde_json::from_value(val_und).unwrap();
    assert_eq!(res_und.total, 1);
    assert_eq!(res_und.items[0].id, p_und);
}

#[tokio::test]
async fn test_markdown_snippet_stripping_and_centering() {
    let harness = M3TestHarness::new().await;
    let sub_id = harness.create_subject("Physics", 1).await;

    let long_markdown = r#"
# Heading 1

## Heading 2

This is the opening introduction to the experiment.

```rust
fn ignored_code() {
    let x = 123;
}
```

> Important notice: Safety goggles are required.

Here is a paragraph before the main target. We are observing the special **spectroscopic signature** of neon gas in the discharge tube under high voltage.

Please check the [reference manual](http://example.com/manual) and `run_test.sh` for details.
"#;

    let (pid, rev) = harness
        .create_draft_page(&sub_id, "Spectroscopy Experiment", long_markdown)
        .await;
    harness.publish_page(&pid, rev, &[]).await;

    // 1. Check default snippet (no query or query matching title): clean plain text
    let (_, val1) = harness.get_public_pages("").await;
    let res1: PublicPageListResponse = serde_json::from_value(val1).unwrap();
    let default_snippet = &res1.items[0].snippet;
    assert!(!default_snippet.contains('#'));
    assert!(!default_snippet.contains("```"));
    assert!(!default_snippet.contains("fn ignored_code"));
    assert!(default_snippet.len() <= 220);

    // 2. Query centering on search term located in middle of body
    let (_, val2) = harness.get_public_pages("q=spectroscopic").await;
    let res2: PublicPageListResponse = serde_json::from_value(val2).unwrap();
    let query_snippet = &res2.items[0].snippet;
    assert!(query_snippet.to_lowercase().contains("spectroscopic"));
    assert!(!query_snippet.contains("**"));
    assert!(!query_snippet.contains("http://example.com"));
    assert!(query_snippet.contains("..."));
}

// ============================================================================
// MODULE 5: PRIVACY BARRIER & DRAFT ISOLATION TESTS
// ============================================================================

#[tokio::test]
async fn test_draft_pages_strictly_invisible_in_all_public_endpoints() {
    let harness = M3TestHarness::new().await;
    let sub_id = harness.create_subject("Secret Labs", 1).await;

    let (draft_id, _rev) = harness
        .create_draft_page(&sub_id, "Classified Research", "Top secret draft formula.")
        .await;

    // 1. GET /api/public/subjects -> 0 subjects (draft page does not count)
    let (_, val_subs) = harness.get_public_subjects().await;
    let subs: Vec<PublicSubjectItem> = serde_json::from_value(val_subs).unwrap();
    assert!(subs.is_empty());

    // 2. GET /api/public/pages -> 0 items
    let (_, val_pages) = harness.get_public_pages("").await;
    let pages: PublicPageListResponse = serde_json::from_value(val_pages).unwrap();
    assert_eq!(pages.total, 0);

    // 3. Search query matching draft title or text -> 0 items
    let (_, val_q1) = harness.get_public_pages("q=Classified").await;
    let res_q1: PublicPageListResponse = serde_json::from_value(val_q1).unwrap();
    assert_eq!(res_q1.total, 0);

    let (_, val_q2) = harness.get_public_pages("q=secret").await;
    let res_q2: PublicPageListResponse = serde_json::from_value(val_q2).unwrap();
    assert_eq!(res_q2.total, 0);

    // 4. GET /api/public/pages/{draft_id} -> 404 PAGE_NOT_FOUND
    let (status, err_val) = harness.get_public_page(&draft_id).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(err_val["error"]["code"], "PAGE_NOT_FOUND");
}

#[tokio::test]
async fn test_dual_state_draft_edits_never_leak_to_public_view() {
    let harness = M3TestHarness::new().await;
    let sub_id = harness.create_subject("Astronomy", 1).await;

    // Create and publish V1
    let (page_id, rev1) = harness
        .create_draft_page(&sub_id, "Planets V1", "Public description of Mars V1.")
        .await;
    harness.publish_page(&page_id, rev1, &[]).await;

    // Verify public view returns V1
    let (status1, val1) = harness.get_public_page(&page_id).await;
    assert_eq!(status1, StatusCode::OK);
    let view1: PublicPageViewResponse = serde_json::from_value(val1).unwrap();
    assert_eq!(view1.title, "Planets V1");
    assert_eq!(view1.markdown, "Public description of Mars V1.");

    // Admin edits draft to V2 (title and body changed) without re-publishing
    let rev2 = harness
        .update_draft(
            &page_id,
            rev1,
            Some("Draft V2 Secret Title"),
            Some("Unpublished secret discovery in V2."),
        )
        .await;

    // Public view MUST STILL return V1!
    let (status2, val2) = harness.get_public_page(&page_id).await;
    assert_eq!(status2, StatusCode::OK);
    let view2: PublicPageViewResponse = serde_json::from_value(val2).unwrap();
    assert_eq!(
        view2.title, "Planets V1",
        "Public title must remain frozen at published snapshot"
    );
    assert_eq!(
        view2.markdown, "Public description of Mars V1.",
        "Public markdown must remain frozen at published snapshot"
    );

    // Search for "Secret" must return 0 results
    let (_, val_sec) = harness.get_public_pages("q=Secret").await;
    let res_sec: PublicPageListResponse = serde_json::from_value(val_sec).unwrap();
    assert_eq!(res_sec.total, 0);

    // Search for "Planets" must return 1 result
    let (_, val_plan) = harness.get_public_pages("q=Planets").await;
    let res_plan: PublicPageListResponse = serde_json::from_value(val_plan).unwrap();
    assert_eq!(res_plan.total, 1);

    // Re-publish revision 2
    harness.publish_page(&page_id, rev2, &[]).await;

    // Now public view reflects V2
    let (status3, val3) = harness.get_public_page(&page_id).await;
    assert_eq!(status3, StatusCode::OK);
    let view3: PublicPageViewResponse = serde_json::from_value(val3).unwrap();
    assert_eq!(view3.title, "Draft V2 Secret Title");
    assert_eq!(view3.markdown, "Unpublished secret discovery in V2.");
}

#[tokio::test]
async fn test_immediate_revocation_on_unpublish() {
    let harness = M3TestHarness::new().await;
    let sub_id = harness.create_subject("Physics", 1).await;

    let (pid, rev) = harness
        .create_draft_page(&sub_id, "Temporary Lab", "Soon to be unpublished.")
        .await;
    harness.publish_page(&pid, rev, &[]).await;

    // Verified published
    let (status_before, _) = harness.get_public_page(&pid).await;
    assert_eq!(status_before, StatusCode::OK);

    // Admin unpublishes page
    harness.unpublish_page(&pid).await;

    // Immediately returns 404 PAGE_NOT_FOUND
    let (status_after, err_val) = harness.get_public_page(&pid).await;
    assert_eq!(status_after, StatusCode::NOT_FOUND);
    assert_eq!(err_val["error"]["code"], "PAGE_NOT_FOUND");

    // Catalog count decrements immediately
    let (_, cat_val) = harness.get_public_pages("").await;
    let cat_res: PublicPageListResponse = serde_json::from_value(cat_val).unwrap();
    assert_eq!(cat_res.total, 0);
}

// ============================================================================
// MODULE 6: SINGLE PAGE VIEW & PUBLIC ATTACHMENT VISIBILITY TESTS
// ============================================================================

#[tokio::test]
async fn test_public_page_view_structure() {
    let harness = M3TestHarness::new().await;
    let sub_id = harness.create_subject("Mechanics", 1).await;

    let (pid, rev) = harness
        .create_draft_page(
            &sub_id,
            "Pendulum Oscillations",
            "# Pendulum\nFull laboratory guide.",
        )
        .await;
    harness.publish_page(&pid, rev, &[]).await;

    let (status, val) = harness.get_public_page(&pid).await;
    assert_eq!(status, StatusCode::OK);
    let page: PublicPageViewResponse = serde_json::from_value(val).unwrap();
    assert_eq!(page.id, pid);
    assert_eq!(page.subject_id, sub_id);
    assert_eq!(page.subject_name, "Mechanics");
    assert_eq!(page.title, "Pendulum Oscillations");
    assert_eq!(page.markdown, "# Pendulum\nFull laboratory guide.");
    assert!(!page.published_at.is_empty());
    assert!(page.attachments.is_empty());
}

#[tokio::test]
async fn test_public_page_view_attachments_filtering() {
    let harness = M3TestHarness::new().await;
    let sub_id = harness.create_subject("Electronics", 1).await;

    let (pid, rev) = harness
        .create_draft_page(
            &sub_id,
            "Circuit Analysis",
            "Schematic analysis and guidelines.",
        )
        .await;

    // Upload 3 assets:
    // 1. Image (kind = 'image')
    let img_asset = harness
        .upload_asset(&pid, "schematic.png", "image/png", VALID_PNG)
        .await;
    assert_eq!(img_asset.kind, "image");

    // 2. Attachment 1 (selected for publication)
    let att1_asset = harness
        .upload_asset(&pid, "manual.pdf", "application/pdf", VALID_PDF)
        .await;
    assert_eq!(att1_asset.kind, "attachment");

    // 3. Attachment 2 (unselected draft attachment)
    let att2_asset = harness
        .upload_asset(
            &pid,
            "draft_notes.docx",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            VALID_DOCX,
        )
        .await;
    assert_eq!(att2_asset.kind, "attachment");

    // Publish page with ONLY att1_asset selected
    harness
        .publish_page(&pid, rev, std::slice::from_ref(&att1_asset.id))
        .await;

    let (status, val) = harness.get_public_page(&pid).await;
    assert_eq!(status, StatusCode::OK);
    let page: PublicPageViewResponse = serde_json::from_value(val).unwrap();

    // Verify attachments:
    // MUST contain att1_asset
    // MUST NOT contain att2_asset (unselected)
    // MUST NOT contain img_asset (image is inline, not listed in attachments)
    assert_eq!(page.attachments.len(), 1);
    assert_eq!(page.attachments[0].id, att1_asset.id);
    assert_eq!(page.attachments[0].original_name, "manual.pdf");
    assert_eq!(page.attachments[0].mime, "application/pdf");
    assert_eq!(page.attachments[0].byte_size, VALID_PDF.len() as i64);

    let att_ids: Vec<String> = page.attachments.into_iter().map(|a| a.id).collect();
    assert!(!att_ids.contains(&att2_asset.id));
    assert!(!att_ids.contains(&img_asset.id));
}

#[tokio::test]
async fn test_public_page_view_nonexistent_and_invalid_uuid() {
    let harness = M3TestHarness::new().await;

    // Random non-existent UUID
    let non_existent = "11111111-2222-3333-4444-555555555555";
    let (status1, val1) = harness.get_public_page(non_existent).await;
    assert_eq!(status1, StatusCode::NOT_FOUND);
    assert_eq!(val1["error"]["code"], "PAGE_NOT_FOUND");

    // Malformed UUID string
    let malformed = "not-a-valid-uuid";
    let (status2, val2) = harness.get_public_page(malformed).await;
    assert_eq!(status2, StatusCode::NOT_FOUND);
    assert_eq!(val2["error"]["code"], "PAGE_NOT_FOUND");
}

// ============================================================================
// MODULE 7: NON-SPA 404 FALLBACK TESTS
// ============================================================================

#[tokio::test]
async fn test_unmatched_api_routes_return_json_not_found() {
    let harness = M3TestHarness::new().await;

    // Unmatched /api/unknown
    let (status1, headers1, val1) = harness.get_raw("/api/unknown_endpoint").await;
    assert_eq!(status1, StatusCode::NOT_FOUND);
    assert_eq!(
        headers1
            .get(header::CONTENT_TYPE)
            .unwrap()
            .to_str()
            .unwrap(),
        "application/json"
    );
    assert_eq!(val1["error"]["code"], "NOT_FOUND");

    // Unmatched /api/public/extra/route
    let (status2, headers2, val2) = harness.get_raw("/api/public/extra/route").await;
    assert_eq!(status2, StatusCode::NOT_FOUND);
    assert_eq!(
        headers2
            .get(header::CONTENT_TYPE)
            .unwrap()
            .to_str()
            .unwrap(),
        "application/json"
    );
    assert_eq!(val2["error"]["code"], "NOT_FOUND");
}

#[tokio::test]
async fn test_unmatched_media_routes_return_json_not_found() {
    let harness = M3TestHarness::new().await;

    // Missing media asset /media/{random_uuid} returns MEDIA_NOT_FOUND (from media route)
    let (status1, headers1, val1) = harness
        .get_raw("/media/99999999-9999-9999-9999-999999999999")
        .await;
    assert_eq!(status1, StatusCode::NOT_FOUND);
    assert_eq!(
        headers1
            .get(header::CONTENT_TYPE)
            .unwrap()
            .to_str()
            .unwrap(),
        "application/json"
    );
    assert_eq!(val1["error"]["code"], "MEDIA_NOT_FOUND");

    // Unmatched subpath /media/extra/segment hits router fallback with NOT_FOUND
    let (status2, headers2, val2) = harness.get_raw("/media/extra/segment").await;
    assert_eq!(status2, StatusCode::NOT_FOUND);
    assert_eq!(
        headers2
            .get(header::CONTENT_TYPE)
            .unwrap()
            .to_str()
            .unwrap(),
        "application/json"
    );
    assert_eq!(val2["error"]["code"], "NOT_FOUND");
}
