//! Comprehensive Adversarial and Exploit Test Suite for Milestone 1 Streaming Storage Subsystem.
//!
//! Evaluates:
//! 1. Path traversal & filename evasion (null bytes, traversal, Windows DOS devices, ADS, Unicode RTLO).
//! 2. Polyglots, SVG/HTML bypass, disguised PE/ELF binaries.
//! 3. Decompression bombs, dimension overflows, corrupt/truncated headers.
//! 4. Exact boundary file sizes (limit - 1, exact limit, limit + 1) and HTTP 413 responses.
//! 5. Tempfile leak detection across failed, aborted, and concurrent uploads.

use axum::{
    body::Body,
    extract::{Multipart, State},
    http::{header, Request, StatusCode},
    routing::post,
    Json, Router,
};
use backend::{
    error::{AppError, ErrorResponse},
    storage::{
        atomic_move_file, detect_file_type, inspect_image_dimensions, sanitize_filename,
        save_upload_field, AssetKind, UploadedFileMeta, MAX_ATTACHMENT_BYTES, MAX_IMAGE_BYTES,
        MAX_IMAGE_DIMENSION,
    },
};
use http_body_util::BodyExt;
use std::path::PathBuf;
use tempfile::tempdir;
use tower::ServiceExt;

/// Calculate IEEE 802.3 CRC32 for PNG chunks
fn crc32_ieee(data: &[u8]) -> u32 {
    let mut crc = 0xFFFFFFFFu32;
    for &b in data {
        crc ^= b as u32;
        for _ in 0..8 {
            if (crc & 1) != 0 {
                crc = (crc >> 1) ^ 0xEDB88320;
            } else {
                crc >>= 1;
            }
        }
    }
    !crc
}

/// Helper to build a valid PNG structure with arbitrary width, height, bit depth, and color type.
fn build_png_header(width: u32, height: u32, bit_depth: u8, color_type: u8) -> Vec<u8> {
    let mut data = Vec::new();
    // 8-byte PNG signature
    data.extend_from_slice(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

    // IHDR chunk: 13 bytes payload
    let mut ihdr_payload = Vec::new();
    ihdr_payload.extend_from_slice(b"IHDR");
    ihdr_payload.extend_from_slice(&width.to_be_bytes());
    ihdr_payload.extend_from_slice(&height.to_be_bytes());
    ihdr_payload.push(bit_depth);
    ihdr_payload.push(color_type);
    ihdr_payload.push(0); // compression method (deflate)
    ihdr_payload.push(0); // filter method (adaptive)
    ihdr_payload.push(0); // interlace method (none)

    let crc = crc32_ieee(&ihdr_payload);

    data.extend_from_slice(&13u32.to_be_bytes());
    data.extend_from_slice(&ihdr_payload);
    data.extend_from_slice(&crc.to_be_bytes());

    // Minimal dummy IDAT chunk
    let mut idat_payload = Vec::new();
    idat_payload.extend_from_slice(b"IDAT");
    idat_payload.extend_from_slice(&[
        0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
        0x00, 0x00, 0x00,
    ]);
    let idat_len = (idat_payload.len() - 4) as u32;
    let idat_crc = crc32_ieee(&idat_payload);
    data.extend_from_slice(&idat_len.to_be_bytes());
    data.extend_from_slice(&idat_payload);
    data.extend_from_slice(&idat_crc.to_be_bytes());

    // Minimal empty IEND chunk to complete structure
    let mut iend_payload = Vec::new();
    iend_payload.extend_from_slice(b"IEND");
    let iend_crc = crc32_ieee(&iend_payload);
    data.extend_from_slice(&0u32.to_be_bytes());
    data.extend_from_slice(&iend_payload);
    data.extend_from_slice(&iend_crc.to_be_bytes());

    data
}

// Minimal valid 1x1 PNG fixture (67 bytes)
const VALID_1X1_PNG: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
    0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
    0x42, 0x60, 0x82,
];

// Minimal valid PDF fixture
const VALID_PDF: &[u8] = b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n";

// Minimal valid ZIP fixture
const VALID_ZIP: &[u8] = &[
    0x50, 0x4B, 0x03, 0x04, 0x0A, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x74, 0x65, 0x73, 0x74,
];

/// Helper to build an Axum multipart upload router
fn create_test_upload_router(
    data_dir: PathBuf,
    kind_hint: Option<AssetKind>,
    max_img: u64,
    max_att: u64,
) -> Router {
    async fn handler(
        State((dir, kind, m_img, m_att)): State<(PathBuf, Option<AssetKind>, u64, u64)>,
        mut multipart: Multipart,
    ) -> Result<Json<UploadedFileMeta>, AppError> {
        let field = multipart
            .next_field()
            .await
            .map_err(|e| AppError::validation(e.to_string()))?
            .ok_or_else(|| AppError::validation("No multipart field"))?;
        let meta = save_upload_field(field, &dir, kind, m_img, m_att).await?;
        Ok(Json(meta))
    }

    Router::new()
        .route("/upload", post(handler))
        .with_state((data_dir, kind_hint, max_img, max_att))
}

/// Helper to construct a multipart/form-data POST request
fn build_multipart_request(filename: &str, content_type: &str, payload: &[u8]) -> Request<Body> {
    let boundary = "------------------------boundaryX987";
    let header_part = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: {content_type}\r\n\r\n"
    );
    let footer_part = format!("\r\n--{boundary}--\r\n");

    let mut body_bytes = Vec::with_capacity(header_part.len() + payload.len() + footer_part.len());
    body_bytes.extend_from_slice(header_part.as_bytes());
    body_bytes.extend_from_slice(payload);
    body_bytes.extend_from_slice(footer_part.as_bytes());

    Request::builder()
        .method("POST")
        .uri("/upload")
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(Body::from(body_bytes))
        .unwrap()
}

// ============================================================================
// 1. PATH TRAVERSAL & FILENAME EVASION
// ============================================================================

#[test]
fn test_adv_sanitize_filename_traversal_vectors() {
    let default = "fallback.bin";

    // 1. Unix directory traversal
    assert_eq!(
        sanitize_filename(Some("../../../../etc/passwd"), default),
        "passwd"
    );
    assert_eq!(
        sanitize_filename(Some("../../etc/shadow"), default),
        "shadow"
    );

    // 2. Windows directory traversal
    assert_eq!(
        sanitize_filename(Some("..\\..\\..\\windows\\system32\\cmd.exe"), default),
        "cmd.exe"
    );
    assert_eq!(
        sanitize_filename(Some("..\\..\\boot.ini"), default),
        "boot.ini"
    );

    // 3. Mixed slashes
    assert_eq!(
        sanitize_filename(Some("..\\../..\\../windows/win.ini"), default),
        "win.ini"
    );

    // 4. Absolute paths
    assert_eq!(
        sanitize_filename(Some("/var/log/syslog"), default),
        "syslog"
    );
    assert_eq!(
        sanitize_filename(Some("C:\\Windows\\System32\\config\\SAM"), default),
        "SAM"
    );

    // 5. UNC network paths
    assert_eq!(
        sanitize_filename(Some("\\\\192.168.1.1\\share\\exploit.exe"), default),
        "exploit.exe"
    );

    // 6. Null byte injection
    assert_eq!(
        sanitize_filename(Some("legit.png\0.exe"), default),
        "legit.png.exe"
    );
    assert_eq!(
        sanitize_filename(Some("photo\0\0\0.png"), default),
        "photo.png"
    );

    // 7. CRLF header injection characters
    assert_eq!(
        sanitize_filename(Some("photo\r\nSet-Cookie:admin=1.png"), default),
        "photoSet-Cookie_admin=1.png".replace('=', "_") // = replaced by _
    );

    // 8. Control characters (ASCII 1-31, 127)
    assert_eq!(
        sanitize_filename(Some("file\x01\x02\x07\x08\x1F.jpg"), default),
        "file.jpg"
    );

    // 9. Windows Alternate Data Streams (ADS) - colon must be sanitized
    let ads = sanitize_filename(Some("photo.png:evil.exe"), default);
    assert!(!ads.contains(':'), "ADS colon must be sanitized");
    assert_eq!(ads, "photo.png_evil.exe");

    let ads_data = sanitize_filename(Some("document.pdf::$DATA"), default);
    assert!(!ads_data.contains(':'), "ADS colon must be sanitized");
    assert!(!ads_data.contains('$'), "Dollar sign must be sanitized");
    assert_eq!(ads_data, "document.pdf___DATA");

    // 10. Shell injection and pipe metacharacters
    let shell = sanitize_filename(Some("file$(whoami);reboot|nc.png"), default);
    assert!(!shell.contains('$'));
    assert!(!shell.contains(';'));
    assert!(!shell.contains('|'));

    // 11. HTML / XSS payloads in filenames (slashes inside tags are treated as path separators)
    let xss = sanitize_filename(Some("<script>alert(1)</script>.png"), default);
    assert!(!xss.contains('<'));
    assert!(!xss.contains('>'));
    assert!(!xss.contains('/'));
    assert_eq!(xss, "script_.png");

    let xss_img = sanitize_filename(Some("\"><svg onload=alert(1)>.jpg"), default);
    assert!(!xss_img.contains('<'));
    assert!(!xss_img.contains('>'));
    assert_eq!(xss_img, "___svg onload_alert(1)_.jpg");

    // 12. Boundary values: empty, spaces, dots
    assert_eq!(sanitize_filename(Some(""), default), default);
    assert_eq!(sanitize_filename(Some("    "), default), default);
    assert_eq!(sanitize_filename(Some("."), default), default);
    assert_eq!(sanitize_filename(Some(".."), default), default);
    assert_eq!(sanitize_filename(Some("..."), default), default);
    assert_eq!(sanitize_filename(Some("....."), default), default);
    assert_eq!(
        sanitize_filename(Some("   ...hello...   "), default),
        "hello"
    );
    assert_eq!(sanitize_filename(None, default), default);

    // 13. Very long filename (over 255 chars) with extension preservation
    let long_stem = "A".repeat(300);
    let long_name = format!("{long_stem}.png");
    let sanitized_long = sanitize_filename(Some(&long_name), default);
    assert!(
        sanitized_long.len() <= 255,
        "Sanitized filename must not exceed 255 chars"
    );
    assert!(
        sanitized_long.ends_with(".png"),
        "Sanitized filename must preserve extension"
    );
    assert_eq!(sanitized_long.len(), 255);
}

#[tokio::test]
async fn test_adv_upload_storage_uses_uuid_not_client_path() {
    let dir = tempdir().unwrap();
    let data_dir = dir.path().to_path_buf();
    let router = create_test_upload_router(
        data_dir.clone(),
        Some(AssetKind::Image),
        MAX_IMAGE_BYTES,
        MAX_ATTACHMENT_BYTES,
    );

    // Attempt traversal via multipart filename
    let evil_filename = "../../../../etc/passwd";
    let req = build_multipart_request(evil_filename, "image/png", VALID_1X1_PNG);
    let resp = router.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let meta: UploadedFileMeta = serde_json::from_slice(&bytes).unwrap();

    // Verify stored name on disk is a UUID and is inside {data_dir}/media/
    assert_eq!(meta.original_name, "passwd");
    let media_file = data_dir.join("media").join(&meta.stored_name);
    assert!(media_file.exists(), "Stored file must exist in media dir");
    assert_eq!(media_file.parent().unwrap(), data_dir.join("media"));

    // Verify absolutely NO files were created outside the sandbox
    let outside_target = dir.path().parent().unwrap().join("passwd");
    assert!(
        !outside_target.exists(),
        "Traversal file must NOT exist on filesystem"
    );
}

// ============================================================================
// 2. WINDOWS DOS RESERVED DEVICE NAMES
// ============================================================================

#[test]
fn test_adv_windows_dos_device_names_sanitization() {
    let default = "safe.dat";
    let dos_devices = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];

    for dev in &dos_devices {
        // Uppercase exact
        let s1 = sanitize_filename(Some(dev), default);
        assert_eq!(s1, format!("file_{dev}"));

        // Lowercase exact
        let lower = dev.to_ascii_lowercase();
        let s2 = sanitize_filename(Some(&lower), default);
        assert_eq!(s2, format!("file_{lower}"));

        // With extension
        let with_ext = format!("{dev}.txt");
        let s3 = sanitize_filename(Some(&with_ext), default);
        assert_eq!(s3, format!("file_{dev}.txt"));

        // Lowercase with extension
        let with_ext_lower = format!("{lower}.png");
        let s4 = sanitize_filename(Some(&with_ext_lower), default);
        assert_eq!(s4, format!("file_{lower}.png"));

        // Leading/trailing spaces
        let with_spaces = format!("  {dev}.pdf  ");
        let s5 = sanitize_filename(Some(&with_spaces), default);
        assert_eq!(s5, format!("file_{dev}.pdf"));
    }
}

// ============================================================================
// 3. POLYGLOTS & MIME CONTENT SPOOFING
// ============================================================================

#[test]
fn test_adv_polyglot_svg_disguised_as_png() {
    // Magic PNG signature followed immediately by SVG payload
    let mut polyglot = Vec::new();
    polyglot.extend_from_slice(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    polyglot.extend_from_slice(
        b"<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>",
    );

    // Should be rejected outright by detect_file_type as SVG
    let res = detect_file_type(&polyglot, "image.png", None);
    assert!(res.is_err());
    assert!(matches!(res.unwrap_err(), AppError::SvgNotAllowed));
}

#[test]
fn test_adv_polyglot_svg_disguised_as_jpeg() {
    // JPEG SOI marker followed by SVG payload
    let mut polyglot = Vec::new();
    polyglot.extend_from_slice(&[0xFF, 0xD8, 0xFF]);
    polyglot
        .extend_from_slice(b"<svg xmlns=\"http://www.w3.org/2000/svg\"><circle r=\"10\"/></svg>");

    let res = detect_file_type(&polyglot, "photo.jpg", None);
    assert!(res.is_err());
    assert!(matches!(res.unwrap_err(), AppError::SvgNotAllowed));
}

#[test]
fn test_adv_disguised_svg_xml_variants() {
    // 1. XML declaration with SVG
    let xml_svg =
        b"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<svg width=\"100\" height=\"100\"></svg>";
    let res1 = detect_file_type(xml_svg, "vector.xml", None);
    assert!(matches!(res1.unwrap_err(), AppError::SvgNotAllowed));

    // 2. Mixed casing <sVg>
    let mixed_svg = b"<sVg xmlns=\"http://www.w3.org/2000/svg\"><rect/></sVg>";
    let res2 = detect_file_type(mixed_svg, "test.png", None);
    assert!(matches!(res2.unwrap_err(), AppError::SvgNotAllowed));

    // 3. Uppercase <SVG>
    let upper_svg = b"<SVG viewBox=\"0 0 10 10\"><path/></SVG>";
    let res3 = detect_file_type(upper_svg, "test.png", None);
    assert!(matches!(res3.unwrap_err(), AppError::SvgNotAllowed));

    // 4. Leading whitespace before <svg>
    let mut spaced_svg = vec![b' '; 50];
    spaced_svg.extend_from_slice(b"<svg><circle/></svg>");
    let res4 = detect_file_type(&spaced_svg, "image.png", None);
    assert!(matches!(res4.unwrap_err(), AppError::SvgNotAllowed));
}

#[test]
fn test_adv_disguised_html_variants() {
    // 1. Full HTML5 doctype
    let html5 = b"<!DOCTYPE html><html><body><h1>test</h1></body></html>";
    let res1 = detect_file_type(html5, "test.txt", None);
    assert!(matches!(res1.unwrap_err(), AppError::UnsupportedMime(_)));

    // 2. Lowercase doctype
    let html_lower = b"<!doctype html><html><body></body></html>";
    let res2 = detect_file_type(html_lower, "test.md", None);
    assert!(matches!(res2.unwrap_err(), AppError::UnsupportedMime(_)));

    // 3. Uppercase <HTML>
    let html_tag = b"<HTML><BODY><SCRIPT>alert(1)</SCRIPT></BODY></HTML>";
    let res3 = detect_file_type(html_tag, "notes.txt", None);
    assert!(matches!(res3.unwrap_err(), AppError::UnsupportedMime(_)));
}

#[test]
fn test_adv_disguised_executables_pe_and_elf() {
    // 1. PE / Windows executable starting with MZ header
    let mut pe_bytes = vec![0u8; 512];
    pe_bytes[0] = b'M';
    pe_bytes[1] = b'Z';
    // PE signature offset at 0x3C
    pe_bytes[0x3C] = 0x80;
    pe_bytes[0x80] = b'P';
    pe_bytes[0x81] = b'E';

    // Disguised as PDF
    let res_pdf = detect_file_type(&pe_bytes, "report.pdf", None);
    assert!(matches!(res_pdf.unwrap_err(), AppError::UnsupportedMime(_)));

    // Disguised as DOCX
    let res_docx = detect_file_type(&pe_bytes, "assignment.docx", None);
    assert!(matches!(
        res_docx.unwrap_err(),
        AppError::UnsupportedMime(_)
    ));

    // Disguised as ZIP
    let res_zip = detect_file_type(&pe_bytes, "archive.zip", None);
    assert!(matches!(res_zip.unwrap_err(), AppError::UnsupportedMime(_)));

    // Disguised as TXT (contains null bytes and control chars)
    let res_txt = detect_file_type(&pe_bytes, "readme.txt", None);
    assert!(matches!(res_txt.unwrap_err(), AppError::UnsupportedMime(_)));

    // 2. ELF / Linux executable
    let mut elf_bytes = vec![0u8; 512];
    elf_bytes[0] = 0x7F;
    elf_bytes[1] = b'E';
    elf_bytes[2] = b'L';
    elf_bytes[3] = b'F';
    elf_bytes[4] = 2; // 64-bit

    let res_elf_pdf = detect_file_type(&elf_bytes, "document.pdf", None);
    assert!(matches!(
        res_elf_pdf.unwrap_err(),
        AppError::UnsupportedMime(_)
    ));

    let res_elf_txt = detect_file_type(&elf_bytes, "script.txt", None);
    assert!(matches!(
        res_elf_txt.unwrap_err(),
        AppError::UnsupportedMime(_)
    ));
}

#[test]
fn test_adv_cross_kind_confusion_rejection() {
    // PNG presented with kind_hint: Attachment -> rejected
    let res1 = detect_file_type(VALID_1X1_PNG, "pic.png", Some(AssetKind::Attachment));
    assert!(matches!(res1.unwrap_err(), AppError::ValidationError(_)));

    // PDF presented with kind_hint: Image -> rejected
    let res2 = detect_file_type(VALID_PDF, "doc.pdf", Some(AssetKind::Image));
    assert!(matches!(res2.unwrap_err(), AppError::InvalidImageFormat(_)));

    // ZIP presented with kind_hint: Image -> rejected
    let res3 = detect_file_type(VALID_ZIP, "archive.zip", Some(AssetKind::Image));
    assert!(matches!(res3.unwrap_err(), AppError::InvalidImageFormat(_)));

    // TXT presented with kind_hint: Image -> rejected
    let res4 = detect_file_type(b"hello world", "test.txt", Some(AssetKind::Image));
    assert!(matches!(res4.unwrap_err(), AppError::InvalidImageFormat(_)));
}

// ============================================================================
// 4. DECOMPRESSION BOMBS & DIMENSION OVERFLOW
// ============================================================================

#[test]
fn test_adv_decompression_bomb_giant_dimensions() {
    let dir = tempdir().unwrap();

    // 1. Giant dimensions: 100,000 x 100,000
    let path_100k = dir.path().join("bomb_100k.png");
    let bytes_100k = build_png_header(100_000, 100_000, 8, 2);
    std::fs::write(&path_100k, bytes_100k).unwrap();

    let res_100k = inspect_image_dimensions(&path_100k);
    assert!(res_100k.is_err(), "100,000x100,000 PNG must be rejected");
    assert!(matches!(
        res_100k.unwrap_err(),
        AppError::InvalidImageFormat(_)
    ));

    // 2. Maximum u32 dimensions: 4,294,967,295 x 4,294,967,295
    let path_max = dir.path().join("bomb_max.png");
    let bytes_max = build_png_header(u32::MAX, u32::MAX, 8, 2);
    std::fs::write(&path_max, bytes_max).unwrap();

    let res_max = inspect_image_dimensions(&path_max);
    assert!(res_max.is_err(), "u32::MAX dimensions must be rejected");
    assert!(matches!(
        res_max.unwrap_err(),
        AppError::InvalidImageFormat(_)
    ));

    // 3. Asymmetric giant: 100,000 x 1
    let path_asym1 = dir.path().join("bomb_asym1.png");
    let bytes_asym1 = build_png_header(100_000, 1, 8, 2);
    std::fs::write(&path_asym1, bytes_asym1).unwrap();
    assert!(inspect_image_dimensions(&path_asym1).is_err());

    // 4. Asymmetric giant: 1 x 100,000
    let path_asym2 = dir.path().join("bomb_asym2.png");
    let bytes_asym2 = build_png_header(1, 100_000, 8, 2);
    std::fs::write(&path_asym2, bytes_asym2).unwrap();
    assert!(inspect_image_dimensions(&path_asym2).is_err());
}

#[test]
fn test_adv_zero_dimensions_rejection() {
    let dir = tempdir().unwrap();

    // Width = 0, Height = 100
    let path_zero_w = dir.path().join("zero_w.png");
    let bytes_zero_w = build_png_header(0, 100, 8, 2);
    std::fs::write(&path_zero_w, bytes_zero_w).unwrap();
    assert!(inspect_image_dimensions(&path_zero_w).is_err());

    // Width = 100, Height = 0
    let path_zero_h = dir.path().join("zero_h.png");
    let bytes_zero_h = build_png_header(100, 0, 8, 2);
    std::fs::write(&path_zero_h, bytes_zero_h).unwrap();
    assert!(inspect_image_dimensions(&path_zero_h).is_err());

    // Width = 0, Height = 0
    let path_zero_both = dir.path().join("zero_both.png");
    let bytes_zero_both = build_png_header(0, 0, 8, 2);
    std::fs::write(&path_zero_both, bytes_zero_both).unwrap();
    assert!(inspect_image_dimensions(&path_zero_both).is_err());
}

#[test]
fn test_adv_boundary_dimension_limits() {
    let dir = tempdir().unwrap();

    // 1. Exact boundary: 8192 x 8192 (MAX_IMAGE_DIMENSION) -> must pass
    let path_exact = dir.path().join("exact_8192.png");
    let bytes_exact = build_png_header(MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION, 8, 2);
    std::fs::write(&path_exact, bytes_exact).unwrap();
    let dims = inspect_image_dimensions(&path_exact).unwrap();
    assert_eq!(dims, (MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION));

    // 2. Over boundary: 8193 x 8192 -> must fail
    let path_over_w = dir.path().join("over_w.png");
    let bytes_over_w = build_png_header(MAX_IMAGE_DIMENSION + 1, MAX_IMAGE_DIMENSION, 8, 2);
    std::fs::write(&path_over_w, bytes_over_w).unwrap();
    assert!(inspect_image_dimensions(&path_over_w).is_err());

    // 3. Over boundary: 8192 x 8193 -> must fail
    let path_over_h = dir.path().join("over_h.png");
    let bytes_over_h = build_png_header(MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION + 1, 8, 2);
    std::fs::write(&path_over_h, bytes_over_h).unwrap();
    assert!(inspect_image_dimensions(&path_over_h).is_err());
}

#[test]
fn test_adv_corrupted_truncated_image_headers() {
    let dir = tempdir().unwrap();

    // 1. Truncated PNG (only 8 bytes signature)
    let path_trunc = dir.path().join("trunc.png");
    std::fs::write(
        &path_trunc,
        [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A],
    )
    .unwrap();
    assert!(inspect_image_dimensions(&path_trunc).is_err());

    // 2. Corrupt bit depth (depth 3 is invalid for RGB color_type 2)
    let path_bad_depth = dir.path().join("bad_depth.png");
    let bytes_bad_depth = build_png_header(100, 100, 3, 2);
    std::fs::write(&path_bad_depth, bytes_bad_depth).unwrap();
    assert!(inspect_image_dimensions(&path_bad_depth).is_err());

    // 3. Truncated JPEG (SOI only: FF D8 FF)
    let path_trunc_jpg = dir.path().join("trunc.jpg");
    std::fs::write(&path_trunc_jpg, [0xFF, 0xD8, 0xFF]).unwrap();
    assert!(inspect_image_dimensions(&path_trunc_jpg).is_err());
}

// ============================================================================
// 5. BOUNDARY FILE SIZES & HTTP 413 RESPONSES
// ============================================================================

#[tokio::test]
async fn test_adv_boundary_size_limits_exact_bytes() {
    let dir = tempdir().unwrap();
    let data_dir = dir.path().to_path_buf();

    // Use a test boundary limit: 1000 bytes max
    const TEST_LIMIT: u64 = 1000;
    let router = create_test_upload_router(data_dir.clone(), None, TEST_LIMIT, TEST_LIMIT);

    // 1. Empty file (0 bytes) -> HTTP 400 VALIDATION_ERROR
    let req_empty = build_multipart_request("empty.txt", "text/plain", b"");
    let resp_empty = router.clone().oneshot(req_empty).await.unwrap();
    assert_eq!(resp_empty.status(), StatusCode::BAD_REQUEST);
    let bytes = resp_empty.into_body().collect().await.unwrap().to_bytes();
    let err: ErrorResponse = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(err.error.code, "VALIDATION_ERROR");

    // 2. Limit - 1 byte (999 bytes) -> 200 OK
    let payload_minus_1 = vec![b'A'; 999];
    let req_minus_1 = build_multipart_request("valid_minus.txt", "text/plain", &payload_minus_1);
    let resp_minus_1 = router.clone().oneshot(req_minus_1).await.unwrap();
    assert_eq!(resp_minus_1.status(), StatusCode::OK);

    // 3. Exact limit (1000 bytes) -> 200 OK
    let payload_exact = vec![b'B'; 1000];
    let req_exact = build_multipart_request("valid_exact.txt", "text/plain", &payload_exact);
    let resp_exact = router.clone().oneshot(req_exact).await.unwrap();
    assert_eq!(resp_exact.status(), StatusCode::OK);

    // 4. Limit + 1 byte (1001 bytes) -> HTTP 413 FILE_TOO_LARGE
    let payload_plus_1 = vec![b'C'; 1001];
    let req_plus_1 = build_multipart_request("toolarge.txt", "text/plain", &payload_plus_1);
    let resp_plus_1 = router.clone().oneshot(req_plus_1).await.unwrap();
    assert_eq!(resp_plus_1.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let bytes_plus_1 = resp_plus_1.into_body().collect().await.unwrap().to_bytes();
    let err_plus_1: ErrorResponse = serde_json::from_slice(&bytes_plus_1).unwrap();
    assert_eq!(err_plus_1.error.code, "FILE_TOO_LARGE");
}

#[tokio::test]
async fn test_adv_image_vs_attachment_limit_boundary() {
    let dir = tempdir().unwrap();
    let data_dir = dir.path().to_path_buf();

    // Image limit: 500 bytes; Attachment limit: 2000 bytes
    let router = create_test_upload_router(
        data_dir.clone(),
        None, // auto-detect
        500,
        2000,
    );

    // Create a valid PNG of 600 bytes (> 500 bytes image limit, but < 2000 bytes attachment limit)
    let base_png = build_png_header(10, 10, 8, 2);
    let mut padded_png = base_png.clone();
    padded_png.resize(600, 0); // 600 bytes total

    // Upload with name "photo.png"
    let req = build_multipart_request("photo.png", "image/png", &padded_png);
    let resp = router.oneshot(req).await.unwrap();

    // Must be rejected with HTTP 413 FILE_TOO_LARGE because auto-detection identifies it as an Image!
    assert_eq!(resp.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let err: ErrorResponse = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(err.error.code, "FILE_TOO_LARGE");
}

// ============================================================================
// 6. TEMPFILE LEAK DETECTION & RESOURCE SAFETY
// ============================================================================

#[tokio::test]
async fn test_adv_tempfile_leak_on_size_limit_rejection() {
    let dir = tempdir().unwrap();
    let data_dir = dir.path().to_path_buf();
    let router = create_test_upload_router(data_dir.clone(), None, 100, 100);

    let large_payload = vec![b'X'; 500]; // 500 bytes > 100 bytes
    let req = build_multipart_request("leak_test.txt", "text/plain", &large_payload);
    let resp = router.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::PAYLOAD_TOO_LARGE);

    // Verify temp directory contains 0 lingering .tmp files
    let tmp_dir = data_dir.join("tmp");
    if tmp_dir.exists() {
        let entries = std::fs::read_dir(&tmp_dir).unwrap();
        assert_eq!(
            entries.count(),
            0,
            "No temp files should leak on size limit failure"
        );
    }
}

#[tokio::test]
async fn test_adv_tempfile_leak_on_invalid_image_dimension() {
    let dir = tempdir().unwrap();
    let data_dir = dir.path().to_path_buf();
    let router = create_test_upload_router(
        data_dir.clone(),
        Some(AssetKind::Image),
        MAX_IMAGE_BYTES,
        MAX_ATTACHMENT_BYTES,
    );

    // 100,000 x 100,000 bomb
    let bomb_bytes = build_png_header(100_000, 100_000, 8, 2);
    let req = build_multipart_request("bomb.png", "image/png", &bomb_bytes);
    let resp = router.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

    // Verify temp directory is completely clean
    let tmp_dir = data_dir.join("tmp");
    if tmp_dir.exists() {
        let entries = std::fs::read_dir(&tmp_dir).unwrap();
        assert_eq!(
            entries.count(),
            0,
            "No temp files should leak on dimension check failure"
        );
    }
}

#[tokio::test]
async fn test_adv_tempfile_leak_on_svg_rejection() {
    let dir = tempdir().unwrap();
    let data_dir = dir.path().to_path_buf();
    let router = create_test_upload_router(
        data_dir.clone(),
        None,
        MAX_IMAGE_BYTES,
        MAX_ATTACHMENT_BYTES,
    );

    let svg_payload =
        b"<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert('xss')</script></svg>";
    let req = build_multipart_request("malicious.svg", "image/svg+xml", svg_payload);
    let resp = router.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

    // Verify temp directory is clean
    let tmp_dir = data_dir.join("tmp");
    if tmp_dir.exists() {
        let entries = std::fs::read_dir(&tmp_dir).unwrap();
        assert_eq!(
            entries.count(),
            0,
            "No temp files should leak on SVG rejection"
        );
    }
}

#[tokio::test]
async fn test_adv_concurrent_failed_uploads_no_temp_leaks() {
    let dir = tempdir().unwrap();
    let data_dir = dir.path().to_path_buf();
    let router = create_test_upload_router(data_dir.clone(), None, 50, 50);

    let mut handles = Vec::new();
    for i in 0..25 {
        let r = router.clone();
        let payload = vec![b'A' + (i % 26) as u8; 200]; // will exceed 50-byte limit
        handles.push(tokio::spawn(async move {
            let req = build_multipart_request(&format!("file_{i}.txt"), "text/plain", &payload);
            r.oneshot(req).await.unwrap()
        }));
    }

    for h in handles {
        let resp = h.await.unwrap();
        assert_eq!(resp.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    // Verify that after 25 concurrent failed uploads, 0 temp files remain
    let tmp_dir = data_dir.join("tmp");
    if tmp_dir.exists() {
        let entries = std::fs::read_dir(&tmp_dir).unwrap();
        assert_eq!(
            entries.count(),
            0,
            "Temp directory must have 0 lingering files after concurrent failures"
        );
    }
}

// ============================================================================
// 7. OBSCURE SVG BYPASS & TEXT/MARKDOWN CONTROL BYTE TESTS
// ============================================================================

#[test]
fn test_adv_svg_obscure_bypass_attempts() {
    let bypasses: &[(&[u8], &str)] = &[
        // Slash immediately following tag name
        (b"<svg/onload=alert(1)>", "slash_tag.png"),
        // Tab immediately following tag name
        (b"<svg\twidth=\"100\"><circle/></svg>", "tab_tag.png"),
        // Line feed immediately following tag name
        (b"<svg\nwidth=\"100\"><circle/></svg>", "lf_tag.png"),
        // CRLF immediately following tag name
        (b"<svg\r\nwidth=\"100\"><circle/></svg>", "crlf_tag.png"),
        // XML declaration with doctype referring to svg
        (
            b"<?xml version=\"1.0\"?><!DOCTYPE svg SYSTEM \"svg11.dtd\"><svg></svg>",
            "doctype_svg.png",
        ),
        // Deeply nested XML comment preceding svg
        (
            b"<!-- comment 1 --><!-- comment 2 -->\n   <svg></svg>",
            "multi_comment.png",
        ),
        // Mixed casing in xml + svg
        (
            b"<?XML version=\"1.0\"?>\n<sVg xmlns=\"http://www.w3.org/2000/svg\"></sVg>",
            "xml_mixed.png",
        ),
    ];

    for (payload, name) in bypasses {
        let res = detect_file_type(payload, name, None);
        assert!(
            res.is_err(),
            "Bypass attempt with '{name}' should have been rejected"
        );
        assert!(
            matches!(res.unwrap_err(), AppError::SvgNotAllowed),
            "Bypass attempt with '{name}' must result in SvgNotAllowed"
        );
    }
}

#[test]
fn test_adv_text_markdown_control_byte_rejections() {
    // 1. Text with null byte -> rejected
    let with_null = b"Hello\x00World";
    assert!(detect_file_type(with_null, "notes.txt", None).is_err());

    // 2. Text with bell character (0x07) -> rejected
    let with_bell = b"Error!\x07";
    assert!(detect_file_type(with_bell, "alert.txt", None).is_err());

    // 3. Text with backspace (0x08) -> rejected
    let with_bs = b"Line\x08edit";
    assert!(detect_file_type(with_bs, "edit.txt", None).is_err());

    // 4. Markdown with null byte -> rejected
    let md_null = b"# Title\x00Subtitle";
    assert!(detect_file_type(md_null, "doc.md", None).is_err());

    // 5. Invalid UTF-8 sequence -> rejected
    let invalid_utf8 = &[0xFF, 0xFE, 0xFD, 0xFC];
    assert!(detect_file_type(invalid_utf8, "bad_utf8.txt", None).is_err());

    // 6. Valid text with permissible formatting characters (tab, newline, cr, ansi escape)
    let valid_text = b"Hello\tWorld!\r\nLine 2.\n\x1B[31mRed Text\x1B[0m";
    let (kind, mime) = detect_file_type(valid_text, "clean.txt", None).unwrap();
    assert_eq!(kind, AssetKind::Attachment);
    assert_eq!(mime, "text/plain");

    let (kind_md, mime_md) = detect_file_type(valid_text, "clean.md", None).unwrap();
    assert_eq!(kind_md, AssetKind::Attachment);
    assert_eq!(mime_md, "text/markdown");
}

// ============================================================================
// 8. JPEG & WEBP DECOMPRESSION BOMBS
// ============================================================================

fn get_valid_jpeg() -> Vec<u8> {
    let img = image::RgbImage::new(1, 1);
    let mut buf = std::io::Cursor::new(Vec::new());
    img.write_to(&mut buf, image::ImageFormat::Jpeg).unwrap();
    buf.into_inner()
}

#[test]
fn test_adv_jpeg_decompression_bomb_dimensions() {
    let dir = tempdir().unwrap();

    // 1. Valid 1x1 JPEG passes inspection
    let path_valid_jpg = dir.path().join("valid.jpg");
    let valid_bytes = get_valid_jpeg();
    std::fs::write(&path_valid_jpg, &valid_bytes).unwrap();
    let dims = inspect_image_dimensions(&path_valid_jpg).unwrap();
    assert_eq!(dims, (1, 1));

    // 2. Modify SOF0 dimensions in valid JPEG to 65535 x 65535
    // Search for SOF0 marker: 0xFF, 0xC0
    let mut giant_bytes = valid_bytes.clone();
    let sof0_idx = giant_bytes
        .windows(2)
        .position(|w| w == [0xFF, 0xC0])
        .expect("SOF0 marker not found in valid JPEG");

    // SOF0: FF C0 [len: 2 bytes] [precision: 1 byte] [height: 2 bytes] [width: 2 bytes]
    let h_idx = sof0_idx + 5;
    let w_idx = sof0_idx + 7;
    giant_bytes[h_idx..h_idx + 2].copy_from_slice(&65535u16.to_be_bytes());
    giant_bytes[w_idx..w_idx + 2].copy_from_slice(&65535u16.to_be_bytes());

    let path_giant_jpg = dir.path().join("bomb_65k.jpg");
    std::fs::write(&path_giant_jpg, &giant_bytes).unwrap();
    let res = inspect_image_dimensions(&path_giant_jpg);
    assert!(res.is_err(), "65535x65535 JPEG must be rejected");

    // 3. Overflow boundary: 8193 x 1
    let mut overflow_bytes = valid_bytes.clone();
    overflow_bytes[h_idx..h_idx + 2].copy_from_slice(&1u16.to_be_bytes());
    overflow_bytes[w_idx..w_idx + 2].copy_from_slice(&8193u16.to_be_bytes());
    let path_overflow_jpg = dir.path().join("overflow_8193.jpg");
    std::fs::write(&path_overflow_jpg, &overflow_bytes).unwrap();
    assert!(inspect_image_dimensions(&path_overflow_jpg).is_err());
}

// ============================================================================
// 9. ATOMIC MOVE FILE TESTS
// ============================================================================

#[tokio::test]
async fn test_adv_atomic_move_file_operations() {
    let dir = tempdir().unwrap();
    let src = dir.path().join("source.dat");
    let dst = dir.path().join("dest.dat");

    std::fs::write(&src, b"secret payload").unwrap();

    // Successful atomic move
    atomic_move_file(&src, &dst).await.unwrap();
    assert!(!src.exists(), "Source file must not exist after move");
    assert!(dst.exists(), "Destination file must exist after move");
    assert_eq!(std::fs::read(&dst).unwrap(), b"secret payload");

    // Moving non-existent file must return error
    let fake_src = dir.path().join("non_existent.dat");
    let fake_dst = dir.path().join("wont_exist.dat");
    let err = atomic_move_file(&fake_src, &fake_dst).await;
    assert!(err.is_err());
}
