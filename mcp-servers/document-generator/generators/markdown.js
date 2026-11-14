import fs from 'fs/promises';
import path from 'path';

/**
 * Generate a Markdown document
 * @param {string} content - The markdown content
 * @param {string} filename - Optional filename (without extension)
 * @param {string} outputPath - Directory to save the file
 * @returns {Promise<{filepath: string, filename: string, size: number}>}
 */
export async function generateMarkdown(content, filename, outputPath) {
  // Generate filename if not provided
  if (!filename) {
    const timestamp = Date.now();
    filename = `document_${timestamp}`;
  }
  
  // Ensure filename has .md extension
  if (!filename.endsWith('.md')) {
    filename = `${filename}.md`;
  }
  
  const filepath = path.join(outputPath, filename);
  
  // Ensure output directory exists
  await fs.mkdir(outputPath, { recursive: true });
  
  // Write the markdown file
  await fs.writeFile(filepath, content, 'utf-8');
  
  const stat = await fs.stat(filepath);
  
  return {
    filepath,
    filename,
    size: stat.size,
  };
}
