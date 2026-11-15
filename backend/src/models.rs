//! Data Transfer Objects (DTOs) for LabNotes MVP API.

use serde::{Deserialize, Serialize};

// ============================================================================
// AUTH DTOs
// ============================================================================

#[derive(Debug, Clone, Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AdminUserDto {
    pub id: i64,
    pub username: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginResponse {
    pub success: bool,
    pub user: AdminUserDto,
    pub csrf_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogoutResponse {
    pub success: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeResponse {
    pub id: i64,
    pub username: String,
    pub csrf_token: String,
}

// ============================================================================
// SUBJECT DTOs
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubjectResponse {
    pub id: String,
    pub name: String,
    pub position: i64,
    pub page_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreateSubjectRequest {
    pub name: String,
    pub position: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpdateSubjectRequest {
    pub name: Option<String>,
    pub position: Option<i64>,
}

// ============================================================================
// PAGE DTOs
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdminPageListItem {
    pub id: String,
    pub draft_subject_id: String,
    pub draft_subject_name: String,
    pub draft_title: String,
    pub revision: i64,
    pub is_published: bool,
    pub published_revision: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct AdminListPagesQuery {
    pub subject_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdminPageDetail {
    pub id: String,
    pub draft_subject_id: String,
    pub draft_title: String,
    pub draft_markdown: String,
    pub revision: i64,
    pub is_published: bool,
    pub published_revision: Option<i64>,
    pub published_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreatePageRequest {
    pub subject_id: String,
    pub title: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpdatePageRequest {
    pub expected_revision: i64,
    pub title: Option<String>,
    pub subject_id: Option<String>,
    pub markdown: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdatePageResponse {
    pub id: String,
    pub revision: i64,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub draft_markdown: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject_id: Option<String>,
}

// ============================================================================
// PUBLICATION DTOs
// ============================================================================

#[derive(Debug, Clone, Deserialize)]
pub struct PublishPageRequest {
    pub expected_revision: i64,
    #[serde(default)]
    pub attachment_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublishPageResponse {
    pub page_id: String,
    pub published_revision: i64,
    pub published_at: String,
}

// ============================================================================
// ASSET DTOs
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetResponse {
    pub id: String,
    pub page_id: String,
    pub original_name: String,
    pub mime: String,
    pub byte_size: i64,
    pub kind: String,
    pub url: String,
    pub is_published: bool,
    pub created_at: String,
}

// ============================================================================
// COMMON DTOs
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SuccessResponse {
    pub success: bool,
}

pub type GenericSuccessResponse = SuccessResponse;

// ============================================================================
// PUBLIC CATALOG & SEARCH DTOs (Milestone 3)
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PublicSubjectItem {
    pub id: String,
    pub name: String,
    pub position: i64,
    pub page_count: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PublicPageQuery {
    pub subject_id: Option<String>,
    pub q: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

pub type PublicPagesQuery = PublicPageQuery;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PublicPageItem {
    pub id: String,
    pub subject_id: String,
    pub subject_name: String,
    pub title: String,
    pub snippet: String,
    pub published_at: String,
}

pub type PublicPageListItem = PublicPageItem;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PublicPageListResponse {
    pub items: Vec<PublicPageItem>,
    pub total: i64,
    pub limit: i64,
    pub offset: i64,
}

pub type PublicPagesResponse = PublicPageListResponse;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PublicAttachmentItem {
    pub id: String,
    pub original_name: String,
    pub byte_size: i64,
    pub mime: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PublicPageViewResponse {
    pub id: String,
    pub subject_id: String,
    pub subject_name: String,
    pub title: String,
    pub markdown: String,
    pub published_at: String,
    pub attachments: Vec<PublicAttachmentItem>,
}

pub type PublicPageDetail = PublicPageViewResponse;
pub type PublicPageDetailResponse = PublicPageViewResponse;
