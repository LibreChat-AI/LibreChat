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

export interface MistralOCRError {
  detail?: string;
  message?: string;
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
}

export interface MistralOCRUploadResult {
  filename: string;
  bytes: number;
  filepath: string;
  text: string;
  images: string[];
}
