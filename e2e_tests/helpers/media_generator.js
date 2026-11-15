// e2e_tests/helpers/media_generator.js - Proposed remediation for Iteration 2
import { Buffer } from 'node:buffer';

/**
 * Generates in-memory binary media and attachment files for testing.
 * All files are constructed programmatically without disk writes.
 */
export class MediaGenerator {
  /**
   * Minimal valid 1x1 PNG image (70 bytes).
   * Starts with magic bytes: 89 50 4E 47 0D 0A 1A 0A.
   * @param {string} [filename='test.png']
   * @returns {File}
   */
  static createPng(filename = 'test.png') {
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const buffer = Buffer.from(base64, 'base64');
    return new File([buffer], filename, { type: 'image/png' });
  }

  /**
   * Minimal valid 1x1 JFIF JPEG image (151 bytes).
   * Starts with SOI marker FF D8, ends with EOI marker FF D9.
   * @param {string} [filename='test.jpg']
   * @returns {File}
   */
  static createJpeg(filename = 'test.jpg') {
    const hex = 'ffd8ffe000104a46494600010101004800480000ffdb004300030202020202030202020303030304060404040404080606050609080a0a090809090a0c100a0a0b0b0a090f150c0b0c1410161517171610141a1c18171c16161715ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffda0008010100003f007f00ffd9';
    const buffer = Buffer.from(hex, 'hex');
    return new File([buffer], filename, { type: 'image/jpeg' });
  }

  /**
   * Minimal valid 1x1 WebP image (44 bytes).
   * Starts with RIFF....WEBP.
   * @param {string} [filename='test.webp']
   * @returns {File}
   */
  static createWebp(filename = 'test.webp') {
    const base64 = 'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAD8D+JaQAA3AA/ua1AAA=';
    const buffer = Buffer.from(base64, 'base64');
    return new File([buffer], filename, { type: 'image/webp' });
  }

  /**
   * Valid SVG XML file.
   * Used to verify that SVG is explicitly rejected as an image (400 SVG_NOT_ALLOWED).
   * @param {string} [filename='image.svg']
   * @returns {File}
   */
  static createSvg(filename = 'image.svg') {
    const svgContent = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>';
    return new File([Buffer.from(svgContent, 'utf-8')], filename, { type: 'image/svg+xml' });
  }

  /**
   * Invalid/corrupted image with PNG extension and MIME type but invalid magic bytes.
   * Used to test magic byte validation failure (400 INVALID_IMAGE_FORMAT).
   * @param {string} [filename='corrupt.png']
   * @returns {File}
   */
  static createCorruptedImage(filename = 'corrupt.png') {
    const fakeData = 'THIS_IS_DEFINITELY_NOT_A_VALID_IMAGE_FILE_BUFFER';
    return new File([Buffer.from(fakeData, 'utf-8')], filename, { type: 'image/png' });
  }

  /**
   * Oversized image (> 10 MiB limit = 10 * 1024 * 1024 + 1024 bytes).
   * Starts with valid PNG signature to verify server size rejection (413 FILE_TOO_LARGE).
   * @param {string} [filename='giant.png']
   * @returns {File}
   */
  static createOversizedImage(filename = 'giant.png') {
    const size = 10 * 1024 * 1024 + 1024; // 10 MiB + 1 KiB
    const buf = Buffer.alloc(size);
    Buffer.from('89504e470d0a1a0a', 'hex').copy(buf, 0);
    return new File([buf], filename, { type: 'image/png' });
  }

  /**
   * Minimal valid empty ZIP archive (22 bytes, valid End of Central Directory record).
   * Starts with 50 4B 05 06.
   * @param {string} [filename='archive.zip']
   * @returns {File}
   */
  static createZip(filename = 'archive.zip') {
    const zipEocd = Buffer.from([
      0x50, 0x4b, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    return new File([zipEocd], filename, { type: 'application/zip' });
  }

  /**
   * Minimal valid PDF document header and trailer (%PDF-1.4 ... %%EOF).
   * @param {string} [filename='document.pdf']
   * @returns {File}
   */
  static createPdf(filename = 'document.pdf') {
    const pdfContent = '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF';
    return new File([Buffer.from(pdfContent, 'utf-8')], filename, { type: 'application/pdf' });
  }

  /**
   * Valid text or markdown document.
   * @param {string} [filename='notes.md']
   * @param {string} [content]
   * @returns {File}
   */
  static createText(filename = 'notes.md', content = '# Lab Notes Attachment\nSample attachment content.\n') {
    return new File([Buffer.from(content, 'utf-8')], filename, { type: 'text/markdown' });
  }

  /**
   * Oversized attachment (> 50 MiB limit = 50 * 1024 * 1024 + 1024 bytes).
   * Starts with ZIP signature to verify size rejection (413 FILE_TOO_LARGE).
   * @param {string} [filename='heavy.zip']
   * @returns {File}
   */
  static createOversizedAttachment(filename = 'heavy.zip') {
    const size = 50 * 1024 * 1024 + 1024; // 50 MiB + 1 KiB
    const buf = Buffer.alloc(size);
    // Write ZIP Local File Header signature 50 4B 03 04
    buf[0] = 0x50;
    buf[1] = 0x4b;
    buf[2] = 0x03;
    buf[3] = 0x04;
    return new File([buf], filename, { type: 'application/zip' });
  }

  /**
   * Malicious file with path traversal characters in filename.
   * Used to verify path traversal sanitization and rejection.
   * @param {string} [filename='../../etc/passwd']
   * @returns {File}
   */
  static createPathTraversalFile(filename = '../../etc/passwd') {
    return new File([Buffer.from('traversal_payload_test', 'utf-8')], filename, { type: 'text/plain' });
  }

  // Explicit aliases conforming to generate* naming convention
  static generatePng = MediaGenerator.createPng;
  static generateJpeg = MediaGenerator.createJpeg;
  static generateWebp = MediaGenerator.createWebp;
  static generateSvg = MediaGenerator.createSvg;
  static generateCorruptedImage = MediaGenerator.createCorruptedImage;
  static generateOversizedImage = MediaGenerator.createOversizedImage;
  static generateZip = MediaGenerator.createZip;
  static generatePdf = MediaGenerator.createPdf;
  static generateText = MediaGenerator.createText;
  static generateOversizedAttachment = MediaGenerator.createOversizedAttachment;
  static generatePathTraversalFile = MediaGenerator.createPathTraversalFile;
}
