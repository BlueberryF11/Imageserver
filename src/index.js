/**
 * Cloudflare Worker - Blueberry Fruitsy Image Server
 * Auto-generates collections.json when images are uploaded to R2
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return corsResponse('OK');
    }

    // GET /collections.json - Return auto-generated metadata
    if (path === '/collections.json') {
      return handleGetCollections(env);
    }

    // GET /collections/[name]/* - Serve images from R2
    if (path.startsWith('/collections/')) {
      return handleGetImage(path, env);
    }

    // POST /upload - Upload image (requires auth token)
    if (path === '/upload' && request.method === 'POST') {
      return handleUpload(request, env);
    }

    // GET / - Return sitemap/info page
    if (path === '/') {
      return handleIndex(env);
    }

    return new Response('Not found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    // Regenerate collections.json every hour
    await regenerateCollectionsJson(env);
  },
};

/**
 * GET /collections.json
 * Scans R2 bucket and returns auto-generated metadata
 */
async function handleGetCollections(env) {
  try {
    // Try to get cached version first
    const cached = await env.METADATA.get('collections.json');
    if (cached) {
      return corsResponse(cached.body, {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=3600',
        },
      });
    }

    // Generate fresh collections.json
    const collections = await generateCollectionsJson(env);
    
    // Cache it for 1 hour
    await env.METADATA.put('collections.json', JSON.stringify(collections, null, 2), {
      metadata: { generated: new Date().toISOString() },
    });

    return corsResponse(JSON.stringify(collections, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Error getting collections:', error);
    return corsResponse(
      JSON.stringify({ error: 'Failed to load collections', details: error.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * Generate collections.json by scanning R2 bucket
 */
async function generateCollectionsJson(env) {
  const collections = [];
  const collectionMap = new Map();

  // List all objects in R2 bucket
  const listResponse = await env.IMAGES.list();

  // Group images by collection folder
  for (const object of listResponse.objects) {
    const pathParts = object.key.split('/');
    
    if (pathParts.length >= 3 && pathParts[0] === 'collections') {
      const collectionName = pathParts[1];
      const filename = pathParts[pathParts.length - 1];

      // Skip non-image files and directories
      if (!isImageFile(filename) || filename.startsWith('.')) continue;

      if (!collectionMap.has(collectionName)) {
        collectionMap.set(collectionName, {
          name: formatCollectionName(collectionName),
          description: `Collection: ${formatCollectionName(collectionName)}`,
          path: `collections/${collectionName}`,
          images: [],
        });
      }

      const collection = collectionMap.get(collectionName);
      collection.images.push({
        id: collection.images.length + 1,
        filename: filename,
        title: formatTitle(filename),
        url: `/collections/${collectionName}/${filename}`,
        uploaded: object.uploaded.toISOString(),
        size: object.size,
      });
    }
  }

  // Convert map to array and sort
  return Array.from(collectionMap.values()).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
}

/**
 * POST /upload
 * Upload image and auto-generate collections.json
 */
async function handleUpload(request, env) {
  const authHeader = request.headers.get('Authorization');
  const token = env.UPLOAD_TOKEN || 'your-secret-token';

  // Verify auth token
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return corsResponse(
      JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const providedToken = authHeader.slice(7);
  if (providedToken !== token) {
    return corsResponse(
      JSON.stringify({ error: 'Invalid token' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    const formData = await request.formData();
    const file = formData.get('file');
    const collection = formData.get('collection') || 'uploads';

    if (!file) {
      return corsResponse(
        JSON.stringify({ error: 'No file provided' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Validate file type
    if (!isImageFile(file.name)) {
      return corsResponse(
        JSON.stringify({ error: 'Invalid file type. Only images allowed.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Upload to R2
    const key = `collections/${collection}/${file.name}`;
    const buffer = await file.arrayBuffer();
    
    await env.IMAGES.put(key, buffer, {
      httpMetadata: {
        contentType: file.type,
        cacheControl: 'public, max-age=31536000',
      },
      metadata: {
        uploadedBy: 'api',
        uploadedAt: new Date().toISOString(),
      },
    });

    // Regenerate collections.json
    const collections = await generateCollectionsJson(env);
    await env.METADATA.put('collections.json', JSON.stringify(collections, null, 2), {
      metadata: { generated: new Date().toISOString() },
    });

    return corsResponse(
      JSON.stringify({
        success: true,
        message: 'File uploaded and collections updated',
        file: {
          name: file.name,
          size: file.size,
          type: file.type,
          url: `https://your-worker-domain.com${key}`,
          key: key,
        },
      }),
      { status: 201, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Upload error:', error);
    return corsResponse(
      JSON.stringify({ error: 'Upload failed', details: error.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * GET /collections/[name]/*
 * Serve image files from R2
 */
async function handleGetImage(path, env) {
  try {
    // Remove leading slash
    const key = path.slice(1);

    const object = await env.IMAGES.get(key);

    if (!object) {
      return new Response('Image not found', { status: 404 });
    }

    return new Response(object.body, {
      headers: {
        'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
        'Cache-Control': 'public, max-age=31536000',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (error) {
    console.error('Error serving image:', error);
    return new Response('Error loading image', { status: 500 });
  }
}

/**
 * GET / - Sitemap page
 */
async function handleIndex(env) {
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Blueberry Fruitsy - Image Server API</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: linear-gradient(135deg, #0f0f0f, #1a0f2e);
            color: #e0e0e0;
            padding: 40px 20px;
        }
        .container { max-width: 900px; margin: 0 auto; }
        h1 { color: #3b82f6; margin-bottom: 10px; }
        .api-doc { background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.3); border-radius: 8px; padding: 20px; margin: 20px 0; }
        .endpoint { background: rgba(0,0,0,0.3); padding: 15px; border-radius: 6px; margin: 10px 0; font-family: monospace; border-left: 3px solid #3b82f6; }
        code { background: rgba(0,0,0,0.2); padding: 2px 6px; border-radius: 3px; color: #60a5fa; }
        ul { margin-left: 20px; }
        footer { margin-top: 60px; padding-top: 20px; border-top: 1px solid rgba(59,130,246,0.2); color: #707070; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🍓 Blueberry Fruitsy - Image Server API</h1>
        <p>Serverless image hosting with auto-generated metadata</p>

        <div class="api-doc">
            <h2>📡 Endpoints</h2>
            
            <h3>Get Collections Metadata</h3>
            <div class="endpoint">GET /collections.json</div>
            <p>Returns auto-generated list of all collections and images</p>

            <h3>Serve Image</h3>
            <div class="endpoint">GET /collections/[collection-name]/[filename]</div>
            <p>Access image files directly from R2</p>

            <h3>Upload Image</h3>
            <div class="endpoint">POST /upload</div>
            <p>Upload new image and auto-regenerate collections.json</p>
            <p><strong>Required Header:</strong> <code>Authorization: Bearer YOUR_TOKEN</code></p>
            <p><strong>Form Data:</strong></p>
            <ul>
                <li><code>file</code> - Image file (JPG, PNG, WebP, GIF)</li>
                <li><code>collection</code> - Collection folder name (optional)</li>
            </ul>
        </div>

        <div class="api-doc">
            <h2>🚀 Features</h2>
            <ul>
                <li>✅ Auto-generates collections.json from R2 folder structure</li>
                <li>✅ Regenerates metadata on every upload</li>
                <li>✅ Caches collections.json for 1 hour</li>
                <li>✅ Supports JPG, PNG, WebP, GIF formats</li>
                <li>✅ Serverless - no server maintenance</li>
                <li>✅ CORS enabled for cross-origin requests</li>
            </ul>
        </div>

        <footer>
            <p>Made with 💙 by BlueberryF11</p>
        </footer>
    </div>
</body>
</html>
  `;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

/**
 * Utility: Check if file is an image
 */
function isImageFile(filename) {
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.svg'];
  const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'));
  return imageExtensions.includes(ext);
}

/**
 * Utility: Format collection name
 */
function formatCollectionName(name) {
  return name
    .replace(/-/g, ' ')
    .replace(/_/g, ' ')
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Utility: Format title from filename
 */
function formatTitle(filename) {
  return filename
    .replace(/\.[^.]+$/, '')
    .replace(/-/g, ' ')
    .replace(/_/g, ' ')
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Utility: CORS response helper
 */
function corsResponse(body, options = {}) {
  const init = {
    ...options,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
      ...options.headers,
    },
  };

  if (typeof body === 'string') {
    return new Response(body, init);
  }

  return new Response(body, init);
}

/**
 * Regenerate collections.json (called by scheduled event)
 */
async function regenerateCollectionsJson(env) {
  try {
    const collections = await generateCollectionsJson(env);
    await env.METADATA.put('collections.json', JSON.stringify(collections, null, 2), {
      metadata: { generated: new Date().toISOString() },
    });
    console.log('Collections.json regenerated successfully');
  } catch (error) {
    console.error('Error regenerating collections:', error);
  }
}
