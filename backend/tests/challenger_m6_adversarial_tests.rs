//! Adversarial Stress & Verification Harness for Milestone 6:
//! Single-Binary Axum SPA Serving, Routing Fallback, Isolation, and Traversal Defense.
//!
//! Authored by Challenger 1 (Milestone 6).

use axum::{
    body::Body,
    http::{header, Method, Request, StatusCode},
    Router,
};
use backend::{config::Config, db::init_test_db, routes::create_router, AppState};
use http_body_util::BodyExt;
use serde_json::Value;
use std::fs;
use tempfile::TempDir;
use tower::ServiceExt;

struct ChallengerHarness {
    pub app: Router,
    pub _temp_dir: TempDir,
}

impl ChallengerHarness {
    async fn new() -> Self {
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
            admin_password: Some("challenger_password_abc_123".to_string()),
            session_secret: "challenger_secret_32_chars_long_xyz!".to_string(),
            max_image_bytes: 10 * 1024 * 1024,
            max_attachment_bytes: 50 * 1024 * 1024,
        };
        config.ensure_directories().unwrap();

        let state = AppState::new(db, config);
        let app = create_router(state);

        Self {
            app,
            _temp_dir: temp_dir,
        }
    }
}

async fn body_string(response: axum::response::Response) -> String {
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    String::from_utf8_lossy(&bytes).to_string()
}

// -----------------------------------------------------------------------------
// Test 1: SPA Fallback Routing Matrix
// -----------------------------------------------------------------------------
#[tokio::test]
async fn test_spa_fallback_routing_comprehensive() {
    let harness = ChallengerHarness::new().await;
    let dist_dir = backend::routes::spa::resolve_frontend_dist_dir();
    let expected_index_html = fs::read_to_string(dist_dir.join("index.html"))
        .expect("frontend/dist/index.html must exist on disk");

    let client_routes = [
        "/",
        "/p/550e8400-e29b-41d4-a716-446655440000",
        "/p/arbitrary-slug-name",
        "/admin",
        "/admin/",
        "/admin/login",
        "/admin/pages/some-id/edit",
        "/admin/pages/some-id",
        "/admin/subjects",
        "/unknown/route",
        "/deeply/nested/spa/client/side/route/with/many/segments",
        "/catalog",
        "/tag/rust-programming",
        "/p/550e8400-e29b-41d4-a716-446655440000?filter=all&view=compact",
    ];

    for route in client_routes {
        let req = Request::builder()
            .method(Method::GET)
            .uri(route)
            .body(Body::empty())
            .unwrap();

        let response = harness.app.clone().oneshot(req).await.unwrap();

        assert_eq!(
            response.status(),
            StatusCode::OK,
            "Route '{route}' must return HTTP 200 OK"
        );

        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        assert!(
            content_type.contains("text/html"),
            "Route '{route}' Content-Type must contain text/html, got: '{content_type}'"
        );
        assert!(
            content_type.contains("charset=utf-8"),
            "Route '{route}' Content-Type must specify charset=utf-8, got: '{content_type}'"
        );

        let cache_control = response
            .headers()
            .get(header::CACHE_CONTROL)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        assert_eq!(
            cache_control, "no-cache",
            "Route '{route}' must have Cache-Control: no-cache"
        );

        let body = body_string(response).await;
        assert_eq!(
            body, expected_index_html,
            "Route '{route}' body must match frontend/dist/index.html exactly"
        );
    }
}

// -----------------------------------------------------------------------------
// Test 2: Fallback Isolation Guard Matrix (/api, /media, double-slash bypasses)
// -----------------------------------------------------------------------------
#[tokio::test]
async fn test_fallback_isolation_guard_matrix() {
    let harness = ChallengerHarness::new().await;

    let isolated_routes = [
        // Direct API paths
        "/api",
        "/api/",
        "/api/nonexistent",
        "/api/admin/nonexistent",
        "/api/pages/550e8400-e29b-41d4-a716-446655440000",
        "/api/v1/anything",
        // Direct Media paths
        "/media",
        "/media/",
        "/media/nonexistent",
        "/media/invalid-uuid-string",
        "/media/550e8400-e29b-41d4-a716-446655440000",
        "/media/nested/path/never/allowed",
        // Redundant slashes and double-slash bypasses
        "//api",
        "//api/",
        "//api/nonexistent",
        "///api",
        "///api/nonexistent",
        "////api/pages/some-id",
        "//media",
        "//media/",
        "//media/nonexistent",
        "///media",
        "///media/nonexistent",
        "////media/nested",
    ];

    for route in isolated_routes {
        let req = Request::builder()
            .method(Method::GET)
            .uri(route)
            .body(Body::empty())
            .unwrap();

        let response = harness.app.clone().oneshot(req).await.unwrap();

        assert_eq!(
            response.status(),
            StatusCode::NOT_FOUND,
            "Isolated route '{route}' MUST return HTTP 404 NOT_FOUND"
        );

        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        assert!(
            content_type.contains("application/json"),
            "Isolated route '{route}' MUST return application/json, got: '{content_type}'"
        );

        let body = body_string(response).await;
        assert!(
            !body.contains("<!doctype html>") && !body.contains("<html"),
            "Isolated route '{route}' MUST NEVER return HTML"
        );

        let json_val: Value = serde_json::from_str(&body).unwrap_or_else(|e| {
            panic!("Route '{route}' body must be valid JSON: {e}\nBody: {body}")
        });

        let code = json_val["error"]["code"]
            .as_str()
            .expect("Response must contain error.code");
        assert!(
            code == "NOT_FOUND" || code == "MEDIA_NOT_FOUND",
            "Route '{route}' code must be NOT_FOUND or MEDIA_NOT_FOUND, got: '{code}'"
        );
    }
}

// -----------------------------------------------------------------------------
// Test 3: Non-GET/HEAD Request Guard Matrix
// -----------------------------------------------------------------------------
#[tokio::test]
async fn test_non_get_unmatched_requests_matrix() {
    let harness = ChallengerHarness::new().await;

    let scenarios = [
        (Method::POST, "/"),
        (Method::POST, "/nonexistent"),
        (Method::POST, "/p/550e8400-e29b-41d4-a716-446655440000"),
        (Method::POST, "/admin"),
        (Method::POST, "/admin/login"),
        (Method::PUT, "/"),
        (Method::PUT, "/p/123"),
        (Method::PUT, "/admin/pages/some-id"),
        (Method::PUT, "/assets/malicious.js"),
        (Method::DELETE, "/"),
        (Method::DELETE, "/admin"),
        (Method::DELETE, "/p/550e8400-e29b-41d4-a716-446655440000"),
        (Method::DELETE, "/assets/app.js"),
        (Method::PATCH, "/"),
        (Method::PATCH, "/some-route"),
        (Method::PATCH, "/p/12345"),
        (Method::OPTIONS, "/arbitrary-options-path"),
    ];

    for (method, uri) in scenarios {
        let req = Request::builder()
            .method(method.clone())
            .uri(uri)
            .body(Body::empty())
            .unwrap();

        let response = harness.app.clone().oneshot(req).await.unwrap();

        assert_eq!(
            response.status(),
            StatusCode::NOT_FOUND,
            "{method} {uri} MUST return HTTP 404 NOT_FOUND"
        );

        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        assert!(
            content_type.contains("application/json"),
            "{method} {uri} MUST return application/json, got: {content_type}"
        );

        let body = body_string(response).await;
        assert!(
            !body.contains("<html"),
            "{method} {uri} MUST NEVER return HTML"
        );

        let json_val: Value = serde_json::from_str(&body)
            .unwrap_or_else(|e| panic!("{method} {uri} body must be valid JSON: {e}\nGot: {body}"));

        assert_eq!(
            json_val["error"]["code"], "NOT_FOUND",
            "{method} {uri} error code must be NOT_FOUND"
        );
    }
}

// -----------------------------------------------------------------------------
// Test 4: Path Traversal Attack Defense Matrix (26 vectors)
// -----------------------------------------------------------------------------
#[tokio::test]
async fn test_path_traversal_attack_matrix() {
    let harness = ChallengerHarness::new().await;

    let traversal_vectors = [
        "/assets/../../Cargo.toml",
        "/assets/..%2f..%2fCargo.toml",
        "/assets/%2e%2e/%2e%2e/Cargo.toml",
        "/assets/%2E%2E/%2E%2E/Cargo.toml",
        "/assets/..%5c..%5cCargo.toml",
        "/assets/..%5C..%5CCargo.toml",
        "/assets/%2e%2e%5c%2e%2e%5cCargo.toml",
        "/assets/%2E%2E%5C%2E%2E%5CCargo.toml",
        "/assets/..%252f..%252fCargo.toml",
        "/assets/%252e%252e/%252e%252e/Cargo.toml",
        "/..%2f..%2fCargo.toml",
        "/../../Cargo.toml",
        "..\\..\\Cargo.toml",
        "/assets/%00Cargo.toml",
        "/%00index.html",
        "/..",
        "/../",
        "/%2e%2e",
        "/%2e%2e/",
        "/%252e%252e",
        "/assets/./../Cargo.toml",
        "/assets/....//....//Cargo.toml",
        "/assets/..;/..;/Cargo.toml",
        "/assets/..%00/Cargo.toml",
        "/assets/..\\..\\src\\main.rs",
        "/assets/%2e%2e/%2e%2e/src/main.rs",
    ];

    let mut processed_count = 0;
    let mut parser_rejected_count = 0;

    for vector in traversal_vectors {
        let req_res = Request::builder()
            .method(Method::GET)
            .uri(vector)
            .body(Body::empty());

        let req = match req_res {
            Ok(r) => r,
            Err(e) => {
                parser_rejected_count += 1;
                println!("Vector '{vector}' rejected at HTTP parser level: {e}");
                continue;
            }
        };

        let response = harness.app.clone().oneshot(req).await.unwrap();
        let status = response.status();
        processed_count += 1;
        println!("Vector '{vector}' -> HTTP {status}");

        assert!(
            status == StatusCode::BAD_REQUEST || status == StatusCode::NOT_FOUND,
            "Traversal vector '{vector}' MUST return 400 or 404, got: {status}"
        );

        let body = body_string(response).await;
        // Verify NO sensitive repository files leaked
        assert!(
            !body.contains("[package]") && !body.contains("name = \"backend\""),
            "Traversal vector '{vector}' leaked Cargo.toml!"
        );
        assert!(
            !body.contains("fn main()") && !body.contains("pub fn create_router"),
            "Traversal vector '{vector}' leaked Rust source code!"
        );

        // If 400 Bad Request returned, verify valid JSON error structure
        if status == StatusCode::BAD_REQUEST {
            let json_val: Result<Value, _> = serde_json::from_str(&body);
            assert!(
                json_val.is_ok(),
                "Vector '{vector}' 400 response must be JSON, got: {body}"
            );
            assert_eq!(json_val.unwrap()["error"]["code"], "BAD_REQUEST");
        }
    }

    println!("Total processed traversal vectors: {processed_count}, parser rejected: {parser_rejected_count}");
    assert!(
        processed_count >= 20,
        "Must test at least 20 traversal vectors"
    );
}

// -----------------------------------------------------------------------------
// Test 5: Asset Missing Guard Matrix
// -----------------------------------------------------------------------------
#[tokio::test]
async fn test_asset_missing_guard_matrix() {
    let harness = ChallengerHarness::new().await;

    let missing_asset_uris = [
        "/assets/nonexistent_file_98765.js",
        "/assets/missing.css",
        "/assets/sub/deep/nonexistent.png",
        "/assets",
        "/assets/",
        "/assets///",
        "/assets/bundle.missing.hash.js",
        "/assets/fonts/nonexistent.woff2",
    ];

    for uri in missing_asset_uris {
        let req = Request::builder()
            .method(Method::GET)
            .uri(uri)
            .body(Body::empty())
            .unwrap();

        let response = harness.app.clone().oneshot(req).await.unwrap();

        assert_eq!(
            response.status(),
            StatusCode::NOT_FOUND,
            "Missing asset '{uri}' must return 404 NOT_FOUND"
        );

        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        assert_eq!(
            content_type, "text/plain; charset=utf-8",
            "Missing asset '{uri}' Content-Type must be text/plain; charset=utf-8"
        );

        let body = body_string(response).await;
        assert_eq!(
            body, "Asset not found",
            "Missing asset '{uri}' body must be exactly 'Asset not found'"
        );
    }
}

// -----------------------------------------------------------------------------
// Test 6: Static Asset Serving & Immutable Caching Matrix
// -----------------------------------------------------------------------------
#[tokio::test]
async fn test_static_asset_serving_and_immutable_caching_matrix() {
    let harness = ChallengerHarness::new().await;
    let dist_dir = backend::routes::spa::resolve_frontend_dist_dir();
    let dist_assets_dir = dist_dir.join("assets");

    assert!(
        dist_assets_dir.exists(),
        "Assets dir {:?} must exist",
        dist_assets_dir
    );

    let entries = fs::read_dir(&dist_assets_dir).unwrap();
    let mut tested_count = 0;

    for entry in entries {
        let entry = entry.unwrap();
        let filename = entry.file_name().to_string_lossy().to_string();
        let file_path = entry.path();

        if !file_path.is_file() {
            continue;
        }

        let uri = format!("/assets/{filename}");
        let req = Request::builder()
            .method(Method::GET)
            .uri(&uri)
            .body(Body::empty())
            .unwrap();

        let response = harness.app.clone().oneshot(req).await.unwrap();

        assert_eq!(
            response.status(),
            StatusCode::OK,
            "Asset '{uri}' must return 200 OK"
        );

        let cache_control = response
            .headers()
            .get(header::CACHE_CONTROL)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        assert_eq!(
            cache_control, "public, max-age=31536000, immutable",
            "Asset '{uri}' must have immutable Cache-Control"
        );

        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();

        if filename.ends_with(".js") {
            assert!(
                content_type.contains("application/javascript"),
                "JS asset '{uri}' must have javascript MIME, got: '{content_type}'"
            );
        } else if filename.ends_with(".css") {
            assert!(
                content_type.contains("text/css"),
                "CSS asset '{uri}' must have css MIME, got: '{content_type}'"
            );
        }

        let body_bytes = response.into_body().collect().await.unwrap().to_bytes();
        let expected_bytes = fs::read(&file_path).unwrap();
        assert_eq!(
            body_bytes.as_ref(),
            expected_bytes.as_slice(),
            "Asset '{uri}' body must match on-disk file bytes"
        );

        tested_count += 1;
    }

    assert!(
        tested_count >= 2,
        "Expected at least 2 compiled assets in frontend/dist/assets, tested {tested_count}"
    );
}

// -----------------------------------------------------------------------------
// Test 7: HEAD Request Invariance Matrix
// -----------------------------------------------------------------------------
#[tokio::test]
async fn test_head_request_invariance() {
    let harness = ChallengerHarness::new().await;

    // HEAD /
    let req = Request::builder()
        .method(Method::HEAD)
        .uri("/")
        .body(Body::empty())
        .unwrap();
    let response = harness.app.clone().oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response
        .headers()
        .get(header::CONTENT_TYPE)
        .unwrap()
        .to_str()
        .unwrap()
        .contains("text/html"));
    assert_eq!(
        response.headers().get(header::CACHE_CONTROL).unwrap(),
        "no-cache"
    );
    let body = body_string(response).await;
    assert!(body.is_empty(), "HEAD / body must be empty");

    // HEAD /p/550e8400-e29b-41d4-a716-446655440000
    let req = Request::builder()
        .method(Method::HEAD)
        .uri("/p/550e8400-e29b-41d4-a716-446655440000")
        .body(Body::empty())
        .unwrap();
    let response = harness.app.clone().oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = body_string(response).await;
    assert!(body.is_empty(), "HEAD /p/:id body must be empty");

    // HEAD /api/nonexistent -> 404
    let req = Request::builder()
        .method(Method::HEAD)
        .uri("/api/nonexistent")
        .body(Body::empty())
        .unwrap();
    let response = harness.app.clone().oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

// -----------------------------------------------------------------------------
// Test 8: High Concurrency / Rapid Probing Stability
// -----------------------------------------------------------------------------
#[tokio::test]
async fn test_concurrent_adversarial_requests() {
    let harness = ChallengerHarness::new().await;
    let mut handles = Vec::new();

    for i in 0..100 {
        let app = harness.app.clone();
        let handle = tokio::spawn(async move {
            let (method, uri, expected_status) = match i % 5 {
                0 => (Method::GET, "/", StatusCode::OK),
                1 => (Method::GET, "/api/nonexistent", StatusCode::NOT_FOUND),
                2 => (Method::POST, "/p/test", StatusCode::NOT_FOUND),
                3 => (
                    Method::GET,
                    "/assets/../../Cargo.toml",
                    StatusCode::BAD_REQUEST,
                ),
                _ => (Method::GET, "/assets/nonexistent.js", StatusCode::NOT_FOUND),
            };

            let req = Request::builder()
                .method(method)
                .uri(uri)
                .body(Body::empty())
                .unwrap();

            let resp = app.oneshot(req).await.unwrap();
            assert_eq!(
                resp.status(),
                expected_status,
                "Concurrent req {i} to {uri} failed status expectation"
            );
        });
        handles.push(handle);
    }

    for handle in handles {
        handle.await.unwrap();
    }
}

// -----------------------------------------------------------------------------
// Test 9: Direct index.html Caching & Case Invariance Matrix
// -----------------------------------------------------------------------------
#[tokio::test]
async fn test_direct_index_html_caching_and_case_variants() {
    let harness = ChallengerHarness::new().await;

    let index_variants = [
        "/index.html",
        "/Index.html",
        "/INDEX.HTML",
        "/index.HTML",
        "/Index.Html",
        "//index.html",
        "///index.html",
    ];

    for route in index_variants {
        // 1. GET
        let req = Request::builder()
            .method(Method::GET)
            .uri(route)
            .body(Body::empty())
            .unwrap();

        let response = harness.app.clone().oneshot(req).await.unwrap();

        assert_eq!(
            response.status(),
            StatusCode::OK,
            "Route '{route}' must return HTTP 200 OK"
        );

        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        assert!(
            content_type.contains("text/html"),
            "Route '{route}' Content-Type must be text/html, got: '{content_type}'"
        );
        assert!(
            content_type.contains("charset=utf-8"),
            "Route '{route}' Content-Type must specify charset=utf-8, got: '{content_type}'"
        );

        let cache_control = response
            .headers()
            .get(header::CACHE_CONTROL)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        assert_eq!(
            cache_control, "no-cache",
            "Route '{route}' MUST return Cache-Control: no-cache, got '{cache_control}'"
        );

        let body = body_string(response).await;
        assert!(
            body.contains("<!doctype html>") || body.contains("<html"),
            "Route '{route}' body must be index.html, got: {body}"
        );

        // 2. HEAD
        let head_req = Request::builder()
            .method(Method::HEAD)
            .uri(route)
            .body(Body::empty())
            .unwrap();

        let head_resp = harness.app.clone().oneshot(head_req).await.unwrap();
        assert_eq!(
            head_resp.status(),
            StatusCode::OK,
            "HEAD '{route}' must return 200 OK"
        );
        assert_eq!(
            head_resp
                .headers()
                .get(header::CACHE_CONTROL)
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default(),
            "no-cache",
            "HEAD '{route}' must return Cache-Control: no-cache"
        );
        let head_body = body_string(head_resp).await;
        assert!(
            head_body.is_empty(),
            "HEAD '{route}' body must be completely empty"
        );
    }
}

// -----------------------------------------------------------------------------
// Test 10: Case-Insensitive API & Media Isolation Guard Matrix
// -----------------------------------------------------------------------------
#[tokio::test]
async fn test_case_insensitive_api_and_media_guard_matrix() {
    let harness = ChallengerHarness::new().await;

    let test_cases = [
        // API uppercase and mixed case
        "/API",
        "/API/",
        "/API/nonexistent",
        "/Api/v1",
        "/aPi/endpoint",
        "/apI/something",
        "/API/pages/some-id",
        "/API/v1/auth/login",
        "/Api/pages?limit=10",
        // Media uppercase and mixed case
        "/MEDIA",
        "/MEDIA/",
        "/MEDIA/some-id",
        "/Media/some-id",
        "/mEdIa/some-id",
        "/MEDIA/550e8400-e29b-41d4-a716-446655440000",
        "/Media/550e8400-e29b-41d4-a716-446655440000",
        "/MEDIA/nested/path",
        // Multi-slash uppercase combinations
        "//API/xyz",
        "//API/nonexistent",
        "///Api/v1",
        "////API/endpoint",
        "//MEDIA/xyz",
        "//Media/some-id",
        "///MEDIA/test",
        "////Media/nested",
    ];

    for route in test_cases {
        let req = Request::builder()
            .method(Method::GET)
            .uri(route)
            .body(Body::empty())
            .unwrap();

        let response = harness.app.clone().oneshot(req).await.unwrap();

        assert_eq!(
            response.status(),
            StatusCode::NOT_FOUND,
            "Route '{route}' MUST return HTTP 404 NOT_FOUND"
        );

        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        assert!(
            content_type.contains("application/json"),
            "Route '{route}' Content-Type must be application/json, got: '{content_type}'"
        );

        let body = body_string(response).await;
        assert!(
            !body.contains("<html") && !body.contains("<!doctype html>"),
            "Route '{route}' must NEVER return HTML"
        );

        let json_val: Value = serde_json::from_str(&body).unwrap_or_else(|e| {
            panic!("Route '{route}' body must be valid JSON: {e}\nGot: {body}")
        });

        let code = json_val["error"]["code"].as_str().unwrap_or_default();
        assert!(
            code == "NOT_FOUND" || code == "MEDIA_NOT_FOUND",
            "Route '{route}' error code must be NOT_FOUND or MEDIA_NOT_FOUND, got: '{code}'"
        );
        let message = json_val["error"]["message"].as_str().unwrap_or_default();
        assert!(
            !message.is_empty(),
            "Route '{route}' error message must not be empty"
        );
    }
}

// -----------------------------------------------------------------------------
// Test 11: Malformed Percent Encoding and Traversal Safe Fuzzing Matrix
// -----------------------------------------------------------------------------
#[tokio::test]
async fn test_malformed_percent_encoding_and_traversal_fuzzing() {
    let harness = ChallengerHarness::new().await;

    // 1. Malformed percent sequences in SPA routes: MUST NOT PANIC, return 200 index.html with no-cache
    let spa_malformed = [
        "/%2g",
        "/%g2",
        "/%",
        "/%2",
        "/%gg",
        "/%zz",
        "/%ff",
        "/p/%2g",
        "/admin/%",
        "/catalog/%2z",
        "/search?q=%2g",
    ];

    for uri in spa_malformed {
        let req = Request::builder()
            .method(Method::GET)
            .uri(uri)
            .body(Body::empty())
            .unwrap();

        let response = harness.app.clone().oneshot(req).await.unwrap();

        assert_eq!(
            response.status(),
            StatusCode::OK,
            "Malformed SPA URI '{uri}' must safely return 200 OK"
        );

        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        assert!(
            content_type.contains("text/html"),
            "Malformed SPA URI '{uri}' must return text/html"
        );

        let cache_control = response
            .headers()
            .get(header::CACHE_CONTROL)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        assert_eq!(
            cache_control, "no-cache",
            "Malformed SPA URI '{uri}' must have Cache-Control: no-cache"
        );
    }

    // 2. Dangerous null-byte, dot-encoding (%2e), and traversal sequences: MUST return 400 Bad Request JSON
    let dangerous = [
        "/%00",
        "/%00index.html",
        "/%2e%2e",
        "/%2e%2e/",
        "/%252e%252e",
        "/%2%2e",
        "/%%2e",
        "/assets/%2e%2e",
        "/..%2f..%2f",
    ];

    for uri in dangerous {
        let req = Request::builder()
            .method(Method::GET)
            .uri(uri)
            .body(Body::empty())
            .unwrap();

        let response = harness.app.clone().oneshot(req).await.unwrap();

        assert_eq!(
            response.status(),
            StatusCode::BAD_REQUEST,
            "Dangerous URI '{uri}' must return 400 Bad Request"
        );

        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        assert!(
            content_type.contains("application/json"),
            "Dangerous URI '{uri}' must return application/json"
        );

        let body = body_string(response).await;
        let json_val: Value = serde_json::from_str(&body).unwrap_or_else(|e| {
            panic!("Dangerous URI '{uri}' body must be valid JSON: {e}\nGot: {body}")
        });
        assert_eq!(json_val["error"]["code"], "BAD_REQUEST");
    }

    // 3. API malformed routes: MUST return 404 JSON, never 200 or HTML
    let api_malformed = [
        "/api/%2g",
        "/API/%2g",
        "/Api/%",
        "//API/%2g",
        "/media/%2g",
        "/MEDIA/%",
    ];

    for uri in api_malformed {
        let req = Request::builder()
            .method(Method::GET)
            .uri(uri)
            .body(Body::empty())
            .unwrap();

        let response = harness.app.clone().oneshot(req).await.unwrap();

        assert_eq!(
            response.status(),
            StatusCode::NOT_FOUND,
            "API malformed URI '{uri}' must return 404 Not Found"
        );

        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        assert!(
            content_type.contains("application/json"),
            "API malformed URI '{uri}' must return application/json"
        );

        let body = body_string(response).await;
        assert!(
            !body.contains("<html"),
            "API malformed URI '{uri}' must never return HTML"
        );
    }
}

// -----------------------------------------------------------------------------
// Test 12: Adversarial Query Params, Windows ADS, and Hostile Boundary Probing
// -----------------------------------------------------------------------------
#[tokio::test]
async fn test_adversarial_query_params_and_ntfs_streams_and_boundary_checks() {
    let harness = ChallengerHarness::new().await;

    // 1. Query parameters on API and Media isolation routes
    let query_isolated = [
        "/api?foo=bar",
        "/api/?foo=bar",
        "/API?foo=bar",
        "/Api/v1?page=2&filter=none",
        "//api?foo=bar",
        "///api?foo=bar",
        "/media?download=true",
        "/media/?download=true",
        "/MEDIA?id=123",
        "/Media/550e8400-e29b-41d4-a716-446655440000?inline=1",
        "//media?token=secret",
    ];

    for uri in query_isolated {
        let req = Request::builder()
            .method(Method::GET)
            .uri(uri)
            .body(Body::empty())
            .unwrap();

        let response = harness.app.clone().oneshot(req).await.unwrap();

        assert_eq!(
            response.status(),
            StatusCode::NOT_FOUND,
            "Query isolated URI '{uri}' MUST return 404 NOT_FOUND"
        );

        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        assert!(
            content_type.contains("application/json"),
            "Query isolated URI '{uri}' MUST return application/json, got: {content_type}"
        );

        let body = body_string(response).await;
        assert!(
            !body.contains("<html"),
            "Query isolated URI '{uri}' MUST NOT return HTML"
        );

        let json_val: Value = serde_json::from_str(&body)
            .unwrap_or_else(|e| panic!("Query isolated URI '{uri}' must return JSON: {e}"));
        let code = json_val["error"]["code"].as_str().unwrap_or_default();
        assert!(code == "NOT_FOUND" || code == "MEDIA_NOT_FOUND");
    }

    // 2. Traversal with query parameters
    let traversal_queries = [
        "/assets/../../Cargo.toml?param=1",
        "/assets/..%2f..%2fCargo.toml?v=2",
        "/..%2f..%2fCargo.toml?secret=true",
    ];

    for uri in traversal_queries {
        let req = Request::builder()
            .method(Method::GET)
            .uri(uri)
            .body(Body::empty())
            .unwrap();

        let response = harness.app.clone().oneshot(req).await.unwrap();
        assert!(
            response.status() == StatusCode::BAD_REQUEST
                || response.status() == StatusCode::NOT_FOUND
        );

        let body = body_string(response).await;
        assert!(
            !body.contains("[package]"),
            "Query traversal URI '{uri}' leaked Cargo.toml!"
        );
    }

    // 3. Probing Windows NTFS Alternate Data Streams (::$DATA)
    let ads_uris = ["/index.html::$DATA", "/assets/index.html::$DATA"];

    for uri in ads_uris {
        let req_opt = Request::builder()
            .method(Method::GET)
            .uri(uri)
            .body(Body::empty());

        if let Ok(req) = req_opt {
            let response = harness.app.clone().oneshot(req).await.unwrap();
            let status = response.status();
            let body = body_string(response).await;
            println!(
                "NTFS ADS probe '{uri}' -> Status {status}, Body len: {}",
                body.len()
            );
            // Ensure no backend source or configuration is leaked
            assert!(!body.contains("[package]"));
            assert!(!body.contains("fn main()"));
        }
    }
}
