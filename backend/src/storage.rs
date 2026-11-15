//! Streaming file storage service with magic byte validation, dimension inspection,
//! path traversal sanitization, and atomic disk persistence.

use axum::extract::multipart::Field;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use crate::error::AppError;

/// Maximum allowed image size (10 MiB)
pub const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
/// Maximum allowed attachment size (50 MiB)
pub const MAX_ATTACHMENT_BYTES: u64 = 50 * 1024 * 1024;
/// Maximum image dimensions (8192x8192)
pub const MAX_IMAGE_DIMENSION: u32 = 8192;
/// Sample header size for magic byte detection (1024 bytes)
pub const HEADER_SAMPLE_SIZE: usize = 1024;

/// Categorization of uploaded asset
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AssetKind {
    Image,
    Attachment,
}

impl AssetKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            AssetKind::Image => "image",
            AssetKind::Attachment => "attachment",
        }
    }
}

/// Metadata describing a successfully stored file
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UploadedFileMeta {
    pub id: String,
    pub stored_name: String,
    pub original_name: String,
    pub mime: String,
    pub byte_size: u64,
    pub kind: AssetKind,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// RAII guard to guarantee temporary files are unlinked on error or drop
pub struct TempFileGuard {
    path: PathBuf,
    persisted: bool,
}

impl TempFileGuard {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            persisted: false,
        }
    }

    pub fn persist(&mut self) {
        self.persisted = true;
    }
}

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        if !self.persisted && self.path.exists() {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// Helper to check if a byte slice contains a specific subslice
fn contains_subslice(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() {
        return true;
    }
    haystack.windows(needle.len()).any(|w| w == needle)
}

/// Detects and validates file type by inspecting magic byte signatures and filename extension.
/// Strictly rejects SVG files with `AppError::SvgNotAllowed`.
pub fn detect_file_type(
    header: &[u8],
    client_filename: &str,
    kind_hint: Option<AssetKind>,
) -> Result<(AssetKind, &'static str), AppError> {
    let ext = Path::new(client_filename)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();

    // Prepare lowercase header slice for text-based signature matching
    let header_lower: Vec<u8> = header.iter().map(|b| b.to_ascii_lowercase()).collect();

    // 1. Strict SVG Detection (extension or header content)
    let is_svg = ext == "svg"
        || contains_subslice(&header_lower, b"<svg")
        || (contains_subslice(&header_lower, b"<?xml") && contains_subslice(&header_lower, b"svg"));

    if is_svg {
        return Err(AppError::SvgNotAllowed);
    }

    // 2. Strict HTML Detection
    let is_html = ext == "html"
        || ext == "htm"
        || ext == "xhtml"
        || contains_subslice(&header_lower, b"<!doctype html")
        || contains_subslice(&header_lower, b"<html");

    if is_html {
        return Err(AppError::unsupported_mime(
            "HTML files are not allowed for security reasons",
        ));
    }

    // 3. PNG: \x89PNG\r\n\x1a\n (8 bytes)
    const PNG_MAGIC: [u8; 8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    if header.len() >= 8 && header.starts_with(&PNG_MAGIC) {
        if let Some(AssetKind::Attachment) = kind_hint {
            return Err(AppError::validation(
                "PNG image cannot be uploaded as attachment",
            ));
        }
        return Ok((AssetKind::Image, "image/png"));
    }

    // 4. JPEG: \xFF\xD8\xFF (3 bytes)
    const JPEG_MAGIC: [u8; 3] = [0xFF, 0xD8, 0xFF];
    if header.len() >= 3 && header.starts_with(&JPEG_MAGIC) {
        if let Some(AssetKind::Attachment) = kind_hint {
            return Err(AppError::validation(
                "JPEG image cannot be uploaded as attachment",
            ));
        }
        return Ok((AssetKind::Image, "image/jpeg"));
    }

    // 5. WebP: RIFF....WEBP (12 bytes)
    if header.len() >= 12 && &header[0..4] == b"RIFF" && &header[8..12] == b"WEBP" {
        if let Some(AssetKind::Attachment) = kind_hint {
            return Err(AppError::validation(
                "WebP image cannot be uploaded as attachment",
            ));
        }
        return Ok((AssetKind::Image, "image/webp"));
    }

    // 6. PDF: %PDF- (5 bytes)
    if header.len() >= 5 && header.starts_with(b"%PDF-") {
        if let Some(AssetKind::Image) = kind_hint {
            return Err(AppError::invalid_image_format(
                "PDF file cannot be uploaded as image",
            ));
        }
        return Ok((AssetKind::Attachment, "application/pdf"));
    }

    // 7. ZIP / DOCX: PK\x03\x04 or PK\x05\x06 (4 bytes)
    if header.len() >= 4 && (header.starts_with(b"PK\x03\x04") || header.starts_with(b"PK\x05\x06"))
    {
        if let Some(AssetKind::Image) = kind_hint {
            return Err(AppError::invalid_image_format(
                "Archive file cannot be uploaded as image",
            ));
        }
        if ext == "docx" {
            return Ok((
                AssetKind::Attachment,
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ));
        }
        return Ok((AssetKind::Attachment, "application/zip"));
    }

    // 8. Plain Text & Markdown: UTF-8 validation
    if ext == "txt" || ext == "md" || ext == "ini" || ext == "csv" || ext == "json" {
        if let Some(AssetKind::Image) = kind_hint {
            return Err(AppError::invalid_image_format(
                "Text file cannot be uploaded as image",
            ));
        }
        // Verify UTF-8 without non-printable control characters
        if std::str::from_utf8(header).is_ok() {
            let has_null_or_bad_ctrl = header
                .iter()
                .any(|&b| b == 0 || (b < 9) || (b > 10 && b < 13) || (b > 13 && b < 32 && b != 27));
            if !has_null_or_bad_ctrl {
                let mime = match ext.as_str() {
                    "md" => "text/markdown",
                    "csv" => "text/csv",
                    "json" => "application/json",
                    _ => "text/plain",
                };
                return Ok((AssetKind::Attachment, mime));
            }
        }
    }

    // Fallback error mapping based on requested kind or extension
    let is_img_ext = matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp");
    if kind_hint == Some(AssetKind::Image) || is_img_ext {
        Err(AppError::invalid_image_format(
            "Unsupported or invalid image format; allowed formats are PNG, JPEG, WebP",
        ))
    } else {
        Err(AppError::unsupported_mime(
            "Unsupported file format; allowed formats are PNG, JPEG, WebP, PDF, DOCX, TXT, MD, ZIP",
        ))
    }
}

/// Inspects image dimensions without decoding pixel raster data to protect against memory exhaustion.
pub fn inspect_image_dimensions(path: &Path) -> Result<(u32, u32), AppError> {
    let file = std::fs::File::open(path).map_err(|e| {
        AppError::internal(format!("Failed to open image for dimension check: {e}"))
    })?;
    let buf_reader = std::io::BufReader::new(file);

    let mut reader = image::ImageReader::new(buf_reader)
        .with_guessed_format()
        .map_err(|e| {
            AppError::invalid_image_format(format!("Unable to determine image format: {e}"))
        })?;

    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_IMAGE_DIMENSION);
    limits.max_alloc = Some(32 * 1024 * 1024); // 32 MiB allocation ceiling
    reader.limits(limits);

    let (width, height) = reader
        .into_dimensions()
        .map_err(|e| AppError::invalid_image_format(format!("Corrupt or unreadable image: {e}")))?;

    if width == 0 || height == 0 || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION {
        return Err(AppError::invalid_image_format(format!(
            "Image dimensions {width}x{height} exceed allowable limit of {MAX_IMAGE_DIMENSION}x{MAX_IMAGE_DIMENSION}"
        )));
    }

    Ok((width, height))
}

/// Thoroughly sanitizes client-provided filename to prevent path traversal,
/// header injection, and Windows reserved DOS device naming attacks.
pub fn sanitize_filename(raw_name: Option<&str>, default_name: &str) -> String {
    let raw = match raw_name {
        Some(s) if !s.trim().is_empty() => s,
        _ => default_name,
    };

    // 1. Strip null bytes and control characters (CRLF, tabs)
    let cleaned: String = raw
        .chars()
        .filter(|c| !c.is_control() && *c != '\0')
        .collect();

    // 2. Normalize backslashes to forward slashes
    let normalized = cleaned.replace('\\', "/");

    // 3. Extract only the last path component
    let file_name = Path::new(&normalized)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(default_name);

    // 4. Strip leading/trailing whitespace and dots
    let trimmed = file_name.trim_matches(|c: char| c.is_whitespace() || c == '.');

    // 5. Whitelist safe characters; replace unsafe characters with underscore
    let mut safe_name = String::with_capacity(trimmed.len());
    for c in trimmed.chars() {
        if c.is_alphanumeric()
            || c == '.'
            || c == '-'
            || c == '_'
            || c == ' '
            || c == '('
            || c == ')'
        {
            safe_name.push(c);
        } else {
            safe_name.push('_');
        }
    }

    let final_trimmed = safe_name.trim();
    if final_trimmed.is_empty() || final_trimmed == "." || final_trimmed == ".." {
        return default_name.to_string();
    }

    // 6. Prevent Windows reserved DOS device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
    let stem = Path::new(final_trimmed)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_uppercase();

    let is_reserved = matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    );

    let candidate = if is_reserved {
        format!("file_{final_trimmed}")
    } else {
        final_trimmed.to_string()
    };

    // 7. Truncate to maximum 255 characters while preserving file extension
    if candidate.len() > 255 {
        let p = Path::new(&candidate);
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
        let ext_len = if ext.is_empty() { 0 } else { ext.len() + 1 };
        let max_stem_len = 255_usize.saturating_sub(ext_len);
        let truncated_stem: String = p
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("file")
            .chars()
            .take(max_stem_len)
            .collect();
        if ext.is_empty() {
            truncated_stem
        } else {
            format!("{truncated_stem}.{ext}")
        }
    } else {
        candidate
    }
}

/// Atomically renames a file from source to destination, falling back to copy+delete
/// if cross-device filesystem boundaries (EXDEV) are encountered.
pub async fn atomic_move_file(source: &Path, destination: &Path) -> Result<(), std::io::Error> {
    match tokio::fs::rename(source, destination).await {
        Ok(()) => Ok(()),
        Err(err) => {
            if err.kind() == std::io::ErrorKind::CrossesDevices
                || err.raw_os_error() == Some(17) // EXDEV / ERROR_NOT_SAME_DEVICE
                || err.raw_os_error() == Some(18)
            {
                tokio::fs::copy(source, destination).await?;
                tokio::fs::remove_file(source).await?;
                Ok(())
            } else {
                Err(err)
            }
        }
    }
}

/// Core streaming upload handler. Streams chunks from multipart field to temporary file,
/// enforces size limits on the fly, validates magic bytes & image dimensions, and
/// atomically persists to `{data_dir}/media/{uuid}`.
pub async fn save_upload_field(
    mut field: Field<'_>,
    data_dir: &Path,
    kind_hint: Option<AssetKind>,
    max_image_bytes: u64,
    max_attachment_bytes: u64,
) -> Result<UploadedFileMeta, AppError> {
    let client_filename = field.file_name().unwrap_or("file");
    let sanitized_filename = sanitize_filename(Some(client_filename), "upload");

    let tmp_dir = data_dir.join("tmp");
    tokio::fs::create_dir_all(&tmp_dir)
        .await
        .map_err(|e| AppError::internal(format!("Failed to create tmp directory: {e}")))?;

    let temp_uuid = Uuid::new_v4().to_string();
    let temp_path = tmp_dir.join(format!(".upload_{temp_uuid}.tmp"));
    let mut guard = TempFileGuard::new(temp_path.clone());

    let mut temp_file = tokio::fs::File::create(&temp_path)
        .await
        .map_err(|e| AppError::internal(format!("Failed to create temporary file: {e}")))?;

    let mut total_bytes: u64 = 0;
    let mut header_buf = Vec::with_capacity(HEADER_SAMPLE_SIZE);
    let ext = Path::new(client_filename)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    let is_img_ext = matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp");
    let effective_max_bytes = match kind_hint {
        Some(AssetKind::Image) => max_image_bytes,
        Some(AssetKind::Attachment) => max_attachment_bytes,
        None => {
            if is_img_ext {
                max_image_bytes
            } else {
                max_attachment_bytes
            }
        }
    };

    while let Some(chunk) = field.next().await.transpose().map_err(|e| {
        let s = e.to_string().to_lowercase();
        if s.contains("length limit") || s.contains("too large") || s.contains("limit exceeded") {
            AppError::file_too_large(effective_max_bytes as usize)
        } else {
            AppError::validation(format!("Multipart stream error: {e}"))
        }
    })? {
        total_bytes += chunk.len() as u64;

        if total_bytes > effective_max_bytes {
            drop(temp_file);
            while let Some(Ok(_)) = field.next().await {}
            return Err(AppError::file_too_large(effective_max_bytes as usize));
        }

        if header_buf.len() < HEADER_SAMPLE_SIZE {
            let needed = HEADER_SAMPLE_SIZE - header_buf.len();
            let take_len = chunk.len().min(needed);
            header_buf.extend_from_slice(&chunk[..take_len]);
        }

        temp_file
            .write_all(&chunk)
            .await
            .map_err(|e| AppError::internal(format!("Failed to write chunk to temp file: {e}")))?;
    }

    temp_file
        .flush()
        .await
        .map_err(|e| AppError::internal(format!("Failed to flush temp file: {e}")))?;
    drop(temp_file);

    if total_bytes == 0 {
        return Err(AppError::validation("Uploaded file cannot be empty"));
    }

    // Validate magic bytes and MIME type
    let (detected_kind, mime) = detect_file_type(&header_buf, &sanitized_filename, kind_hint)?;

    // If auto-detected as image, verify byte limit against max_image_bytes
    if detected_kind == AssetKind::Image && total_bytes > max_image_bytes {
        return Err(AppError::file_too_large(max_image_bytes as usize));
    }

    // For images: verify dimensions without decoding full bitmap
    let (width, height) = if detected_kind == AssetKind::Image {
        let path_clone = temp_path.clone();
        let dims = tokio::task::spawn_blocking(move || inspect_image_dimensions(&path_clone))
            .await
            .map_err(|e| AppError::internal(format!("Dimension check task failed: {e}")))??;
        (Some(dims.0), Some(dims.1))
    } else {
        (None, None)
    };

    // Prepare media destination directory
    let media_dir = data_dir.join("media");
    tokio::fs::create_dir_all(&media_dir)
        .await
        .map_err(|e| AppError::internal(format!("Failed to create media directory: {e}")))?;

    let asset_id = Uuid::new_v4().to_string();
    let target_path = media_dir.join(&asset_id);

    // Atomically move from tmp to media
    atomic_move_file(&temp_path, &target_path)
        .await
        .map_err(|e| AppError::internal(format!("Failed to persist uploaded file: {e}")))?;

    // Disarm guard so temp file is not deleted
    guard.persist();

    Ok(UploadedFileMeta {
        id: asset_id.clone(),
        stored_name: asset_id,
        original_name: sanitized_filename,
        mime: mime.to_string(),
        byte_size: total_bytes,
        kind: detected_kind,
        width,
        height,
    })
}
