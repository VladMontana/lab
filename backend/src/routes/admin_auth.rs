//! Administrative authentication routes: login, logout, and current session check.

use axum::{
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};

use crate::auth::{
    build_logout_cookie, build_session_cookie, create_session, derive_csrf_token,
    extract_session_cookie, resolve_client_ip, revoke_session, validate_csrf_token,
    validate_origin, validate_session, verify_password, AdminUser,
};
use crate::error::{AppError, AppResult};
use crate::models::{AdminUserDto, LoginRequest, LoginResponse, LogoutResponse, MeResponse};
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/admin/login", post(login_handler))
        .route("/api/admin/logout", post(logout_handler))
        .route("/api/admin/me", get(me_handler))
}

/// POST /api/admin/login
/// Authenticates admin via Argon2id with rate limiting and issues HttpOnly session cookie.
pub async fn login_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<LoginRequest>,
) -> AppResult<impl IntoResponse> {
    let client_ip = resolve_client_ip(&headers, None);

    // 1. Check rate limiter
    if let Err(retry_after) = state.rate_limiter.check(client_ip) {
        return Err(AppError::RateLimitExceeded {
            retry_after_secs: retry_after,
        });
    }

    // 2. Validate input fields
    if payload.username.trim().is_empty() || payload.password.is_empty() {
        return Err(AppError::validation("Username and password are required"));
    }

    // 3. Lookup admin by username
    let admin_row: Option<(i64, String, String)> =
        sqlx::query_as("SELECT id, username, password_hash FROM admin WHERE username = ?")
            .bind(&payload.username)
            .fetch_optional(&state.db)
            .await
            .map_err(AppError::Database)?;

    let (admin_id, admin_username, password_hash) = match admin_row {
        Some(row) => row,
        None => {
            state.rate_limiter.record_failure(client_ip);
            return Err(AppError::InvalidCredentials);
        }
    };

    // 3. Verify Argon2id password in blocking thread
    let is_valid = verify_password(payload.password, password_hash).await?;
    if !is_valid {
        state.rate_limiter.record_failure(client_ip);
        return Err(AppError::InvalidCredentials);
    }

    // 4. Reset rate limiter on successful login
    state.rate_limiter.record_success(client_ip);

    // 5. Create new session in SQLite
    let (raw_token, token_hash) = create_session(&state.db, admin_id).await?;
    let csrf_token = derive_csrf_token(&token_hash, &state.config.session_secret);
    let cookie_val = build_session_cookie(&raw_token, state.config.cookie_secure);

    let body = Json(LoginResponse {
        success: true,
        user: AdminUserDto {
            id: admin_id,
            username: admin_username,
        },
        csrf_token,
    });

    Ok((StatusCode::OK, [(header::SET_COOKIE, cookie_val)], body))
}

/// POST /api/admin/logout
/// Revokes active session from SQLite and clears the session cookie.
pub async fn logout_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<impl IntoResponse> {
    if let Some(raw_token) = extract_session_cookie(&headers) {
        if let Ok(Some(session)) = validate_session(&state.db, &raw_token).await {
            let csrf_token = derive_csrf_token(&session.token_hash, &state.config.session_secret);
            validate_origin(&headers, &state.config)?;
            validate_csrf_token(&headers, &csrf_token)?;
            let _ = revoke_session(&state.db, &raw_token).await;
        }
    }

    let cookie_val = build_logout_cookie(state.config.cookie_secure);

    Ok((
        StatusCode::OK,
        [(header::SET_COOKIE, cookie_val)],
        Json(LogoutResponse { success: true }),
    ))
}

/// GET /api/admin/me
/// Returns current authenticated administrator profile and active CSRF token.
pub async fn me_handler(admin: AdminUser) -> AppResult<impl IntoResponse> {
    Ok((
        StatusCode::OK,
        Json(MeResponse {
            id: admin.id,
            username: admin.username,
            csrf_token: admin.csrf_token,
        }),
    ))
}
