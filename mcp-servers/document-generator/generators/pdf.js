import PDFDocument from 'pdfkit';
import { marked } from 'marked';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';

/**
 * Detect content type (plain, markdown, or html)
 * @param {string} content - The content to analyze
 * @returns {string} - 'html', 'markdown', or 'plain'
 */
function detectContentType(content) {
  // Check for HTML tags
  if (/<[a-z][\s\S]*>/i.test(content)) {
    return 'html';
  }
  
  // Check for Markdown syntax
  const markdownPatterns = [
    /^#{1,6}\s+/m,           // Headers
    /\*\*[^*]+\*\*/m,        // Bold
    /\*[^*]+\*/m,            // Italic
    /`[^`]+`/m,              // Inline code
    /```[\s\S]+?```/m,       // Code blocks
    /^\s*[-*+]\s+/m,         // Lists
    /^\s*\d+\.\s+/m,         // Numbered lists
    /\[([^\]]+)\]\([^)]+\)/m // Links
  ];
  
  for (const pattern of markdownPatterns) {
    if (pattern.test(content)) {
      return 'markdown';
    }
  }
  
  return 'plain';
}

/**
 * Convert content to HTML
 * @param {string} content - The content to convert
 * @param {string} contentType - The type of content
 * @returns {string} - HTML content
 */
function convertToHTML(content, contentType) {
  if (contentType === 'html') {
    return content;
  }
  
  if (contentType === 'markdown') {
    return marked(content);
  }
  
  // Plain text - wrap in paragraphs
  const paragraphs = content.split('\n\n').filter(p => p.trim());
  return paragraphs.map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('\n');
}

/**
 * Simple HTML to text converter for PDF
 * Extracts text content from HTML
 * @param {string} html - HTML content
 * @returns {Array<{type: string, content: string, level?: number}>} - Parsed elements
 */
function parseHTML(html) {
  const elements = [];
  
  // Remove HTML comments
  html = html.replace(/<!--[\s\S]*?-->/g, '');
  
  // Extract headings
  const headingRegex = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let match;
  
  // First pass: extract headings
  const tempHtml = html;
  while ((match = headingRegex.exec(tempHtml)) !== null) {
    const level = parseInt(match[1]);
    const content = match[2].replace(/<[^>]+>/g, '').trim();
    elements.push({ type: 'heading', content, level });
  }
  
  // Extract paragraphs
  const paragraphRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  while ((match = paragraphRegex.exec(html)) !== null) {
    const content = match[1].replace(/<[^>]+>/g, '').trim();
    if (content) {
      elements.push({ type: 'paragraph', content });
    }
  }
  
  // Extract list items
  const listRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  while ((match = listRegex.exec(html)) !== null) {
    const content = match[1].replace(/<[^>]+>/g, '').trim();
    if (content) {
      elements.push({ type: 'listitem', content });
    }
  }
  
  // Extract code blocks
  const codeRegex = /<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi;
  while ((match = codeRegex.exec(html)) !== null) {
    const content = match[1].replace(/<[^>]+>/g, '').trim();
    if (content) {
      elements.push({ type: 'code', content });
    }
  }
  
  // If no elements found, treat as plain text
  if (elements.length === 0) {
    const textContent = html.replace(/<[^>]+>/g, '').trim();
    if (textContent) {
      elements.push({ type: 'paragraph', content: textContent });
    }
  }
  
  return elements;
}

/**
 * Generate a PDF document from content
 * @param {string} content - The content (plain text, markdown, or HTML)
 * @param {string} filename - Optional filename (without extension)
 * @param {string} outputPath - Directory to save the file
 * @param {Object} options - Optional settings
 * @param {string} options.title - Document title
 * @param {number} options.fontSize - Base font size (default: 12)
 * @returns {Promise<{filepath: string, filename: string, size: number}>}
 */
export async function generatePDF(content, filename, outputPath, options = {}) {
  // Generate filename if not provided
  if (!filename) {
    const timestamp = Date.now();
    filename = `document_${timestamp}`;
  }
  
  // Ensure filename has .pdf extension
  if (!filename.endsWith('.pdf')) {
    filename = `${filename}.pdf`;
  }
  
  const filepath = path.join(outputPath, filename);
  
  // Ensure output directory exists
  await fs.mkdir(outputPath, { recursive: true });
  
  // Detect content type and convert to HTML
  const contentType = detectContentType(content);
  const html = convertToHTML(content, contentType);
  
  // Parse HTML into elements
  const elements = parseHTML(html);
  
  // Create PDF document
  const doc = new PDFDocument({
    size: 'A4',
    margins: {
      top: 72,
      bottom: 72,
      left: 72,
      right: 72
    },
    info: {
      Title: options.title || filename,
      Author: 'LibreChat Document Generator'
    }
  });
  
  // Pipe to file
  const stream = fsSync.createWriteStream(filepath);
  doc.pipe(stream);
  
  const baseFontSize = options.fontSize || 12;
  
  // Render elements
  for (const element of elements) {
    switch (element.type) {
      case 'heading':
        const headingSize = baseFontSize + (7 - element.level) * 2;
        doc.fontSize(headingSize).font('Helvetica-Bold').text(element.content, {
          align: 'left'
        });
        doc.moveDown(0.5);
        break;
        
      case 'paragraph':
        doc.fontSize(baseFontSize).font('Helvetica').text(element.content, {
          align: 'left'
        });
        doc.moveDown();
        break;
        
      case 'listitem':
        doc.fontSize(baseFontSize).font('Helvetica').text(`• ${element.content}`, {
          indent: 20
        });
        doc.moveDown(0.3);
        break;
        
      case 'code':
        doc.fontSize(baseFontSize - 2).font('Courier');
        doc.text(element.content, {
          indent: 10,
          fill: '#333333'
        });
        doc.fill('#000000');
        doc.moveDown();
        break;
    }
  }
  
  // Finalize PDF
  doc.end();
  
  // Wait for stream to finish
  await new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
  
  const stat = fsSync.statSync(filepath);
  
  return {
    filepath,
    filename,
    size: stat.size,
  };
}
