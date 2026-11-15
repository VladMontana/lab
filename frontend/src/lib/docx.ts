/**
 * DOCX to Markdown converter for LabNotes.
 * Converts Microsoft Word (.docx) documents into clean Markdown,
 * preserving headings, lists, bold/italic, tables, code blocks,
 * and extracting embedded images with automatic server upload.
 */

import mammoth from 'mammoth';

export interface DocxConvertOptions {
  /** Optional callback to upload extracted images to the server */
  uploadImage?: (blob: Blob, filename: string, contentType: string) => Promise<string>;
}

export interface DocxConvertResult {
  /** Final converted Markdown content */
  markdown: string;
  /** Extracted document title (if found in headings) */
  title?: string;
  /** Total count of images discovered in the document */
  imageCount: number;
  /** Count of images successfully uploaded to the server */
  uploadedImagesCount: number;
  /** Warnings reported by the converter */
  warnings: string[];
}

/**
 * Converts a .docx ArrayBuffer to Markdown format.
 */
export async function convertDocxToMarkdown(
  arrayBuffer: ArrayBuffer,
  options: DocxConvertOptions = {}
): Promise<DocxConvertResult> {
  let imageCount = 0;
  let uploadedImagesCount = 0;
  let imageIndex = 0;

  const mammothOptions: mammoth.ConvertOptions = {
    ignoreEmptyParagraphs: true,
    convertImage: mammoth.images.imgElement(async (image: mammoth.ImageElement) => {
      imageCount++;
      const currentIdx = ++imageIndex;
      const contentType = image.contentType || 'image/png';
      const altText = image.altText || `Рисунок ${currentIdx}`;

      // Derive appropriate file extension
      let ext = 'png';
      if (contentType.includes('jpeg') || contentType.includes('jpg')) ext = 'jpg';
      else if (contentType.includes('webp')) ext = 'webp';
      else if (contentType.includes('gif')) ext = 'gif';

      const filename = `docx_image_${Date.now()}_${currentIdx}.${ext}`;

      // If an upload handler was provided, try uploading to the server
      if (options.uploadImage) {
        try {
          const rawBuffer = await image.readAsArrayBuffer();
          const blob = new Blob([rawBuffer], { type: contentType });
          const uploadedUrl = await options.uploadImage(blob, filename, contentType);
          if (uploadedUrl) {
            uploadedImagesCount++;
            return {
              src: uploadedUrl,
              altText,
            };
          }
        } catch (err) {
          console.warn('[DocxConvert] Failed to upload image to server, falling back to data URI:', err);
        }
      }

      // Fallback: inline data-URI so images are never lost
      const base64 = await image.readAsBase64String();
      return {
        src: `data:${contentType};base64,${base64}`,
        altText,
      };
    }),
  };

  const input: { arrayBuffer: ArrayBuffer; buffer?: any } = { arrayBuffer };
  const globalBuf = (globalThis as any).Buffer;
  if (globalBuf && typeof globalBuf.from === 'function') {
    input.buffer = globalBuf.from(arrayBuffer);
  }

  const result = await mammoth.convertToMarkdown(input, mammothOptions);

  // Post-process Markdown:
  // 1. Mammoth escapes characters like \- and \_ in image/link URLs: ![alt](/media/abc\-123) -> ![alt](/media/abc-123)
  const cleanedMarkdown = result.value.replace(
    /(!?\[.*?\]\()([^)]+)(\))/g,
    (_match, prefix, url, suffix) => {
      const cleanUrl = url.replace(/\\([-_.~!*'();:@&=+$,/?#[\]])/g, '$1');
      return `${prefix}${cleanUrl}${suffix}`;
    }
  );

  // 2. Extract title if the document starts with or contains a top-level Heading 1
  let title: string | undefined;
  const titleMatch = cleanedMarkdown.match(/^#\s+(.+)$/m);
  if (titleMatch && titleMatch[1]) {
    title = titleMatch[1].trim();
  }

  const warnings = result.messages
    .filter((m) => m.type === 'warning')
    .map((m) => m.message);

  return {
    markdown: cleanedMarkdown,
    title,
    imageCount,
    uploadedImagesCount,
    warnings,
  };
}
