/// <reference types="svelte" />
/// <reference types="vite/client" />

declare module 'mammoth' {
  export interface ImageElement {
    contentType: string;
    altText?: string;
    read(encoding?: string): Promise<any>;
    readAsArrayBuffer(): Promise<ArrayBuffer>;
    readAsBase64String(): Promise<string>;
  }

  export interface ImageAttributes {
    src: string;
    altText?: string;
  }

  export interface ConvertOptions {
    convertImage?: (image: ImageElement) => Promise<ImageAttributes> | ImageAttributes;
    styleMap?: string | string[];
    includeDefaultStyleMap?: boolean;
    ignoreEmptyParagraphs?: boolean;
  }

  export interface Result {
    value: string;
    messages: Array<{
      type: 'warning' | 'error';
      message: string;
    }>;
  }

  export function convertToMarkdown(
    input: { arrayBuffer?: ArrayBuffer; buffer?: Buffer },
    options?: ConvertOptions
  ): Promise<Result>;

  export function convertToHtml(
    input: { arrayBuffer?: ArrayBuffer; buffer?: Buffer },
    options?: ConvertOptions
  ): Promise<Result>;

  export namespace images {
    export function imgElement(
      func: (image: ImageElement) => Promise<ImageAttributes> | ImageAttributes
    ): (image: ImageElement) => Promise<ImageAttributes> | ImageAttributes;
    export function dataUri(image: ImageElement): Promise<ImageAttributes>;
  }
}
