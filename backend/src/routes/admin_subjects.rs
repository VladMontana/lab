//! Administrative subject management routes.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::get,
    Json, Router,
};
use uuid::Uuid;

use crate::{
    auth::{AdminUser, CsrfProtected},
    error::{AppError, AppResult},
    models::{CreateSubjectRequest, SubjectResponse, SuccessResponse, UpdateSubjectRequest},
    AppState,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/admin/subjects",
            get(list_subjects).post(create_subject),
        )
        .route(
            "/api/admin/subjects/{id}",
            axum::routing::patch(update_subject).delete(delete_subject),
        )
}

/// GET /api/admin/subjects
/// Lists all subjects with count of draft pages belonging to each subject.
pub async fn list_subjects(
    _admin: AdminUser,
    State(state): State<AppState>,
) -> AppResult<Json<Vec<SubjectResponse>>> {
    let rows = sqlx::query_as::<_, (String, String, i64, String, String, i64)>(
        r#"
        SELECT 
            s.id, 
            s.name, 
            s.position, 
            s.created_at, 
            s.updated_at, 
            CAST(COUNT(p.id) AS INTEGER) AS page_count
        FROM subjects s
        LEFT JOIN pages p ON p.draft_subject_id = s.id
        GROUP BY s.id
        ORDER BY s.position ASC, s.name ASC
        "#,
    )
    .fetch_all(&state.db)
    .await?;

    let subjects = rows
        .into_iter()
        .map(|r| SubjectResponse {
            id: r.0,
            name: r.1,
            position: r.2,
            created_at: r.3,
            updated_at: r.4,
            page_count: r.5,
        })
        .collect();

    Ok(Json(subjects))
}

/// POST /api/admin/subjects
/// Creates a new subject. If position is omitted, places at end.
pub async fn create_subject(
    _admin: CsrfProtected,
    State(state): State<AppState>,
    Json(req): Json<CreateSubjectRequest>,
) -> AppResult<(StatusCode, Json<SubjectResponse>)> {
    let name = req.name.trim();
    if name.is_empty() {
        return Err(AppError::validation("Subject name cannot be empty"));
    }
    if name.chars().count() > 100 {
        return Err(AppError::validation(
            "Subject name cannot exceed 100 characters",
        ));
    }

    let position = req.position.unwrap_or(0);

    let id = Uuid::new_v4().to_string();

    let row = sqlx::query_as::<_, (String, String, i64, String, String)>(
        r#"
        INSERT INTO subjects (id, name, position, created_at, updated_at)
        VALUES (?1, ?2, ?3, datetime('now'), datetime('now'))
        RETURNING id, name, position, created_at, updated_at
        "#,
    )
    .bind(&id)
    .bind(name)
    .bind(position)
    .fetch_one(&state.db)
    .await?;

    let response = SubjectResponse {
        id: row.0,
        name: row.1,
        position: row.2,
        page_count: 0,
        created_at: row.3,
        updated_at: row.4,
    };

    Ok((StatusCode::CREATED, Json(response)))
}

/// PATCH /api/admin/subjects/{id}
/// Updates subject name, position, or both.
pub async fn update_subject(
    _admin: CsrfProtected,
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<UpdateSubjectRequest>,
) -> AppResult<Json<SubjectResponse>> {
    if req.name.is_none() && req.position.is_none() {
        return Err(AppError::validation(
            "At least one field (name or position) must be provided",
        ));
    }

    let trimmed_name = match req.name {
        Some(ref n) => {
            let t = n.trim();
            if t.is_empty() {
                return Err(AppError::validation("Subject name cannot be empty"));
            }
            if t.chars().count() > 100 {
                return Err(AppError::validation(
                    "Subject name cannot exceed 100 characters",
                ));
            }
            Some(t.to_string())
        }
        None => None,
    };

    let row = sqlx::query_as::<_, (String, String, i64, String, String)>(
        r#"
        UPDATE subjects
        SET 
            name = COALESCE(?1, name),
            position = COALESCE(?2, position),
            updated_at = datetime('now')
        WHERE id = ?3
        RETURNING id, name, position, created_at, updated_at
        "#,
    )
    .bind(trimmed_name)
    .bind(req.position)
    .bind(&id)
    .fetch_optional(&state.db)
    .await?;

    let row = match row {
        Some(r) => r,
        None => return Err(AppError::not_found(format!("Subject '{id}' not found"))),
    };

    let count: (i64,) =
        sqlx::query_as("SELECT CAST(COUNT(*) AS INTEGER) FROM pages WHERE draft_subject_id = ?")
            .bind(&id)
            .fetch_one(&state.db)
            .await?;

    Ok(Json(SubjectResponse {
        id: row.0,
        name: row.1,
        position: row.2,
        page_count: count.0,
        created_at: row.3,
        updated_at: row.4,
    }))
}

/// DELETE /api/admin/subjects/{id}
/// Deletes subject if empty. Returns HTTP 409 SUBJECT_NOT_EMPTY if pages reference it.
pub async fn delete_subject(
    _admin: CsrfProtected,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Json<SuccessResponse>> {
    // 1. Verify subject exists
    let exists: Option<(String,)> = sqlx::query_as("SELECT id FROM subjects WHERE id = ?")
        .bind(&id)
        .fetch_optional(&state.db)
        .await?;

    if exists.is_none() {
        return Err(AppError::not_found(format!("Subject '{id}' not found")));
    }

    // 2. Check for dependent draft pages or publications
    let page_count: (i64,) = sqlx::query_as(
        r#"
        SELECT 
            (SELECT COUNT(*) FROM pages WHERE draft_subject_id = ?1) +
            (SELECT COUNT(*) FROM publications WHERE subject_id = ?1) AS total_count
        "#,
    )
    .bind(&id)
    .fetch_one(&state.db)
    .await?;

    if page_count.0 > 0 {
        return Err(AppError::SubjectNotEmpty);
    }

    // 3. Delete subject
    sqlx::query("DELETE FROM subjects WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;

    Ok(Json(SuccessResponse { success: true }))
}
