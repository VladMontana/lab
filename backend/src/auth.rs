//! Authentication, session management, Argon2id hashing, rate limiting, and CSRF protection.

use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::{
    extract::{ConnectInfo, FromRequestParts},
    http::{header, request::Parts, HeaderMap},
};
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::ops::Deref;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::config::Config;
use crate::db::DbPool;
use crate::error::AppError;
use crate::AppState;

pub const SESSION_COOKIE_NAME: &str = "labnotes_session";
pub const SESSION_DURATION_SECS: i64 = 7 * 24 * 3600; // 7 days
pub const MAX_LOGIN_ATTEMPTS: u32 = 5;
pub const LOGIN_RATE_WINDOW_SECS: u64 = 15 * 60; // 15 minutes

// ============================================================================
// 1. Password Hashing & Verification (Argon2id)
// ============================================================================

/// Hashes a plaintext password using Argon2id with a cryptographically secure random salt.
pub fn hash_password(password: &str) -> Result<String, AppError> {
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default();
    let hash = argon2
        .hash_password(password.as_bytes(), &salt)
        .map_err(|e| AppError::Internal(format!("Failed to hash password: {e}")))?;
    Ok(hash.to_string())
}

/// Synchronously verifies a password against an Argon2id PHC string.
pub fn verify_password_sync(password: &str, password_hash: &str) -> Result<bool, AppError> {
    let parsed_hash = match PasswordHash::new(password_hash) {
        Ok(h) => h,
        Err(e) => {
            tracing::error!(error = %e, "Invalid password hash format");
            return Ok(false);
        }
    };
    let argon2 = Argon2::default();
    Ok(argon2
        .verify_password(password.as_bytes(), &parsed_hash)
        .is_ok())
}

/// Offloads Argon2id password verification to a Tokio blocking worker thread.
pub async fn verify_password(password: String, password_hash: String) -> Result<bool, AppError> {
    tokio::task::spawn_blocking(move || verify_password_sync(&password, &password_hash))
        .await
        .map_err(|e| AppError::Internal(format!("Argon2 worker thread failed: {e}")))?
}

// ============================================================================
// 2. Token Hashing, Session Management & CSRF Derivation
// ============================================================================

/// Generates a cryptographically secure 32-byte session token encoded as a 64-character hex string.
pub fn generate_session_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().fold(String::with_capacity(64), |mut acc, b| {
        use std::fmt::Write;
        let _ = write!(acc, "{:02x}", b);
        acc
    })
}

/// Computes the SHA-256 hash of a string, returning a 64-character lowercase hex string.
pub fn hash_sha256(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let result = hasher.finalize();
    result.iter().fold(String::with_capacity(64), |mut acc, b| {
        use std::fmt::Write;
        let _ = write!(acc, "{:02x}", b);
        acc
    })
}

/// Hashes the raw session token for database lookup and storage.
pub fn hash_session_token(token: &str) -> String {
    hash_sha256(token)
}

/// Derives a deterministic, cryptographically secure CSRF token for a given session.
pub fn derive_csrf_token(token_hash: &str, session_secret: &str) -> String {
    let payload = format!("{token_hash}:{session_secret}");
    hash_sha256(&payload)
}

/// Performs a constant-time string comparison to prevent timing side-channels.
pub fn constant_time_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes()
        .zip(b.bytes())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

// ============================================================================
// 3. Database Session Operations
// ============================================================================

#[derive(Debug, Clone)]
pub struct SessionAdmin {
    pub admin_id: i64,
    pub username: String,
    pub token_hash: String,
}

/// Creates a new session record in SQLite, returning `(raw_token, token_hash)`.
pub async fn create_session(pool: &DbPool, admin_id: i64) -> Result<(String, String), AppError> {
    let raw_token = generate_session_token();
    let token_hash = hash_session_token(&raw_token);
    let expires_at =
        (chrono::Utc::now() + chrono::Duration::seconds(SESSION_DURATION_SECS)).to_rfc3339();

    sqlx::query("INSERT INTO sessions (token_hash, admin_id, expires_at) VALUES (?, ?, ?)")
        .bind(&token_hash)
        .bind(admin_id)
        .bind(&expires_at)
        .execute(pool)
        .await
        .map_err(AppError::Database)?;

    Ok((raw_token, token_hash))
}

/// Validates a raw session token against SQLite, returning the associated admin if non-expired.
pub async fn validate_session(
    pool: &DbPool,
    raw_token: &str,
) -> Result<Option<SessionAdmin>, AppError> {
    if raw_token.len() != 64 || !raw_token.chars().all(|c| c.is_ascii_hexdigit()) {
        return Ok(None);
    }

    let token_hash = hash_session_token(raw_token);
    let now = chrono::Utc::now().to_rfc3339();

    let record = sqlx::query_as::<_, (i64, String)>(
        r#"
        SELECT a.id, a.username
        FROM sessions s
        JOIN admin a ON s.admin_id = a.id
        WHERE s.token_hash = ? AND s.expires_at > ?
        "#,
    )
    .bind(&token_hash)
    .bind(&now)
    .fetch_optional(pool)
    .await
    .map_err(AppError::Database)?;

    Ok(record.map(|(admin_id, username)| SessionAdmin {
        admin_id,
        username,
        token_hash,
    }))
}

/// Revokes a session by deleting its record from SQLite.
pub async fn revoke_session(pool: &DbPool, raw_token: &str) -> Result<(), AppError> {
    let token_hash = hash_session_token(raw_token);
    sqlx::query("DELETE FROM sessions WHERE token_hash = ?")
        .bind(&token_hash)
        .execute(pool)
        .await
        .map_err(AppError::Database)?;
    Ok(())
}

/// Purges all expired sessions from SQLite.
pub async fn prune_expired_sessions(pool: &DbPool) -> Result<u64, AppError> {
    let now = chrono::Utc::now().to_rfc3339();
    let result = sqlx::query("DELETE FROM sessions WHERE expires_at <= ?")
        .bind(&now)
        .execute(pool)
        .await
        .map_err(AppError::Database)?;
    Ok(result.rows_affected())
}

// ============================================================================
// 4. Admin Bootstrap & Password Reset
// ============================================================================

/// Idempotently initializes the single admin account if the database has no admin.
pub async fn bootstrap_admin(
    pool: &DbPool,
    username: &str,
    password: &str,
) -> Result<bool, AppError> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM admin")
        .fetch_one(pool)
        .await
        .map_err(AppError::Database)?;

    if count > 0 {
        tracing::info!("Admin account already initialized; skipping bootstrap");
        return Ok(false);
    }

    let password_owned = password.to_string();
    let password_hash = tokio::task::spawn_blocking(move || hash_password(&password_owned))
        .await
        .map_err(|e| AppError::Internal(format!("Failed to spawn hashing task: {e}")))??;

    sqlx::query("INSERT INTO admin (username, password_hash) VALUES (?, ?)")
        .bind(username)
        .bind(&password_hash)
        .execute(pool)
        .await
        .map_err(AppError::Database)?;

    tracing::info!(username = %username, "Admin account successfully bootstrapped");
    Ok(true)
}

/// Explicitly resets or initializes the admin password, invalidating all active sessions.
pub async fn reset_admin_password(
    pool: &DbPool,
    username: &str,
    new_password: &str,
) -> Result<(), AppError> {
    if new_password.len() < 8 {
        return Err(AppError::validation(
            "Password must be at least 8 characters long",
        ));
    }

    let password_owned = new_password.to_string();
    let password_hash = tokio::task::spawn_blocking(move || hash_password(&password_owned))
        .await
        .map_err(|e| AppError::Internal(format!("Failed to spawn hashing task: {e}")))??;

    let existing: Option<i64> = sqlx::query_scalar("SELECT id FROM admin WHERE username = ?")
        .bind(username)
        .fetch_optional(pool)
        .await
        .map_err(AppError::Database)?;

    if let Some(admin_id) = existing {
        sqlx::query(
            "UPDATE admin SET password_hash = ?, updated_at = datetime('now') WHERE id = ?",
        )
        .bind(&password_hash)
        .bind(admin_id)
        .execute(pool)
        .await
        .map_err(AppError::Database)?;
    } else {
        sqlx::query("INSERT INTO admin (username, password_hash) VALUES (?, ?)")
            .bind(username)
            .bind(&password_hash)
            .execute(pool)
            .await
            .map_err(AppError::Database)?;
    }

    // Invalidate all active sessions for security
    sqlx::query("DELETE FROM sessions")
        .execute(pool)
        .await
        .map_err(AppError::Database)?;
    tracing::info!(username = %username, "Admin password updated and all existing sessions revoked");

    Ok(())
}

// ============================================================================
// 5. Cookies & Header Helpers
// ============================================================================

/// Builds the `Set-Cookie` string for creating a session.
pub fn build_session_cookie(token: &str, secure: bool) -> String {
    if secure {
        format!(
            "{}={}; HttpOnly; SameSite=Lax; Path=/; Max-Age={}; Secure",
            SESSION_COOKIE_NAME, token, SESSION_DURATION_SECS
        )
    } else {
        format!(
            "{}={}; HttpOnly; SameSite=Lax; Path=/; Max-Age={}",
            SESSION_COOKIE_NAME, token, SESSION_DURATION_SECS
        )
    }
}

/// Builds the `Set-Cookie` string to clear a session cookie.
pub fn build_logout_cookie(secure: bool) -> String {
    if secure {
        format!(
            "{}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Secure",
            SESSION_COOKIE_NAME
        )
    } else {
        format!(
            "{}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
            SESSION_COOKIE_NAME
        )
    }
}

/// Extracts the raw `labnotes_session` cookie value from request headers.
pub fn extract_session_cookie(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|part| {
            let part = part.trim();
            part.strip_prefix("labnotes_session=").map(str::to_string)
        })
}

/// Resolves the client IP from the socket peer and, for explicitly trusted
/// proxies, the rightmost untrusted address in X-Forwarded-For.
pub fn resolve_client_ip(
    headers: &HeaderMap,
    connect_info: Option<&ConnectInfo<SocketAddr>>,
    trusted_proxy_ips: &[IpAddr],
) -> IpAddr {
    let fallback = IpAddr::V4(Ipv4Addr::LOCALHOST);
    let peer = match connect_info {
        Some(ConnectInfo(addr)) => addr.ip(),
        None => return fallback,
    };

    if !trusted_proxy_ips.contains(&peer) {
        return peer;
    }

    let forwarded = headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            value
                .split(',')
                .filter_map(|entry| entry.trim().parse::<IpAddr>().ok())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    // Walk the chain from the peer toward the client. Trusted entries may be
    // proxies; the first untrusted address is the client identity.
    for ip in forwarded.iter().rev() {
        if !trusted_proxy_ips.contains(ip) {
            return *ip;
        }
    }

    forwarded.first().copied().unwrap_or(peer)
}

// ============================================================================
// 6. Login Rate Limiter (5 failed attempts per 15 min per IP)
// ============================================================================

#[derive(Debug, Clone)]
struct AttemptRecord {
    failed_attempts: u32,
    first_failure: Instant,
    #[allow(dead_code)]
    last_failure: Instant,
}

#[derive(Debug, Clone, Default)]
pub struct LoginRateLimiter {
    state: Arc<Mutex<HashMap<IpAddr, AttemptRecord>>>,
}

impl LoginRateLimiter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Checks if the IP is allowed to attempt a login.
    /// Returns `Ok(())` if permitted, or `Err(retry_after_secs)` if blocked.
    pub fn check(&self, ip: IpAddr) -> Result<(), u64> {
        let mut map = self.state.lock().unwrap();
        let window = Duration::from_secs(LOGIN_RATE_WINDOW_SECS);

        if let Some(record) = map.get(&ip) {
            if record.first_failure.elapsed() >= window {
                map.remove(&ip);
                return Ok(());
            }

            if record.failed_attempts >= MAX_LOGIN_ATTEMPTS {
                let remaining = window
                    .saturating_sub(record.first_failure.elapsed())
                    .as_secs()
                    .max(1);
                return Err(remaining);
            }
        }

        Ok(())
    }

    /// Records a failed login attempt for the given IP.
    pub fn record_failure(&self, ip: IpAddr) {
        let mut map = self.state.lock().unwrap();
        let window = Duration::from_secs(LOGIN_RATE_WINDOW_SECS);

        // Opportunistic cleanup if map gets large
        if map.len() > 1024 {
            map.retain(|_, v| v.first_failure.elapsed() < window);
        }

        let now = Instant::now();
        if let Some(record) = map.get_mut(&ip) {
            if record.first_failure.elapsed() >= window {
                record.failed_attempts = 1;
                record.first_failure = now;
                record.last_failure = now;
            } else {
                record.failed_attempts += 1;
                record.last_failure = now;
            }
        } else {
            map.insert(
                ip,
                AttemptRecord {
                    failed_attempts: 1,
                    first_failure: now,
                    last_failure: now,
                },
            );
        }
    }

    /// Resets the rate limiter for the IP on successful login.
    pub fn record_success(&self, ip: IpAddr) {
        let mut map = self.state.lock().unwrap();
        map.remove(&ip);
    }
}

// ============================================================================
// 7. CSRF & Origin Validation
// ============================================================================

/// Validates the `Origin` or `Referer` header against allowed application origins.
pub fn validate_origin(headers: &HeaderMap, config: &Config) -> Result<(), AppError> {
    let origin_header = headers
        .get(header::ORIGIN)
        .or_else(|| headers.get(header::REFERER));

    let origin_raw = match origin_header {
        Some(v) => match v.to_str() {
            Ok(s) => s,
            Err(_) => {
                return Err(AppError::Forbidden(
                    "Invalid Origin header encoding".to_string(),
                ))
            }
        },
        None => {
            // For programmatic clients or testing environments without Origin header, permit request.
            return Ok(());
        }
    };

    // Extract origin without trailing path (in case of Referer)
    let origin_clean = if let Some(idx) = origin_raw.find("://") {
        let rest = &origin_raw[idx + 3..];
        let end = rest.find('/').unwrap_or(rest.len());
        &origin_raw[..idx + 3 + end]
    } else {
        origin_raw
    };

    let base_clean = config.base_url.trim_end_matches('/');
    if origin_clean == base_clean
        || origin_clean.starts_with("http://localhost:")
        || origin_clean.starts_with("http://127.0.0.1:")
        || origin_clean.starts_with("https://localhost:")
        || origin_clean.starts_with("https://127.0.0.1:")
    {
        Ok(())
    } else {
        Err(AppError::Forbidden(format!(
            "Cross-origin request rejected: origin '{origin_clean}' not permitted"
        )))
    }
}

/// Validates the `X-CSRF-Token` header against the expected session CSRF token.
pub fn validate_csrf_token(headers: &HeaderMap, expected_token: &str) -> Result<(), AppError> {
    let token = headers
        .get("x-csrf-token")
        .and_then(|h| h.to_str().ok())
        .ok_or_else(|| AppError::Forbidden("Missing X-CSRF-Token header".to_string()))?;

    if constant_time_eq(token, expected_token) {
        Ok(())
    } else {
        Err(AppError::Forbidden("Invalid CSRF token".to_string()))
    }
}

// ============================================================================
// 8. Axum Extractors: AdminUser, OptionalAdminUser, CsrfProtected
// ============================================================================

/// Authenticated administrator extractor. Returns HTTP 401 UNAUTHORIZED if not authenticated.
#[derive(Debug, Clone)]
pub struct AdminUser {
    pub id: i64,
    pub username: String,
    pub session_token_hash: String,
    pub csrf_token: String,
}

impl FromRequestParts<AppState> for AdminUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let raw_token = extract_session_cookie(&parts.headers)
            .ok_or_else(|| AppError::Unauthorized("Authentication required".to_string()))?;

        let session = validate_session(&state.db, &raw_token)
            .await?
            .ok_or_else(|| AppError::Unauthorized("Invalid or expired session".to_string()))?;

        let csrf_token = derive_csrf_token(&session.token_hash, &state.config.session_secret);

        Ok(AdminUser {
            id: session.admin_id,
            username: session.username,
            session_token_hash: session.token_hash,
            csrf_token,
        })
    }
}

/// Infallible extractor for routes needing optional authentication (e.g. Media Gating).
#[derive(Debug, Clone)]
pub struct OptionalAdminUser(pub Option<AdminUser>);

impl FromRequestParts<AppState> for OptionalAdminUser {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let Some(raw_token) = extract_session_cookie(&parts.headers) else {
            return Ok(OptionalAdminUser(None));
        };

        match validate_session(&state.db, &raw_token).await {
            Ok(Some(session)) => {
                let csrf_token =
                    derive_csrf_token(&session.token_hash, &state.config.session_secret);
                Ok(OptionalAdminUser(Some(AdminUser {
                    id: session.admin_id,
                    username: session.username,
                    session_token_hash: session.token_hash,
                    csrf_token,
                })))
            }
            _ => Ok(OptionalAdminUser(None)),
        }
    }
}

/// Extractor for mutating admin endpoints, enforcing Authentication + Origin + CSRF Token validation.
#[derive(Debug, Clone)]
pub struct CsrfProtected(pub AdminUser);

impl Deref for CsrfProtected {
    type Target = AdminUser;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl FromRequestParts<AppState> for CsrfProtected {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        // 1. Authenticate admin user
        let user = AdminUser::from_request_parts(parts, state).await?;

        // 2. Validate Origin / Referer
        validate_origin(&parts.headers, &state.config)?;

        // 3. Validate CSRF token
        validate_csrf_token(&parts.headers, &user.csrf_token)?;

        Ok(CsrfProtected(user))
    }
}
