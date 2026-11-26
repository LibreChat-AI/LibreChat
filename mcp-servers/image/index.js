import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import path from 'path';

const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY;
const DASHSCOPE_BASE_URL = process.env.DASHSCOPE_BASE_URL || 'https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
const DASHSCOPE_EDIT_API_KEY = process.env.DASHSCOPE_EDIT_API_KEY || DASHSCOPE_API_KEY;
const DASHSCOPE_EDIT_BASE_URL = process.env.DASHSCOPE_EDIT_BASE_URL || DASHSCOPE_BASE_URL;
const IMAGE_MODEL = process.env.IMAGE_MODEL || 'qwen-image-2.0-pro';
const IMAGE_EDIT_MODEL = process.env.IMAGE_EDIT_MODEL || 'qwen-image-edit-max';
const IMAGES_PATH = process.env.IMAGES_PATH || '/app/generated_files/';
const UPLOADS_ROOT = process.env.UPLOADS_ROOT || '/app/uploads';
const PUBLIC_IMAGES_ROOT = process.env.PUBLIC_IMAGES_ROOT || '/app/client/public/images';

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

if (!DASHSCOPE_API_KEY) {
  console.error('Error: DASHSCOPE_API_KEY environment variable is required');
  process.exit(1);
}

// Ensure images directory exists
try {
  fs.mkdirSync(IMAGES_PATH, { recursive: true });
} catch (err) {
  console.error(`Warning: Could not create images directory: ${err.message}`);
}

function generateFilename(prompt) {
  // Create a clean filename from the prompt
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const cleanPrompt = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 50);
  return `img_${timestamp}_${cleanPrompt}.png`;
}

function saveImageToDisk(base64, filename) {
  const filepath = path.join(IMAGES_PATH, filename);
  const buffer = Buffer.from(base64, 'base64');
  fs.writeFileSync(filepath, buffer);
  return filepath;
}

/**
 * Resolves a local filesystem path from a LibreChat path or self-hosted URL.
 * Returns null for external URLs and unresolvable inputs.
 */
function resolveLocalImagePath(input) {
  if (!input || input.startsWith('data:')) {
    return null;
  }
  let pathname = input;
  if (/^https?:\/\//i.test(input)) {
    try {
      pathname = decodeURIComponent(new URL(input).pathname);
    } catch {
      return null;
    }
  }
  if (!pathname.startsWith('/')) {
    pathname = `/${pathname}`;
  }
  if (pathname.startsWith('/uploads/')) {
    return path.join(UPLOADS_ROOT, pathname.slice('/uploads/'.length));
  }
  if (pathname.startsWith('/images/')) {
    return path.join(PUBLIC_IMAGES_ROOT, pathname.slice('/images/'.length));
  }
  if (pathname.startsWith('/app/')) {
    return pathname;
  }
  return null;
}

const RAW_BASE64_RE = /^[A-Za-z0-9+/=\s]{100,}$/;

function looksLikeRawBase64(input) {
  return !input.startsWith('data:') && !/^https?:\/\//i.test(input) && RAW_BASE64_RE.test(input);
}

/** Guesses an image mime type from base64 magic bytes. */
function sniffBase64Mime(base64) {
  if (base64.startsWith('/9j/')) {
    return 'image/jpeg';
  }
  if (base64.startsWith('iVBOR')) {
    return 'image/png';
  }
  if (base64.startsWith('R0lGOD')) {
    return 'image/gif';
  }
  if (base64.startsWith('UklGR')) {
    return 'image/webp';
  }
  return 'image/png';
}

const IMAGE_FILE_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;

function isImageFile(filename) {
  return IMAGE_FILE_RE.test(filename);
}

/**
 * Lists the image directories where LibreChat stores user attachments,
 * public images and MCP-generated files (subdirectories of the roots).
 */
function collectImageDirs() {
  const roots = [UPLOADS_ROOT, PUBLIC_IMAGES_ROOT, IMAGES_PATH];
  const out = [];
  for (const root of roots) {
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          out.push(path.join(root, entry.name));
        }
      }
    } catch {
      /* root missing — skip */
    }
  }
  return [IMAGES_PATH, ...out];
}

/**
 * Fuzzy-matches a model-provided reference against stored files.
 * Models see attached images inline but never learn their real path, so they
 * often send a plausible-but-wrong path (e.g. /uploads/userid/foo.png while
 * the real file is /uploads/{userId}/{fileId}__foo.png). Match by basename
 * containment across all image directories and return the newest hit.
 */
function fuzzyFindImage(reference) {
  const basename = path.posix.basename(reference.trim()).toLowerCase();
  if (!basename || basename === '/' || !basename.includes('.')) {
    return null;
  }
  const candidates = [];
  for (const dir of collectImageDirs()) {
    try {
      for (const entry of fs.readdirSync(dir)) {
        if (!isImageFile(entry)) {
          continue;
        }
        if (entry.toLowerCase().includes(basename)) {
          const full = path.join(dir, entry);
          try {
            const stat = fs.statSync(full);
            candidates.push({ path: full, mtime: stat.mtimeMs });
          } catch {
            /* unreadable — skip */
          }
        }
      }
    } catch {
      /* directory missing — skip */
    }
  }
  if (candidates.length === 0) {
    return null;
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].path;
}

/**
 * Lists the most recent images available for editing, across user attachments,
 * public images and MCP-generated files. Newest first.
 */
function listRecentImages(filter, limit = 20) {
  const results = [];
  const needle = filter ? filter.toLowerCase() : null;
  for (const dir of collectImageDirs()) {
    try {
      for (const entry of fs.readdirSync(dir)) {
        if (!isImageFile(entry)) {
          continue;
        }
        if (needle && !entry.toLowerCase().includes(needle)) {
          continue;
        }
        const full = path.join(dir, entry);
        try {
          const stat = fs.statSync(full);
          results.push({ path: full, filename: entry, size: stat.size, mtime: stat.mtimeMs });
        } catch {
          /* unreadable — skip */
        }
      }
    } catch {
      /* directory missing — skip */
    }
  }
  results.sort((a, b) => b.mtime - a.mtime);
  return results.slice(0, limit);
}

/**
 * DashScope image editing accepts public URLs or base64 data URIs only.
 * LibreChat-attached images live on local paths the API cannot fetch, so:
 *  - local paths/URLs are read from disk and inlined as data URIs
 *  - exact misses fall back to a fuzzy basename search across image dirs
 *  - raw base64 payloads are wrapped with a data: prefix
 *  - external URLs and data URIs pass through untouched
 */
async function prepareImageUrl(imageUrl) {
  if (!imageUrl) {
    return imageUrl;
  }

  const trimmed = imageUrl.trim();

  if (looksLikeRawBase64(trimmed)) {
    const compact = trimmed.replace(/\s+/g, '');
    return `data:${sniffBase64Mime(compact)};base64,${compact}`;
  }

  let localPath = resolveLocalImagePath(trimmed);
  if (!localPath && !/^https?:\/\//i.test(trimmed) && !trimmed.startsWith('data:')) {
    // Bare filename or relative path — look in the generated files directory
    const candidate = path.join(IMAGES_PATH, trimmed);
    localPath = fs.existsSync(candidate) ? candidate : null;
  }
  if (!localPath || !fs.existsSync(localPath)) {
    // Models never see the real storage path — try a fuzzy basename match
    const fuzzy = fuzzyFindImage(trimmed);
    if (fuzzy) {
      console.error(`[image MCP] fuzzy match: ${trimmed} -> ${fuzzy}`);
      localPath = fuzzy;
    }
  }
  if (!localPath || !fs.existsSync(localPath)) {
    return trimmed; // external URL or not found locally — let DashScope fetch it
  }
  const buffer = fs.readFileSync(localPath);
  const mimeType = MIME_BY_EXT[path.extname(localPath).toLowerCase()] || 'image/png';
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

function debugLogImageInput(received, prepared) {
  const show = (s) => (s == null ? 'null' : s.length > 80 ? `${s.slice(0, 80)}…[len=${s.length}]` : s);
  console.error(`[image MCP] edit_image image_url received: ${show(received)}`);
  console.error(`[image MCP] edit_image image_url sent:      ${show(prepared)}`);
}

const server = new Server(
  {
    name: 'image',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'generate_image',
        description: 'Generate an image using Qwen Image model. Returns a high-quality image based on the text prompt.',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description: 'The text description of the image to generate. Be descriptive for better results.',
            },
            negative_prompt: {
              type: 'string',
              description: 'Optional. Things to avoid in the generated image.',
            },
            size: {
              type: 'string',
              description: 'Image size. Options: 1024*1024, 720*1280, 1280*720, 2048*2048. Default: 1024*1024',
              enum: ['1024*1024', '720*1280', '1280*720', '2048*2048'],
              default: '1024*1024',
            },
          },
          required: ['prompt'],
        },
      },
      {
        name: 'edit_image',
        description: 'Edit or modify an existing image using Qwen Image model. Accepts a public image URL, a LibreChat attachment path (/uploads/... or /images/...), or a base64 data URI. Local images are located automatically even if the exact path is unknown (matched by filename). If unsure which image to edit, call list_images first. Describe the changes to make.',
        inputSchema: {
          type: 'object',
          properties: {
            image_url: {
              type: 'string',
              description: 'The image to edit: a public URL, a LibreChat path, a filename, or a data URI. The most recently stored image with a matching filename is used when the exact path is unknown.',
            },
            prompt: {
              type: 'string',
              description: 'Description of the edits to make.',
            },
            size: {
              type: 'string',
              description: 'Output image size. Default: 1024*1024',
              enum: ['1024*1024', '720*1280', '1280*720', '2048*2048'],
              default: '1024*1024',
            },
          },
          required: ['image_url', 'prompt'],
        },
      },
      {
        name: 'list_images',
        description: 'Lists the most recent images available for editing (user attachments, generated images), newest first. Use this to discover the exact filename/path of an image the user refers to before calling edit_image. Optionally filter by a substring of the filename.',
        inputSchema: {
          type: 'object',
          properties: {
            filter: {
              type: 'string',
              description: 'Optional. Substring to match against filenames (case-insensitive).',
            },
            limit: {
              type: 'number',
              description: 'Optional. Maximum number of images to return. Default: 20.',
              default: 20,
            },
          },
          required: [],
        },
      },
    ],
  };
});

async function callDashScopeAPI(model, prompt, negativePrompt, size, imageUrl, apiKey = DASHSCOPE_API_KEY, baseUrl = DASHSCOPE_BASE_URL) {
  const messages = [];

  if (imageUrl) {
    messages.push({
      role: 'user',
      content: [
        { image: imageUrl },
        { text: prompt },
      ],
    });
  } else {
    messages.push({
      role: 'user',
      content: [{ text: prompt }],
    });
  }

  const requestBody = {
    model: model,
    input: {
      messages: messages,
    },
    parameters: {
      size: size || '1024*1024',
      prompt_extend: true,
      watermark: false,
    },
  };

  if (negativePrompt) {
    requestBody.parameters.negative_prompt = negativePrompt;
  }

  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`DashScope API error: ${response.status} - ${errorText}`);
  }

  const result = await response.json();

  if (result.output && result.output.choices && result.output.choices[0]) {
    const content = result.output.choices[0].message.content;
    if (content && content[0] && content[0].image) {
      return content[0].image;
    }
  }

  throw new Error('No image returned from DashScope API');
}

async function downloadImageAsBase64(imageUrl) {
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.status}`);
  }
  const buffer = await response.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  const contentType = response.headers.get('content-type') || 'image/png';
  return { base64, contentType };
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'generate_image') {
      const { prompt, negative_prompt, size } = args;

      if (!prompt) {
        return {
          content: [{ type: 'text', text: 'Error: prompt is required' }],
          isError: true,
        };
      }

      const imageUrl = await callDashScopeAPI(IMAGE_MODEL, prompt, negative_prompt, size, null);
      const { base64, contentType } = await downloadImageAsBase64(imageUrl);

      // Save to disk
      const filename = generateFilename(prompt);
      let savedPath = null;
      try {
        savedPath = saveImageToDisk(base64, filename);
      } catch (err) {
        console.error(`Warning: Could not save image to disk: ${err.message}`);
      }

      const responseText = savedPath
        ? `Image generated successfully. Saved to: ${filename}. Prompt: "${prompt}"`
        : `Image generated successfully. Prompt: "${prompt}"`;

      return {
        content: [
          {
            type: 'image',
            data: base64,
            mimeType: contentType,
          },
          {
            type: 'text',
            text: responseText,
          },
        ],
      };
    }

    if (name === 'edit_image') {
      const { image_url, prompt, size } = args;

      if (!image_url || !prompt) {
        return {
          content: [{ type: 'text', text: 'Error: image_url and prompt are required' }],
          isError: true,
        };
      }

      const preparedImage = await prepareImageUrl(image_url);
      debugLogImageInput(image_url, preparedImage);
      const imageUrl = await callDashScopeAPI(IMAGE_EDIT_MODEL, prompt, null, size, preparedImage, DASHSCOPE_EDIT_API_KEY, DASHSCOPE_EDIT_BASE_URL);
      const { base64, contentType } = await downloadImageAsBase64(imageUrl);

      // Save to disk
      const filename = generateFilename(prompt);
      let savedPath = null;
      try {
        savedPath = saveImageToDisk(base64, filename);
      } catch (err) {
        console.error(`Warning: Could not save image to disk: ${err.message}`);
      }

      const responseText = savedPath
        ? `Image edited successfully. Saved to: ${filename}. Prompt: "${prompt}"`
        : `Image edited successfully. Prompt: "${prompt}"`;

      return {
        content: [
          {
            type: 'image',
            data: base64,
            mimeType: contentType,
          },
          {
            type: 'text',
            text: responseText,
          },
        ],
      };
    }

    if (name === 'list_images') {
      const { filter, limit } = args;
      const max = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
      const images = listRecentImages(typeof filter === 'string' ? filter : undefined, max);

      if (images.length === 0) {
        return {
          content: [{
            type: 'text',
            text: filter
              ? `No images found matching "${filter}".`
              : 'No images available.',
          }],
        };
      }

      const lines = images.map((img) => {
        const date = new Date(img.mtime).toISOString().slice(0, 19).replace('T', ' ');
        const kb = (img.size / 1024).toFixed(0);
        return `- ${img.path} (${kb} KB, ${date})`;
      });

      return {
        content: [{
          type: 'text',
          text: `Images available for editing (newest first):\n${lines.join('\n')}`,
        }],
      };
    }

    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  } catch (error) {
    console.error('Error:', error);
    return {
      content: [{ type: 'text', text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Image MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
