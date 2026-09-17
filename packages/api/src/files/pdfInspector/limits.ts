/**
 * Most pages the PDF parser will accept at all.
 *
 * Past the recovery cap, unprobed pages are reported as needing OCR, which asks a
 * configured provider to process the whole document. This ceiling matches what those
 * services accept and stops over-limit documents before optional classification.
 */
export const MAX_PDF_PAGES = 1000;
