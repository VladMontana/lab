//! Integration tests for Milestone 6: Single-Binary Serving & SPA Fallback.
//! Verifies:
//! 1. Root `/` and SPA client-side routes return 200 with `index.html` and `Cache-Control: no-cache`.
//! 2. Static assets in `/assets/*` return 200 with appropriate MIME and `Cache-Control: public, max-age=31536000, immutable`.
//! 3. Missing static assets in `/assets/*` return 404 text, NOT `index.html`.
//! 4. 3-layer path traversal defense rejecting traversal sequences with 400 Bad Request without leaking files.
//! 5. Unmatched `/api/*` and `/media/*` routes (including double-slash `//api/...` and `//media/...`) return JSON 404 envelope.
//! 6. Non-GET/HEAD unmatched requests return JSON 404 envelope.
//! 7. HEAD requests return headers without body.

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

struct TestHarness {
    pub app: Router,
    pub _temp_dir: TempDir,
}

impl TestHarness {
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
            admin_password: Some("admin_test_password_123".to_string()),
            session_secret: "session_secret_32_chars_for_m6_tests".to_string(),
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

async fn response_body_string(response: axum::response::Response) -> String {
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    String::from_utf8_lossy(&bytes).to_string()
}

#[tokio::test]
async fn test_spa_fallback_routes_return_index_html_with_no_cache() {
    let harness = TestHarness::new().await;

    let routes = [
        "/",
        "/index.html",
        "/p/550e8400-e29b-41d4-a716-446655440000",
        "/admin",
        "/admin/login",
        "/admin/pages/some-id",
        "/some/arbitrary/frontend/route",
    ];

    for route in routes {
        let req = Request::builder()
            .method(Method::GET)
            .uri(route)
            .body(Body::empty())
            .unwrap();

        let response = harness.app.clone().oneshot(req).await.unwrap();

        assert_eq!(
            response.status(),
            StatusCode::OK,
            "Route '{route}' should return 200 OK"
        );

        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        assert!(
            content_type.contains("text/html"),
            "Route '{route}' should return text/html, got '{content_type}'"
        );

        let cache_control = response
            .headers()
            .get(header::CACHE_CONTROL)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        assert_eq!(
            cache_control, "no-cache",
            "Route '{route}' should have Cache-Control: no-cache"
        );

        let body = response_body_string(response).await;
        assert!(
            body.contains("<!doctype html>") || body.contains("<html"),
            "Route '{route}' body should be index.html, got: {body}"
        );
    }
}

#[tokio::test]
async fn test_spa_head_request_returns_headers_without_body() {
    let harness = TestHarness::new().await;

    let req = Request::builder()
        .method(Method::HEAD)
        .uri("/")
        .body(Body::empty())
        .unwrap();

    let response = harness.app.clone().oneshot(req).await.unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    assert!(content_type.contains("text/html"));

    let cache_control = response
        .headers()
        .get(header::CACHE_CONTROL)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    assert_eq!(cache_control, "no-cache");

    let body = response_body_string(response).await;
    assert!(
        body.is_empty(),
        "HEAD request body must be empty, got: {body}"
    );
}

#[tokio::test]
async fn test_static_asset_serving_and_immutable_caching() {
    let harness = TestHarness::new().await;

    // Discover existing assets in resolved frontend dist assets
    let dist_dir = backend::routes::spa::resolve_frontend_dist_dir();
    let dist_assets_dir = dist_dir.join("assets");
    assert!(
        dist_assets_dir.exists(),
        "frontend dist assets directory must exist at {:?}",
        dist_assets_dir
    );

    let mut js_file = None;
    let mut css_file = None;

    for entry in fs::read_dir(&dist_assets_dir).unwrap() {
        let entry = entry.unwrap();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.ends_with(".js") && js_file.is_none() {
            js_file = Some(name);
        } else if name.ends_with(".css") && css_file.is_none() {
            css_file = Some(name);
        }
    }

    let js_filename = js_file.expect("At least one .js asset should exist in frontend/dist/assets");
    let css_filename =
        css_file.expect("At least one .css asset should exist in frontend/dist/assets");

    // Test JS asset
    let js_uri = format!("/assets/{js_filename}");
    let req = Request::builder()
        .method(Method::GET)
        .uri(&js_uri)
        .body(Body::empty())
        .unwrap();

    let response = harness.app.clone().oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    assert!(
        content_type.contains("application/javascript"),
        "Expected javascript content type, got: {content_type}"
    );

    let cache_control = response
        .headers()
        .get(header::CACHE_CONTROL)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    assert_eq!(
        cache_control, "public, max-age=31536000, immutable",
        "Asset must have immutable cache header"
    );

    let body = response_body_string(response).await;
    assert!(!body.is_empty(), "Asset body should not be empty");

    // Test CSS asset
    let css_uri = format!("/assets/{css_filename}");
    let req = Request::builder()
        .method(Method::GET)
        .uri(&css_uri)
        .body(Body::empty())
        .unwrap();

    let response = harness.app.clone().oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    assert!(
        content_type.contains("text/css"),
        "Expected css content type, got: {content_type}"
    );

    let cache_control = response
        .headers()
        .get(header::CACHE_CONTROL)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    assert_eq!(
        cache_control, "public, max-age=31536000, immutable",
        "Asset must have immutable cache header"
    );
}

#[tokio::test]
async fn test_missing_assets_return_404_not_html() {
    let harness = TestHarness::new().await;

    let missing_asset_uris = [
        "/assets/nonexistent_file_12345.js",
        "/assets/missing.css",
        "/assets/sub/deep/nonexistent.png",
        "/assets",
        "/assets/",
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
            "Missing asset '{uri}' must return 404"
        );

        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        assert!(
            content_type.contains("text/plain"),
            "Missing asset response content type must be text/plain, got: {content_type}"
        );

        let body = response_body_string(response).await;
        assert_eq!(
            body, "Asset not found",
            "Missing asset must NOT return index.html"
        );
    }
}

#[tokio::test]
async fn test_path_traversal_rejection() {
    let harness = TestHarness::new().await;

    let traversal_vectors = [
        "/assets/../../Cargo.toml",
        "/assets/..%2f..%2fCargo.toml",
        "/assets/%2e%2e/%2e%2e/Cargo.toml",
        "/assets/%2E%2E/%2E%2E/Cargo.toml",
        "/assets/..\\..\\Cargo.toml",
        "/assets/%2e%2e%5c%2e%2e%5cCargo.toml",
        "/../../Cargo.toml",
        "/..%2f..%2fCargo.toml",
        "/..",
        "/../",
        "/%2e%2e",
        "/%2e%2e/",
        "/%00index.html",
        "/assets/%00something.js",
    ];

    for vector in traversal_vectors {
        let req = Request::builder()
            .method(Method::GET)
            .uri(vector)
            .body(Body::empty())
            .unwrap();

        let response = harness.app.clone().oneshot(req).await.unwrap();
        let status = response.status();

        // Must reject with 400 Bad Request or 404 Not Found, never 200 OK
        assert!(
            status == StatusCode::BAD_REQUEST || status == StatusCode::NOT_FOUND,
            "Vector '{vector}' must return 400 or 404, got: {status}"
        );

        let body = response_body_string(response).await;
        assert!(
            !body.contains("[package]") && !body.contains("name = \"backend\""),
            "Traversal vector '{vector}' leaked Cargo.toml contents!"
        );

        // If 400 Bad Request was returned, verify JSON error envelope
        if status == StatusCode::BAD_REQUEST {
            let json_val: Result<Value, _> = serde_json::from_str(&body);
            assert!(
                json_val.is_ok(),
                "400 Bad Request response must be valid JSON envelope"
            );
            let val = json_val.unwrap();
            assert_eq!(val["error"]["code"], "BAD_REQUEST");
        }
    }
}

#[tokio::test]
async fn test_fallback_guard_isolation_and_double_slash() {
    let harness = TestHarness::new().await;

    let api_and_media_routes = [
        "/api",
        "/api/",
        "/api/nonexistent",
        "/api/pages/some-unknown-id",
        "//api",
        "//api/",
        "//api/nonexistent",
        "///api/nonexistent",
        "/API",
        "/API/",
        "/API/nonexistent",
        "/Api/v1",
        "//API/nonexistent",
        "//API/endpoint",
        "///Api/test",
        "/media",
        "/media/",
        "/media/nonexistent",
        "/media/550e8400-e29b-41d4-a716-446655440000",
        "//media",
        "//media/",
        "//media/nonexistent",
        "///media/nonexistent",
        "/MEDIA",
        "/MEDIA/",
        "/MEDIA/xyz",
        "/Media/550e8400-e29b-41d4-a716-446655440000",
        "//MEDIA/endpoint",
        "//Media/nonexistent",
        "///Media/test",
    ];

    for route in api_and_media_routes {
        let req = Request::builder()
            .method(Method::GET)
            .uri(route)
            .body(Body::empty())
            .unwrap();

        let response = harness.app.clone().oneshot(req).await.unwrap();

        assert_eq!(
            response.status(),
            StatusCode::NOT_FOUND,
            "Route '{route}' must return 404 Not Found"
        );

        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        assert!(
            content_type.contains("application/json"),
            "Route '{route}' must return application/json, got '{content_type}'"
        );

        let body = response_body_string(response).await;
        let json_val: Value = serde_json::from_str(&body).unwrap_or_else(|e| {
            panic!("Route '{route}' body must be valid JSON: {e}\nGot: {body}")
        });

        let code = json_val["error"]["code"].as_str().unwrap_or_default();
        assert!(
            code == "NOT_FOUND" || code == "MEDIA_NOT_FOUND",
            "Route '{route}' error code must be NOT_FOUND or MEDIA_NOT_FOUND, got: '{code}'"
        );
        assert!(
            !body.contains("<html"),
            "Route '{route}' must never return HTML"
        );
    }
}

#[tokio::test]
async fn test_non_get_unmatched_requests_return_json_404() {
    let harness = TestHarness::new().await;

    let non_get_scenarios = [
        (Method::POST, "/nonexistent"),
        (Method::POST, "/"),
        (Method::PUT, "/p/123"),
        (Method::DELETE, "/admin"),
        (Method::PATCH, "/random-endpoint"),
    ];

    for (method, uri) in non_get_scenarios {
        let req = Request::builder()
            .method(method.clone())
            .uri(uri)
            .body(Body::empty())
            .unwrap();

        let response = harness.app.clone().oneshot(req).await.unwrap();

        assert_eq!(
            response.status(),
            StatusCode::NOT_FOUND,
            "{method} {uri} must return 404 Not Found"
        );

        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        assert!(
            content_type.contains("application/json"),
            "{method} {uri} must return application/json, got: {content_type}"
        );

        let body = response_body_string(response).await;
        let json_val: Value = serde_json::from_str(&body)
            .unwrap_or_else(|e| panic!("{method} {uri} body must be valid JSON: {e}\nGot: {body}"));

        assert_eq!(json_val["error"]["code"], "NOT_FOUND");
    }
}

#[tokio::test]
async fn test_spa_direct_index_html_returns_200_no_cache() {
    let harness = TestHarness::new().await;

    // 1. GET /index.html
    let req = Request::builder()
        .method(Method::GET)
        .uri("/index.html")
        .body(Body::empty())
        .unwrap();

    let response = harness.app.clone().oneshot(req).await.unwrap();

    assert_eq!(
        response.status(),
        StatusCode::OK,
        "GET /index.html must return HTTP 200 OK"
    );

    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    assert!(
        content_type.contains("text/html"),
        "GET /index.html Content-Type must be text/html, got '{content_type}'"
    );
    assert!(
        content_type.contains("charset=utf-8"),
        "GET /index.html Content-Type must specify charset=utf-8, got '{content_type}'"
    );

    let cache_control = response
        .headers()
        .get(header::CACHE_CONTROL)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    assert_eq!(
        cache_control, "no-cache",
        "GET /index.html must have Cache-Control: no-cache, got '{cache_control}'"
    );

    let body = response_body_string(response).await;
    assert!(
        body.contains("<!doctype html>") || body.contains("<html"),
        "GET /index.html body should be index.html, got: {body}"
    );

    // 2. HEAD /index.html
    let head_req = Request::builder()
        .method(Method::HEAD)
        .uri("/index.html")
        .body(Body::empty())
        .unwrap();

    let head_resp = harness.app.clone().oneshot(head_req).await.unwrap();
    assert_eq!(head_resp.status(), StatusCode::OK);
    assert!(head_resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .contains("text/html"));
    assert_eq!(
        head_resp
            .headers()
            .get(header::CACHE_CONTROL)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default(),
        "no-cache"
    );
    let head_body = response_body_string(head_resp).await;
    assert!(head_body.is_empty(), "HEAD /index.html body must be empty");
}

#[tokio::test]
async fn test_fallback_guard_case_variations_and_isolation() {
    let harness = TestHarness::new().await;

    let case_variations = [
        "/api",
        "/API",
        "/Api",
        "/API/nonexistent",
        "/Api/v1",
        "/API/pages/some-id",
        "//API/endpoint",
        "//Api/v1",
        "///API/test",
        "/media",
        "/MEDIA",
        "/Media",
        "/MEDIA/xyz",
        "/Media/xyz",
        "/MEDIA/550e8400-e29b-41d4-a716-446655440000",
        "//MEDIA/xyz",
        "//Media/nonexistent",
        "///MEDIA/endpoint",
    ];

    for route in case_variations {
        let req = Request::builder()
            .method(Method::GET)
            .uri(route)
            .body(Body::empty())
            .unwrap();

        let response = harness.app.clone().oneshot(req).await.unwrap();

        assert_eq!(
            response.status(),
            StatusCode::NOT_FOUND,
            "Route '{route}' must return HTTP 404 NOT_FOUND"
        );

        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        assert!(
            content_type.contains("application/json"),
            "Route '{route}' Content-Type must be application/json, got '{content_type}'"
        );

        let body = response_body_string(response).await;
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
            "Route '{route}' error code must be NOT_FOUND or MEDIA_NOT_FOUND, got '{code}'"
        );
        let message = json_val["error"]["message"].as_str().unwrap_or_default();
        assert!(
            !message.is_empty(),
            "Route '{route}' error message must not be empty"
        );
    }
}

#[tokio::test]
async fn test_malformed_percent_encoding_safe_handling() {
    let harness = TestHarness::new().await;

    // 1. SPA routes with malformed percent sequences: must NOT panic, must return 200 index.html with no-cache
    let spa_malformed_routes = [
        "/%2g",
        "/%",
        "/%2",
        "/%gg",
        "/%zz",
        "/%ff",
        "/p/%2g",
        "/catalog/%",
        "/search?q=%2g",
    ];

    for uri in spa_malformed_routes {
        let req = Request::builder()
            .method(Method::GET)
            .uri(uri)
            .body(Body::empty())
            .unwrap();

        let response = harness.app.clone().oneshot(req).await.unwrap();

        assert_eq!(
            response.status(),
            StatusCode::OK,
            "Malformed URI '{uri}' must safely return 200 OK"
        );

        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        assert!(
            content_type.contains("text/html"),
            "Malformed URI '{uri}' must return text/html, got '{content_type}'"
        );

        let cache_control = response
            .headers()
            .get(header::CACHE_CONTROL)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        assert_eq!(
            cache_control, "no-cache",
            "Malformed URI '{uri}' must have Cache-Control: no-cache"
        );

        let body = response_body_string(response).await;
        assert!(
            body.contains("<!doctype html>") || body.contains("<html"),
            "Malformed URI '{uri}' must return index.html without panicking"
        );
    }

    // 2. Dangerous null-byte and traversal sequences: must safely return 400 Bad Request JSON
    let dangerous_sequences = ["/%00", "/%00index.html", "/%2e%2e", "/%2e%2e/"];

    for uri in dangerous_sequences {
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

        let body = response_body_string(response).await;
        let json_val: Value = serde_json::from_str(&body).unwrap_or_else(|e| {
            panic!("Dangerous URI '{uri}' body must be valid JSON: {e}\nGot: {body}")
        });
        assert_eq!(json_val["error"]["code"], "BAD_REQUEST");
    }

    // 3. Static asset paths with malformed percent sequences: must return 404 text/plain Asset not found
    let asset_malformed = ["/assets/%2g", "/assets/%"];

    for uri in asset_malformed {
        let req = Request::builder()
            .method(Method::GET)
            .uri(uri)
            .body(Body::empty())
            .unwrap();

        let response = harness.app.clone().oneshot(req).await.unwrap();

        assert_eq!(
            response.status(),
            StatusCode::NOT_FOUND,
            "Asset URI '{uri}' must return 404"
        );
        let body = response_body_string(response).await;
        assert_eq!(body, "Asset not found");
    }

    // 4. API paths with malformed percent sequences: must return 404 JSON NOT_FOUND
    let api_malformed = ["/api/%2g", "/API/%2g", "/api/%"];

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
            "API URI '{uri}' must return 404 JSON"
        );
        let body = response_body_string(response).await;
        let json_val: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(json_val["error"]["code"], "NOT_FOUND");
    }
}
