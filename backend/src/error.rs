use axum::{
    extract::rejection::{JsonRejection, PathRejection, QueryRejection},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ErrorResponse {
    pub error: ErrorDetail,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ErrorDetail {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Error)]
pub enum AppError {
    #[error("Validation error: {0}")]
    ValidationError(String),

    #[error("Invalid image format: {0}")]
    InvalidImageFormat(String),

    #[error("SVG files are not permitted")]
    SvgNotAllowed,

    #[error("Unsupported MIME type: {0}")]
    UnsupportedMime(String),

    #[error("Unauthorized: {0}")]
    Unauthorized(String),

    #[error("Invalid credentials")]
    InvalidCredentials,

    #[error("Forbidden: {0}")]
    Forbidden(String),

    #[error("Resource not found: {0}")]
    NotFound(String),

    #[error("Page not found: {0}")]
    PageNotFound(String),

    #[error("Media not found: {0}")]
    MediaNotFound(String),

    #[error("Revision conflict: expected {expected}, actual {actual}")]
    RevisionConflict { expected: i64, actual: i64 },

    #[error("Cannot delete subject containing pages")]
    SubjectNotEmpty,

    #[error("File exceeds maximum allowed size of {max_bytes} bytes")]
    FileTooLarge { max_bytes: usize },

    #[error("Rate limit exceeded: retry after {retry_after_secs}s")]
    RateLimitExceeded { retry_after_secs: u64 },

    #[error("Database error")]
    Database(#[from] sqlx::Error),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Internal error: {0}")]
    Internal(String),

    #[error("Configuration error: {0}")]
    Config(String),
}

impl AppError {
    pub fn validation(msg: impl Into<String>) -> Self {
        Self::ValidationError(msg.into())
    }

    pub fn internal(msg: impl Into<String>) -> Self {
        Self::Internal(msg.into())
    }

    pub fn not_found(msg: impl Into<String>) -> Self {
        Self::NotFound(msg.into())
    }

    pub fn file_too_large(max_bytes: usize) -> Self {
        Self::FileTooLarge { max_bytes }
    }

    pub fn invalid_image_format(msg: impl Into<String>) -> Self {
        Self::InvalidImageFormat(msg.into())
    }

    pub fn unsupported_mime(msg: impl Into<String>) -> Self {
        Self::UnsupportedMime(msg.into())
    }
}

pub type AppResult<T> = Result<T, AppError>;

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code, message, retry_after) = match self {
            AppError::ValidationError(msg) => (StatusCode::BAD_REQUEST, "VALIDATION_ERROR", msg, None),
            AppError::InvalidImageFormat(msg) => {
                (StatusCode::BAD_REQUEST, "INVALID_IMAGE_FORMAT", msg, None)
            }
            AppError::SvgNotAllowed => (
                StatusCode::BAD_REQUEST,
                "SVG_NOT_ALLOWED",
                "SVG files are not permitted for security reasons".to_string(),
                None,
            ),
            AppError::UnsupportedMime(msg) => {
                (StatusCode::BAD_REQUEST, "UNSUPPORTED_MIME", msg, None)
            }
            AppError::Unauthorized(msg) => (StatusCode::UNAUTHORIZED, "UNAUTHORIZED", msg, None),
            AppError::InvalidCredentials => (
                StatusCode::UNAUTHORIZED,
                "INVALID_CREDENTIALS",
                "Invalid username or password".to_string(),
                None,
            ),
            AppError::Forbidden(msg) => (StatusCode::FORBIDDEN, "FORBIDDEN", msg, None),
            AppError::NotFound(msg) => (StatusCode::NOT_FOUND, "NOT_FOUND", msg, None),
            AppError::PageNotFound(msg) => (StatusCode::NOT_FOUND, "PAGE_NOT_FOUND", msg, None),
            AppError::MediaNotFound(msg) => (StatusCode::NOT_FOUND, "MEDIA_NOT_FOUND", msg, None),
            AppError::RevisionConflict { expected, actual } => (
                StatusCode::CONFLICT,
                "REVISION_CONFLICT",
                format!("Revision conflict: expected revision {expected}, but current revision is {actual}"),
                None,
            ),
            AppError::SubjectNotEmpty => (
                StatusCode::CONFLICT,
                "SUBJECT_NOT_EMPTY",
                "Cannot delete subject because it contains pages".to_string(),
                None,
            ),
            AppError::FileTooLarge { max_bytes } => (
                StatusCode::PAYLOAD_TOO_LARGE,
                "FILE_TOO_LARGE",
                format!("File exceeds maximum allowed size of {max_bytes} bytes"),
                None,
            ),
            AppError::RateLimitExceeded { retry_after_secs } => (
                StatusCode::TOO_MANY_REQUESTS,
                "RATE_LIMIT_EXCEEDED",
                format!("Rate limit exceeded. Please try again after {retry_after_secs} seconds"),
                Some(retry_after_secs),
            ),
            AppError::Database(err) => {
                tracing::error!(error = %err, "Database error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "INTERNAL_ERROR",
                    "Internal server error".to_string(),
                    None,
                )
            }
            AppError::Io(err) => {
                tracing::error!(error = %err, "I/O error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "INTERNAL_ERROR",
                    "Internal server error".to_string(),
                    None,
                )
            }
            AppError::Internal(msg) => {
                tracing::error!(error = %msg, "Internal error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "INTERNAL_ERROR",
                    "Internal server error".to_string(),
                    None,
                )
            }
            AppError::Config(msg) => {
                tracing::error!(error = %msg, "Configuration error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "INTERNAL_ERROR",
                    "Server configuration error".to_string(),
                    None,
                )
            }
        };

        let body = Json(ErrorResponse {
            error: ErrorDetail {
                code: code.to_string(),
                message,
            },
        });

        if let Some(secs) = retry_after {
            (status, [(header::RETRY_AFTER, secs.to_string())], body).into_response()
        } else {
            (status, body).into_response()
        }
    }
}

impl From<JsonRejection> for AppError {
    fn from(rejection: JsonRejection) -> Self {
        AppError::ValidationError(rejection.to_string())
    }
}

impl From<PathRejection> for AppError {
    fn from(rejection: PathRejection) -> Self {
        AppError::ValidationError(rejection.to_string())
    }
}

impl From<QueryRejection> for AppError {
    fn from(rejection: QueryRejection) -> Self {
        AppError::ValidationError(rejection.to_string())
    }
}
