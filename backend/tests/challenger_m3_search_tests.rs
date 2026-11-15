//! Challenger 1: Adversarial Test Suite for Milestone 3
//! (Public Catalog, SQL Search & Read APIs)
//!
//! Empirical Stress, Penetration, and Fuzzing Verification:
//! 1. SQL Injection Vectors: classic tautologies, destructive queries, UNION selects, blind SQLi.
//! 2. Wildcard Fuzzing: literal `%`, `_`, `\`, `\%`, `\_`, `%%`, `___`, `100%`.
//! 3. Unicode & Multilingual: Cyrillic queries & case folding, emojis, 4-byte UTF-8, RTL, snippet safety.
//! 4. Extreme Pagination & Bounds: limit/offset negative, zero, giant, and non-numeric fuzzing.
//! 5. DoS & Long Query Payloads: 5,000+ chars, pathological markdown stripping.

use axum::{
    body::Body,
    http::{header, HeaderMap, Request, StatusCode},
};
use backend::{
    config::Config,
    db::{init_test_db, DbPool},
    models::{SubjectResponse, UpdatePageResponse},
    routes::create_router,
    AppState,
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tempfile::TempDir;
use tower::ServiceExt;

fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
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

struct ChallengerHarness {
    pub app: axum::Router,
    #[allow(dead_code)]
    pub db: DbPool,
    pub cookie: String,
    pub csrf_token: String,
    pub _temp_dir: TempDir,
}

impl ChallengerHarness {
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
            admin_password: Some("challenger_password_123".to_string()),
            session_secret: "challenger_session_secret_32_chars_ok".to_string(),
            max_image_bytes: 10 * 1024 * 1024,
            max_attachment_bytes: 50 * 1024 * 1024,
        };
        config.ensure_directories().unwrap();

        backend::auth::bootstrap_admin(&db, &config.admin_username, "challenger_password_123")
            .await
            .unwrap();

        let state = AppState::new(db.clone(), config.clone());
        let app = create_router(state);

        let login_payload = json!({
            "username": "admin",
            "password": "challenger_password_123"
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

    pub async fn create_and_publish_page(
        &self,
        subject_id: &str,
        title: &str,
        markdown: &str,
    ) -> String {
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

        let pub_req = Request::builder()
            .method("POST")
            .uri(format!("/api/admin/pages/{page_id}/publish"))
            .header(header::COOKIE, &self.cookie)
            .header("X-CSRF-Token", &self.csrf_token)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                serde_json::to_vec(&json!({
                    "expected_revision": rev,
                    "attachment_ids": []
                }))
                .unwrap(),
            ))
            .unwrap();
        let pub_resp = self.app.clone().oneshot(pub_req).await.unwrap();
        assert_eq!(pub_resp.status(), StatusCode::OK);

        page_id
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

    #[allow(dead_code)]
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
// 1. SQL INJECTION ADVERSARIAL VECTORS
// ============================================================================

#[tokio::test]
async fn test_adv_sqli_tautology_payloads_do_not_bypass_filters() {
    let harness = ChallengerHarness::new().await;
    let sub1 = harness.create_subject("Physics", 1).await;
    let sub2 = harness.create_subject("Chemistry", 2).await;

    harness
        .create_and_publish_page(&sub1, "Quantum Optics", "Study of lasers and photons.")
        .await;
    harness
        .create_and_publish_page(&sub2, "Organic Synthesis", "Study of carbon compounds.")
        .await;

    let sqli_payloads = [
        "' OR '1'='1",
        "' OR 1=1 --",
        "\" OR \"\"=\"",
        "') OR ('1'='1",
        "' OR 'a'='a",
        "admin'--",
        "' OR ''='",
        "1' OR '1' = '1' --",
    ];

    for payload in &sqli_payloads {
        let encoded = percent_encode(payload);
        let (status, body) = harness.get_public_pages(&format!("q={encoded}")).await;
        assert_eq!(status, StatusCode::OK, "Failed for payload: {payload}");

        let total = body["total"].as_i64().unwrap();
        let items = body["items"].as_array().unwrap();
        assert_eq!(
            total, 0,
            "SQL injection payload '{payload}' bypassed search filter and matched {total} items!"
        );
        assert!(items.is_empty());
    }

    // Now test with subject_id filter combined with SQLi tautology in `q`:
    // It must NOT leak publications from the other subject!
    for payload in &sqli_payloads {
        let encoded = percent_encode(payload);
        let (status, body) = harness
            .get_public_pages(&format!("subject_id={sub1}&q={encoded}"))
            .await;
        assert_eq!(status, StatusCode::OK);
        let total = body["total"].as_i64().unwrap();
        assert_eq!(
            total, 0,
            "SQL injection payload '{payload}' leaked rows across subjects!"
        );
    }
}

#[tokio::test]
async fn test_adv_sqli_destructive_stacked_queries_prevented() {
    let harness = ChallengerHarness::new().await;
    let sub = harness.create_subject("Computer Science", 1).await;
    harness
        .create_and_publish_page(&sub, "Algorithms Lab", "Sorting and searching algorithms.")
        .await;

    let destructive_payloads = [
        "'; DROP TABLE publications; --",
        "'; DROP TABLE subjects; --",
        "'; DELETE FROM publications; --",
        "'; VACUUM; --",
        "'; ATTACH DATABASE 'evil.db' AS evil; --",
    ];

    for payload in &destructive_payloads {
        let encoded = percent_encode(payload);
        let (status, body) = harness.get_public_pages(&format!("q={encoded}")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["total"].as_i64().unwrap(), 0);

        // Verify database is completely intact after the attempt
        let (check_status, check_body) = harness.get_public_pages("").await;
        assert_eq!(check_status, StatusCode::OK);
        assert_eq!(
            check_body["total"].as_i64().unwrap(),
            1,
            "Destructive SQL injection '{payload}' affected table state!"
        );
    }
}

#[tokio::test]
async fn test_adv_sqli_union_and_schema_extraction_prevented() {
    let harness = ChallengerHarness::new().await;
    let sub = harness.create_subject("Security", 1).await;
    harness
        .create_and_publish_page(&sub, "Penetration Testing", "Security review notes.")
        .await;

    let union_payloads = [
        "' UNION SELECT id, username, password_hash, NULL, NULL, NULL FROM users --",
        "' UNION SELECT id, name, position, 1 FROM subjects --",
        "' UNION ALL SELECT 'pwn', 'pwn', 'pwn', 'pwn', 'pwn', 'pwn' --",
        "' UNION SELECT 1, sql, 3, 4, 5, 6 FROM sqlite_master --",
    ];

    for payload in &union_payloads {
        let encoded = percent_encode(payload);
        let (status, body) = harness.get_public_pages(&format!("q={encoded}")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body["total"].as_i64().unwrap(),
            0,
            "UNION payload '{payload}' extracted unauthorized records!"
        );
    }
}

#[tokio::test]
async fn test_adv_sqli_subject_id_injection_rejected() {
    let harness = ChallengerHarness::new().await;
    let sub = harness.create_subject("Math", 1).await;
    harness
        .create_and_publish_page(&sub, "Linear Algebra", "Matrix operations.")
        .await;

    let malicious_subject_ids = [
        "' OR '1'='1",
        "'; DROP TABLE subjects; --",
        "00000000-0000-0000-0000-000000000000' OR '1'='1",
        "123' UNION SELECT 1,2,3,4--",
        "'; DELETE FROM publications; --",
        "admin",
        "../../../etc/passwd",
    ];

    for bad_id in &malicious_subject_ids {
        let encoded = percent_encode(bad_id);
        let (status, body) = harness
            .get_public_pages(&format!("subject_id={encoded}"))
            .await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "Malicious subject_id '{bad_id}' was not rejected with 400!"
        );
        assert_eq!(body["error"]["code"], "VALIDATION_ERROR");
    }
}

#[tokio::test]
async fn test_adv_sqli_pagination_injection_rejected() {
    let harness = ChallengerHarness::new().await;
    let sub = harness.create_subject("Biology", 1).await;
    harness
        .create_and_publish_page(&sub, "Cell Biology", "Microscope studies.")
        .await;

    let malicious_pagination = [
        ("limit", "1; DROP TABLE publications;"),
        ("limit", "1 UNION SELECT 1"),
        ("limit", "' OR '1'='1"),
        ("offset", "0; DROP TABLE publications;"),
        ("offset", "0 UNION SELECT 1"),
        ("offset", "10' OR '1'='1"),
    ];

    for (param, payload) in &malicious_pagination {
        let encoded = percent_encode(payload);
        let (status, body) = harness
            .get_public_pages(&format!("{param}={encoded}"))
            .await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "Malicious pagination param {param}='{payload}' was not rejected with 400!"
        );
        assert_eq!(body["error"]["code"], "VALIDATION_ERROR");
    }
}

// ============================================================================
// 2. WILDCARD FUZZING & LIKE ESCAPING
// ============================================================================

#[tokio::test]
async fn test_adv_wildcard_percent_isolation_fuzzing() {
    let harness = ChallengerHarness::new().await;
    let sub = harness.create_subject("Grading", 1).await;

    harness
        .create_and_publish_page(
            &sub,
            "Final Grade 100% Perfect",
            "The student scored 100% on the laboratory assignment.",
        )
        .await;
    harness
        .create_and_publish_page(
            &sub,
            "Final Grade 1000 Points",
            "The student accumulated 1000 points throughout the term.",
        )
        .await;
    harness
        .create_and_publish_page(
            &sub,
            "Final Grade 100 Bananas",
            "The student received 100 bananas as a prize.",
        )
        .await;

    // 1. Searching for exact "100%" must match ONLY the article containing "100%"
    let (status, body) = harness.get_public_pages("q=100%25").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["total"].as_i64().unwrap(),
        1,
        "Searching for '100%' matched more or less than 1 publication!"
    );
    assert_eq!(body["items"][0]["title"], "Final Grade 100% Perfect");

    // 2. Searching for solitary "%" must match ONLY the publication with literal "%"
    let (status, body) = harness.get_public_pages("q=%25").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["total"].as_i64().unwrap(),
        1,
        "Solitary '%' wildcard matched non-percent articles!"
    );
    assert_eq!(body["items"][0]["title"], "Final Grade 100% Perfect");

    // 3. Searching for non-existent "99%" must match 0
    let (status, body) = harness.get_public_pages("q=99%25").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["total"].as_i64().unwrap(), 0);
}

#[tokio::test]
async fn test_adv_wildcard_underscore_isolation_fuzzing() {
    let harness = ChallengerHarness::new().await;
    let sub = harness.create_subject("Code", 1).await;

    harness
        .create_and_publish_page(&sub, "test_func_run", "Execution of test_func_run unit.")
        .await;
    harness
        .create_and_publish_page(&sub, "test-func-run", "Execution of test-func-run unit.")
        .await;
    harness
        .create_and_publish_page(&sub, "test func run", "Execution of test func run unit.")
        .await;
    harness
        .create_and_publish_page(&sub, "testXfuncXrun", "Execution of testXfuncXrun unit.")
        .await;

    // Searching for "test_func_run": with proper escaping `\_`, it MUST match ONLY literal underscore!
    let (status, body) = harness.get_public_pages("q=test_func_run").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["total"].as_i64().unwrap(),
        1,
        "Underscore wildcard leaked to arbitrary single characters!"
    );
    assert_eq!(body["items"][0]["title"], "test_func_run");

    // Searching for single "_" must match ONLY the one containing "_"
    let (status, body) = harness.get_public_pages("q=_").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["total"].as_i64().unwrap(), 1);
    assert_eq!(body["items"][0]["title"], "test_func_run");
}

#[tokio::test]
async fn test_adv_wildcard_consecutive_and_mixed_metacharacters() {
    let harness = ChallengerHarness::new().await;
    let sub = harness.create_subject("Metacharacters", 1).await;

    harness
        .create_and_publish_page(&sub, "Three Percents %%% Here", "Body with %%% chars.")
        .await;
    harness
        .create_and_publish_page(&sub, "Three Underscores ___ Here", "Body with ___ chars.")
        .await;
    harness
        .create_and_publish_page(&sub, "Single Percent % Only", "Single % here.")
        .await;
    harness
        .create_and_publish_page(&sub, "Single Underscore _ Only", "Single _ here.")
        .await;

    // Search for literal "%%%"
    let (status, body) = harness.get_public_pages("q=%25%25%25").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["total"].as_i64().unwrap(), 1);
    assert_eq!(body["items"][0]["title"], "Three Percents %%% Here");

    // Search for literal "___"
    let (status, body) = harness.get_public_pages("q=___").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["total"].as_i64().unwrap(), 1);
    assert_eq!(body["items"][0]["title"], "Three Underscores ___ Here");
}

#[tokio::test]
async fn test_adv_wildcard_backslash_and_escape_fuzzing() {
    let harness = ChallengerHarness::new().await;
    let sub = harness.create_subject("File Paths", 1).await;

    harness
        .create_and_publish_page(
            &sub,
            "Windows Path C:\\System32\\Drivers",
            "Config file located at C:\\System32\\Drivers\\etc\\hosts.",
        )
        .await;
    harness
        .create_and_publish_page(
            &sub,
            "Unix Path C:/System32/Drivers",
            "Config file located at C:/System32/Drivers/etc/hosts.",
        )
        .await;
    harness
        .create_and_publish_page(
            &sub,
            "Literal Escaped \\% and \\_ In Text",
            "Literal backslash percent \\% sequence.",
        )
        .await;

    // Search for literal "\System32\"
    let (status, body) = harness.get_public_pages("q=%5CSystem32%5C").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["total"].as_i64().unwrap(), 1);
    assert_eq!(
        body["items"][0]["title"],
        "Windows Path C:\\System32\\Drivers"
    );

    // Search for literal "\%"
    let (status, body) = harness.get_public_pages("q=%5C%25").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["total"].as_i64().unwrap(), 1);
    assert_eq!(
        body["items"][0]["title"],
        "Literal Escaped \\% and \\_ In Text"
    );

    // Search for literal single backslash "\"
    let (status, body) = harness.get_public_pages("q=%5C").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["total"].as_i64().unwrap(),
        2,
        "Single backslash search should match both articles containing literal backslashes"
    );
}

// ============================================================================
// 3. UNICODE, CYRILLIC, EMOJI, MULTIBYTE, AND SNIPPET BOUNDARIES
// ============================================================================

#[tokio::test]
async fn test_adv_unicode_cyrillic_search_and_case_behavior() {
    let harness = ChallengerHarness::new().await;
    let sub = harness.create_subject("Физика", 1).await;

    harness
        .create_and_publish_page(
            &sub,
            "Лабораторная работа №1: Квантовая оптика",
            "Изучение явления фотоэффекта, уравнения Эйнштейна и интерференции лазерного луча.",
        )
        .await;

    // Test matrix of Cyrillic queries across lower, capitalized, and ALL-CAPS casings
    let test_cases = [
        ("фотоэффекта", "lowercase in markdown, lowercase query"),
        ("Фотоэффекта", "lowercase in markdown, capitalized query"),
        ("ФОТОЭФФЕКТА", "lowercase in markdown, all-caps query"),
        (
            "квантовая",
            "capitalized in title ('Квантовая'), lowercase query",
        ),
        (
            "Квантовая",
            "capitalized in title ('Квантовая'), capitalized query",
        ),
        (
            "КВАНТОВАЯ",
            "capitalized in title ('Квантовая'), all-caps query",
        ),
        (
            "лабораторная",
            "capitalized in title ('Лабораторная'), lowercase query",
        ),
        (
            "Лабораторная",
            "capitalized in title ('Лабораторная'), capitalized query",
        ),
        (
            "ЛАБОРАТОРНАЯ",
            "capitalized in title ('Лабораторная'), all-caps query",
        ),
        ("лазерного", "lowercase in markdown, lowercase query"),
        ("Лазерного", "lowercase in markdown, capitalized query"),
        ("ЛАЗЕРНОГО", "lowercase in markdown, all-caps query"),
        ("Эйнштейна", "capitalized in markdown, capitalized query"),
        ("эйнштейна", "capitalized in markdown, lowercase query"),
        ("ЭЙНШТЕЙНА", "capitalized in markdown, all-caps query"),
    ];

    println!("\n=== CYRILLIC SEARCH EMPIRICAL MATRIX ===");
    for (query, desc) in test_cases {
        let (status, body) = harness
            .get_public_pages(&format!("q={}", percent_encode(query)))
            .await;
        assert_eq!(status, StatusCode::OK);
        let total = body["total"].as_i64().unwrap();
        println!("Query: '{query}' ({desc}) -> total matches: {total}");
        assert_eq!(
            total, 1,
            "Cyrillic search for '{query}' ({desc}) must return 1 match, but got {total}"
        );
        let items = body["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(
            items[0]["title"],
            "Лабораторная работа №1: Квантовая оптика"
        );
    }
    println!("========================================\n");
}

#[tokio::test]
async fn test_adv_unicode_emojis_and_grapheme_clusters() {
    let harness = ChallengerHarness::new().await;
    let sub = harness.create_subject("Biotechnology", 1).await;

    let title = "Gene Editing Lab 🧬🔬 with CRISPR";
    let markdown = "Laboratory experiment with DNA 🧬, test tubes 🧪, microscope 🔬. The research team 👨‍🔬 and family 👨‍👩‍👧‍👦 visited the satellite 🛰️ observation station 🚀.";

    harness.create_and_publish_page(&sub, title, markdown).await;

    // Search for single emoji: 🧬
    let (status, body) = harness
        .get_public_pages(&format!("q={}", percent_encode("🧬")))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["total"].as_i64().unwrap(), 1);
    let snippet = body["items"][0]["snippet"].as_str().unwrap();
    assert!(snippet.contains("🧬"), "Snippet should contain the emoji");

    // Search for compound ZWJ emoji: 👨‍🔬 (scientist: man + ZWJ + microscope)
    let (status, body) = harness
        .get_public_pages(&format!("q={}", percent_encode("👨‍🔬")))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["total"].as_i64().unwrap(), 1);

    // Search for complex family emoji: 👨‍👩‍👧‍👦
    let (status, body) = harness
        .get_public_pages(&format!("q={}", percent_encode("👨‍👩‍👧‍👦")))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["total"].as_i64().unwrap(), 1);
}

#[tokio::test]
async fn test_adv_unicode_non_bmp_4byte_math_alphanumeric() {
    let harness = ChallengerHarness::new().await;
    let sub = harness.create_subject("Mathematics", 1).await;

    let title = "Modern 𝕃𝕒𝕓ℕ𝕠𝕥𝕖𝕤 Mathematical Theory 𝔸𝕝𝕘𝕖𝕓𝕣𝕒";
    let markdown =
        "Calculations on ℂ𝕠𝕞𝕡𝕝𝕖𝕩 numbers and ℍ𝕒𝕞𝕚𝕝𝕥𝕠𝕟𝕚𝕒𝕟 operators with ℚ𝕦𝕒𝕟𝕥𝕦𝕞 mechanics.";

    harness.create_and_publish_page(&sub, title, markdown).await;

    // Search for 4-byte UTF-8 symbol: 𝕃𝕒𝕓ℕ𝕠𝕥𝕖𝕤
    let (status, body) = harness
        .get_public_pages(&format!("q={}", percent_encode("𝕃𝕒𝕓ℕ𝕠𝕥𝕖𝕤")))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["total"].as_i64().unwrap(), 1);
    assert_eq!(body["items"][0]["title"], title);

    // Search for 4-byte UTF-8 symbol: ℂ𝕠𝕞𝕡𝕝𝕖𝕩
    let (status, body) = harness
        .get_public_pages(&format!("q={}", percent_encode("ℂ𝕠𝕞𝕡𝕝𝕖𝕩")))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["total"].as_i64().unwrap(), 1);
}

#[tokio::test]
async fn test_adv_unicode_snippet_char_boundary_stress() {
    let harness = ChallengerHarness::new().await;
    let sub = harness.create_subject("Boundary Stress", 1).await;

    // Create a long body where Cyrillic multi-byte characters span across indices 150..170
    let cyrillic_repeats = "Привет, мир науки! ".repeat(25);
    let title = "Cyrillic Boundary Test";

    harness
        .create_and_publish_page(&sub, title, &cyrillic_repeats)
        .await;

    // 1. Search without query (tests default prefix snippet extraction)
    let (status, body) = harness.get_public_pages("").await;
    assert_eq!(status, StatusCode::OK);
    let snippet = body["items"][0]["snippet"].as_str().unwrap();
    assert!(!snippet.is_empty());
    assert!(snippet.ends_with("..."));

    // 2. Search for word located deep inside the text
    let (status, body) = harness
        .get_public_pages(&format!("q={}", percent_encode("науки")))
        .await;
    assert_eq!(status, StatusCode::OK);
    let snippet = body["items"][0]["snippet"].as_str().unwrap();
    assert!(snippet.contains("науки"));
}

#[tokio::test]
async fn test_adv_unicode_rtl_and_zero_width_characters() {
    let harness = ChallengerHarness::new().await;
    let sub = harness.create_subject("Multilingual", 1).await;

    let title = "تقرير مختبر דוח מעבדה Physics Report";
    let markdown = "Contains zero\u{200B}width\u{200C}spaces\u{200D}and mixed scripts: العربية, עברית, and English.";

    harness.create_and_publish_page(&sub, title, markdown).await;

    // Search Arabic
    let (status, body) = harness
        .get_public_pages(&format!("q={}", percent_encode("تقرير")))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["total"].as_i64().unwrap(), 1);

    // Search Hebrew
    let (status, body) = harness
        .get_public_pages(&format!("q={}", percent_encode("עברית")))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["total"].as_i64().unwrap(), 1);
}

// ============================================================================
// 4. EXTREME PAGINATION & PARAMETER BOUNDS FUZZING
// ============================================================================

#[tokio::test]
async fn test_adv_pagination_clamping_matrix() {
    let harness = ChallengerHarness::new().await;
    let sub = harness.create_subject("Pagination", 1).await;

    for i in 1..=5 {
        harness
            .create_and_publish_page(
                &sub,
                &format!("Page Number {i}"),
                &format!("Body content for page {i}."),
            )
            .await;
    }

    // 1. Negative limit -> clamped to 1
    let (status, body) = harness.get_public_pages("limit=-1").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["limit"].as_i64().unwrap(), 1);
    assert_eq!(body["items"].as_array().unwrap().len(), 1);

    let (status, body) = harness.get_public_pages("limit=-999999").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["limit"].as_i64().unwrap(), 1);

    // 2. Zero limit -> clamped to 1
    let (status, body) = harness.get_public_pages("limit=0").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["limit"].as_i64().unwrap(), 1);
    assert_eq!(body["items"].as_array().unwrap().len(), 1);

    // 3. Excess limits -> clamped to 100
    let (status, body) = harness.get_public_pages("limit=101").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["limit"].as_i64().unwrap(), 100);

    let (status, body) = harness.get_public_pages("limit=999999").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["limit"].as_i64().unwrap(), 100);

    // 4. Negative offset -> clamped to 0
    let (status, body) = harness.get_public_pages("offset=-5").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["offset"].as_i64().unwrap(), 0);
    assert_eq!(body["items"].as_array().unwrap().len(), 5);

    let (status, body) = harness.get_public_pages("offset=-999999").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["offset"].as_i64().unwrap(), 0);

    // 5. Huge offset -> valid, returns empty items array, total is accurate
    let (status, body) = harness.get_public_pages("offset=999999").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["offset"].as_i64().unwrap(), 999999);
    assert_eq!(body["total"].as_i64().unwrap(), 5);
    assert!(body["items"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn test_adv_pagination_malformed_type_rejections() {
    let harness = ChallengerHarness::new().await;
    let sub = harness.create_subject("Types", 1).await;
    harness
        .create_and_publish_page(&sub, "Type Test Page", "Body")
        .await;

    let malformed_params = [
        "limit=abc",
        "limit=1.5",
        "limit=true",
        "limit=",
        "offset=xyz",
        "offset=2.5",
        "offset=false",
        "offset=",
        "limit=999999999999999999999999999999999999", // integer overflow
        "offset=999999999999999999999999999999999999",
    ];

    for param in &malformed_params {
        let (status, body) = harness.get_public_pages(param).await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "Query param '{param}' was not rejected with 400!"
        );
        assert_eq!(body["error"]["code"], "VALIDATION_ERROR");
    }
}

#[tokio::test]
async fn test_adv_subject_id_fuzzing_and_blank_handling() {
    let harness = ChallengerHarness::new().await;
    let sub = harness.create_subject("Valid Sub", 1).await;
    harness
        .create_and_publish_page(&sub, "Valid Page", "Content")
        .await;

    // Blank or whitespace-only subject_id must be treated as absent (return all)
    let (status, body) = harness.get_public_pages("subject_id=").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["total"].as_i64().unwrap(), 1);

    let (status, body) = harness.get_public_pages("subject_id=%20%20").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["total"].as_i64().unwrap(), 1);

    // Non-existent valid UUID must return 0 items with 200 OK
    let (status, body) = harness
        .get_public_pages("subject_id=00000000-0000-0000-0000-000000000000")
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["total"].as_i64().unwrap(), 0);

    // Malformed UUIDs must return 400 VALIDATION_ERROR
    let bad_uuids = [
        "not-a-uuid",
        "12345",
        "00000000-0000-0000-0000-00000000000g", // invalid hex
        "00000000-0000-0000-0000-000000000000-extra",
        "true",
    ];
    for bad in &bad_uuids {
        let (status, body) = harness.get_public_pages(&format!("subject_id={bad}")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"]["code"], "VALIDATION_ERROR");
    }
}

#[tokio::test]
async fn test_adv_sqli_wildcard_hybrid_and_null_byte_injection() {
    let harness = ChallengerHarness::new().await;
    let sub = harness.create_subject("Hybrids", 1).await;
    harness
        .create_and_publish_page(
            &sub,
            "Hybrid Security Page",
            "Safe content for hybrid testing.",
        )
        .await;

    let hybrid_payloads = [
        "%' OR '%'='",
        "%_'; DROP TABLE publications; --",
        "100%' UNION SELECT 1,2,3,4,5,6--",
        "test%00' OR 1=1 --",
        "\\%\\_' OR 'x'='x",
        "'; EXEC xp_cmdshell('dir'); --",
    ];

    for payload in &hybrid_payloads {
        let encoded = percent_encode(payload);
        let (status, body) = harness.get_public_pages(&format!("q={encoded}")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body["total"].as_i64().unwrap(),
            0,
            "Hybrid payload '{payload}' produced unexpected matches!"
        );
    }

    // Null byte in subject_id
    let (status, body) = harness
        .get_public_pages("subject_id=00000000-0000-0000-0000-000000000000%00")
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "VALIDATION_ERROR");
}

#[tokio::test]
async fn test_adv_snippet_extreme_edge_cases() {
    let harness = ChallengerHarness::new().await;
    let sub = harness.create_subject("Snippet Edge Cases", 1).await;

    // 1. Page with empty markdown
    harness
        .create_and_publish_page(&sub, "Empty Markdown Page", "")
        .await;

    // 2. Page with only formatting characters
    harness
        .create_and_publish_page(
            &sub,
            "Formatting Only Page",
            "###### >>>> ******* ~~~~~~ ````\n```\n```\n- - - + + +",
        )
        .await;

    // 3. Page with search query matching at char 0
    harness
        .create_and_publish_page(
            &sub,
            "Query At Very Beginning",
            "Frontmatch is right at the opening of this text followed by plenty of filler words to exceed 160 characters length.",
        )
        .await;

    // 4. Page with search query matching at the very end of a 300+ char document
    let tail_text = "Filler text for testing snippet window centering. ".repeat(6) + "Tailmatch.";
    harness
        .create_and_publish_page(&sub, "Query At Very End", &tail_text)
        .await;

    // Query empty markdown page
    let (status, body) = harness.get_public_pages("q=Empty%20Markdown%20Page").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["total"].as_i64().unwrap(), 1);
    assert_eq!(body["items"][0]["snippet"], "");

    // Query formatting-only page (verifying clean extraction without panic)
    let (status, body) = harness.get_public_pages("q=Formatting%20Only%20Page").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["total"].as_i64().unwrap(), 1);
    let formatting_snippet = body["items"][0]["snippet"].as_str().unwrap();
    assert!(!formatting_snippet.contains('*'));
    assert!(!formatting_snippet.contains('~'));
    assert!(!formatting_snippet.contains('`'));

    // Query Frontmatch
    let (status, body) = harness.get_public_pages("q=Frontmatch").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["total"].as_i64().unwrap(), 1);
    let front_snippet = body["items"][0]["snippet"].as_str().unwrap();
    assert!(front_snippet.starts_with("Frontmatch"));
    assert!(!front_snippet.starts_with("..."));

    // Query Tailmatch
    let (status, body) = harness.get_public_pages("q=Tailmatch").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["total"].as_i64().unwrap(), 1);
    let tail_snippet = body["items"][0]["snippet"].as_str().unwrap();
    assert!(tail_snippet.contains("Tailmatch"));
    assert!(tail_snippet.starts_with("..."));

    // Query with search term LONGER than 160 chars (e.g. 200 chars)
    let long_query = "Frontmatch".to_string() + &"a".repeat(190);
    let (status, body) = harness
        .get_public_pages(&format!("q={}", percent_encode(&long_query)))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["total"].as_i64().unwrap(), 0);
}

// ============================================================================
// 5. DOS & OVERSIZED PAYLOAD STRESS
// ============================================================================

#[tokio::test]
async fn test_adv_dos_giant_search_query_resilience() {
    let harness = ChallengerHarness::new().await;
    let sub = harness.create_subject("DoS Resilience", 1).await;
    harness
        .create_and_publish_page(&sub, "Sample Page", "Regular markdown content.")
        .await;

    // 1. Query with 10,000 ASCII characters
    let long_ascii = "a".repeat(10_000);
    let start = std::time::Instant::now();
    let (status, body) = harness.get_public_pages(&format!("q={long_ascii}")).await;
    let elapsed = start.elapsed();
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["total"].as_i64().unwrap(), 0);
    assert!(
        elapsed.as_millis() < 500,
        "10k query took too long: {}ms",
        elapsed.as_millis()
    );

    // 2. Query with 5,000 wildcards: %%%%%...
    let wildcards = "%".repeat(5_000);
    let encoded_wildcards = percent_encode(&wildcards);
    let start = std::time::Instant::now();
    let (status, body) = harness
        .get_public_pages(&format!("q={encoded_wildcards}"))
        .await;
    let elapsed = start.elapsed();
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["total"].as_i64().unwrap(), 0);
    assert!(
        elapsed.as_millis() < 500,
        "5k wildcards query took too long: {}ms",
        elapsed.as_millis()
    );

    // 3. Query with 5,000 Cyrillic characters
    let long_cyrillic = "тест".repeat(1_250);
    let encoded_cyrillic = percent_encode(&long_cyrillic);
    let start = std::time::Instant::now();
    let (status, body) = harness
        .get_public_pages(&format!("q={encoded_cyrillic}"))
        .await;
    let elapsed = start.elapsed();
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["total"].as_i64().unwrap(), 0);
    assert!(
        elapsed.as_millis() < 500,
        "5k Cyrillic query took too long: {}ms",
        elapsed.as_millis()
    );
}

#[tokio::test]
async fn test_adv_dos_pathological_markdown_stripping_and_snippets() {
    let harness = ChallengerHarness::new().await;
    let sub = harness.create_subject("Pathological Markdown", 1).await;

    let mut pathological = String::with_capacity(60_000);
    pathological.push_str("```rust\ncode fence example\n```\n");
    for _ in 0..1000 {
        pathological.push_str("[unclosed link with lots of text](http://example.com ");
    }
    pathological.push_str("\n<div class=\"");
    pathological.push_str(&"nested-div ".repeat(500));
    pathological.push_str("\">Unclosed tag\n");
    pathological.push_str("TargetSearchKeyword\n");
    pathological.push_str(&"More prose after the keyword. ".repeat(500));

    harness
        .create_and_publish_page(&sub, "Pathological Page", &pathological)
        .await;

    let start = std::time::Instant::now();
    let (status, body) = harness.get_public_pages("q=TargetSearchKeyword").await;
    let elapsed = start.elapsed();

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["total"].as_i64().unwrap(), 1);
    let snippet = body["items"][0]["snippet"].as_str().unwrap();
    assert!(snippet.contains("TargetSearchKeyword"));
    assert!(
        elapsed.as_millis() < 500,
        "Pathological markdown parsing took too long: {}ms",
        elapsed.as_millis()
    );
}
