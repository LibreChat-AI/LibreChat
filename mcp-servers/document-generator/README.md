# Document Generator MCP Server

MCP (Model Context Protocol) server for generating PDF and Markdown documents from text, markdown, or HTML content.

## Features

- **Markdown Generation**: Create `.md` files from any text format
- **PDF Generation**: Create `.pdf` files with automatic formatting
- **Smart Content Detection**: Automatically detects plain text, markdown, or HTML
- **Flexible Input**: Accepts content in plain text, markdown, or HTML format

## Tools

### generate_markdown

Generate a Markdown document from text, markdown, or HTML content.

**Parameters:**
- `content` (required): The document content (plain text, markdown, or HTML)
- `filename` (optional): Filename without extension. If not provided, a timestamp-based name will be used.

**Example:**
```javascript
{
  "name": "generate_markdown",
  "arguments": {
    "content": "# My Document\n\nThis is a **markdown** document.",
    "filename": "my_document"
  }
}
```

### generate_pdf

Generate a PDF document from text, markdown, or HTML content.

**Parameters:**
- `content` (required): The document content (plain text, markdown, or HTML)
- `filename` (optional): Filename without extension. If not provided, a timestamp-based name will be used.
- `title` (optional): Document title for PDF metadata
- `fontSize` (optional): Base font size (default: 12)

**Example:**
```javascript
{
  "name": "generate_pdf",
  "arguments": {
    "content": "# My Document\n\nThis is a **PDF** document.",
    "filename": "my_document",
    "title": "My Document Title",
    "fontSize": 14
  }
}
```

## Configuration

### Environment Variables

- `DOCUMENTS_PATH`: Directory where generated documents will be saved (default: `/app/uploads/documents`)

### LibreChat Configuration

Add the following to your `librechat.yaml`:

```yaml
mcpServers:
  document-generator:
    type: stdio
    command: node
    args:
      - '/app/mcp-servers/document-generator/index.js'
    env:
      DOCUMENTS_PATH: '/app/uploads/documents'
    timeout: 120000
```

## Installation

The server is included in the LibreChat Docker image. If you need to install dependencies manually:

```bash
cd librechat/mcp-servers/document-generator
npm install
```

## Output Location

Generated documents are saved to:
- Default: `/app/uploads/documents/`
- Custom: Set `DOCUMENTS_PATH` environment variable

## Supported Content Formats

### Plain Text
```
This is a plain text document.

It will be automatically formatted for the target format.
```

### Markdown
```markdown
# Heading 1

## Heading 2

This is **bold** and *italic* text.

- List item 1
- List item 2

```code block```
```

### HTML
```html
<h1>Heading 1</h1>
<h2>Heading 2</h2>
<p>This is <strong>bold</strong> and <em>italic</em> text.</p>
<ul>
  <li>List item 1</li>
  <li>List item 2</li>
</ul>
```

## Usage Examples

### Generate a Markdown document from plain text
```
User: Create a markdown document with the following content:
"Meeting Notes - 2026-07-05

Attendees: John, Jane, Bob

Agenda:
1. Project status update
2. Next steps
3. Q&A"

AI: [Calls generate_markdown tool]
```

### Generate a PDF from markdown
```
User: Generate a PDF document from this markdown:
"# Project Report

## Summary
This project has achieved all its goals.

## Key Metrics
- Completion: 100%
- Budget: On track
- Timeline: Ahead of schedule"

AI: [Calls generate_pdf tool]
```

### Generate a PDF from HTML
```
User: Create a PDF from this HTML:
"<h1>Invoice #12345</h1>
<p>Date: 2026-07-05</p>
<table>
  <tr><th>Item</th><th>Amount</th></tr>
  <tr><td>Service A</td><td>$100</td></tr>
  <tr><td>Service B</td><td>$200</td></tr>
</table>"

AI: [Calls generate_pdf tool]
```

## Dependencies

- `@modelcontextprotocol/sdk`: MCP protocol implementation
- `pdfkit`: PDF generation library
- `marked`: Markdown to HTML converter

## License

MIT
