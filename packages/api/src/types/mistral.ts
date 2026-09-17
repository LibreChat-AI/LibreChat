/**
 * Mistral OCR API Types
 * Based on https://docs.mistral.ai/api/#tag/ocr/operation/ocr_v1_ocr_post
 */

export interface MistralFileUploadResponse {
  id: string;
  object: string;
  bytes: number;
  created_at: number;
  filename: string;
  purpose: string;
}

export interface MistralSignedUrlResponse {
  url: string;
  expires_at: number;
}

export interface OCRImage {
  id: string;
  top_left_x: number;
  top_left_y: number;
  bottom_right_x: number;
  bottom_right_y: number;
  image_base64: string;
  image_annotation?: string;
}

export interface PageDimensions {
  dpi: number;
  height: number;
  width: number;
}

export interface OCRResultPage {
  index: number;
  markdown: string;
  images: OCRImage[];
  dimensions: PageDimensions;
}

export interface OCRUsageInfo {
  pages_processed: number;
  doc_size_bytes: number;
}

export interface OCRResult {
  pages: OCRResultPage[];
  model: string;
  document_annotation?: string | null;
  usage_info: OCRUsageInfo;
}

export interface MistralOCRRequest {
  model: string;
  image_limit?: number;
  include_image_base64?: boolean;
  document: {
    type: 'document_url' | 'image_url';
    document_url?: string;
    image_url?: string;
  };
}

export interface MistralOCRError {
  detail?: string;
  message?: string;
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
}

/** Fields every text-extraction upload result carries, whichever engine produced it. */
export interface ExtractedTextUploadResult {
  filename: string;
  bytes: number;
  filepath: string;
  text: string;
  images: string[];
}

/**
 * Built-in document parser output. It is the only producer that can tell which pages
 * held no extractable text, so `pagesNeedingOcr` belongs to this shape alone; the
 * Mistral OCR endpoints return `ExtractedTextUploadResult`.
 */
export interface ParsedDocumentUploadResult extends ExtractedTextUploadResult {
  /** 1-indexed pages whose text could not be extracted and would need an OCR service. */
  pagesNeedingOcr?: number[];
  /**
   * This extraction may have dropped non-text content, so the upload path reads it as
   * "consult OCR if configured". Each engine answers from what it can observe: one that
   * reports pages sets it from a page it could not read, one that returns undifferentiated
   * text sets it from artwork found in the container. Deliberately "may": an engine that
   * cannot inspect its input reports it rather than claim completeness it cannot prove.
   */
  mayOmitContent?: boolean;
}

/**
 * Widest upload-result shape, kept for the existing consumers. New code should pick
 * the precise one: `ExtractedTextUploadResult` for the Mistral OCR endpoints, which
 * never report omitted pages, and `ParsedDocumentUploadResult` for `parseDocument`.
 */
export type MistralOCRUploadResult = ParsedDocumentUploadResult;
