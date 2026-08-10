/**
 * Cloudflare Worker - Blueberry Fruitsy Image Server
 * Auto-generates collections.json when images are uploaded to R2
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return corsResponse('OK');
    }

    // Browser upload dashboard
    if (path === '/admin' || path === '/upload.html') {
      return handleAdminPage();
    }

    if (path === '/collections.json') {
      return handleGetCollections(env);
    }

    if (path.startsWith('/collections/')) {
      return handleGetImage(path, env);
    }

    if (path === '/upload' && request.method === 'POST') {
      return handleUpload(request, env);
    }

    if (path === '/') {
      return handleIndex();
    }

    return new Response('Not found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    await regenerateCollectionsJson(env);
  },
};

async function handleGetCollections(env) {
  try {
    const cached = await env.METADATA.get('collections.json');
    if (cached) {
      return corsResponse(cached.body, {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=3600',
        },
      });
    }

    const collections = await generateCollectionsJson(env);
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

async function generateCollectionsJson(env) {
  const collections = [];
  const collectionMap = new Map();
  let cursor;

  // List every object in R2, including buckets with more than 1,000 objects.
  do {
    const listResponse = await env.IMAGES.list({ cursor });

    for (const object of listResponse.objects) {
      const pathParts = object.key.split('/');
      if (pathParts.length >= 3 && pathParts[0] === 'collections') {
        const collectionName = pathParts[1];
        const filename = pathParts[pathParts.length - 1];

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
          filename,
          title: formatTitle(filename),
          url: `/collections/${collectionName}/${filename}`,
          uploaded: object.uploaded.toISOString(),
          size: object.size,
        });
      }
    }

    cursor = listResponse.truncated ? listResponse.cursor : undefined;
  } while (cursor);

  return Array.from(collectionMap.values()).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
}

async function handleUpload(request, env) {
  const authHeader = request.headers.get('Authorization');
  const token = env.UPLOAD_TOKEN;

  if (!token) {
    return corsResponse(
      JSON.stringify({ error: 'UPLOAD_TOKEN is not configured on the Worker.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

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
    const collection = sanitizeCollectionName(formData.get('collection') || 'uploads');

    if (!file || typeof file.arrayBuffer !== 'function') {
      return corsResponse(
        JSON.stringify({ error: 'No file provided' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (!isImageFile(file.name)) {
      return corsResponse(
        JSON.stringify({ error: 'Invalid file type. Only images are allowed.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const safeFilename = sanitizeFilename(file.name);
    const key = `collections/${collection}/${safeFilename}`;
    const buffer = await file.arrayBuffer();

    await env.IMAGES.put(key, buffer, {
      httpMetadata: {
        contentType: file.type || getContentType(safeFilename),
        cacheControl: 'public, max-age=31536000',
      },
      metadata: {
        uploadedBy: 'admin',
        uploadedAt: new Date().toISOString(),
      },
    });

    const collections = await generateCollectionsJson(env);
    await env.METADATA.put('collections.json', JSON.stringify(collections, null, 2), {
      metadata: { generated: new Date().toISOString() },
    });

    return corsResponse(
      JSON.stringify({
        success: true,
        message: `${safeFilename} uploaded successfully`,
        file: {
          name: safeFilename,
          size: file.size,
          type: file.type,
          url: `/collections/${collection}/${encodeURIComponent(safeFilename)}`,
          key,
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

async function handleGetImage(path, env) {
  try {
    const key = path.slice(1);
    const object = await env.IMAGES.get(key);

    if (!object) return new Response('Image not found', { status: 404 });

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

function handleAdminPage() {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Blueberry Fruitsy • Image Upload</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#09090b;color:#f4f4f5;display:flex;align-items:center;justify-content:center;padding:24px}.card{width:min(680px,100%);background:#151518;border:1px solid #2d2d33;border-radius:20px;padding:28px;box-shadow:0 20px 60px #0008}h1{margin:0 0 6px;font-size:28px}.sub{color:#a1a1aa;margin-bottom:26px}.drop{border:2px dashed #4b4b55;border-radius:16px;padding:42px 20px;text-align:center;cursor:pointer;transition:.15s}.drop:hover,.drop.drag{border-color:#8b5cf6;background:#8b5cf611}.drop strong{display:block;font-size:18px;margin-bottom:8px}.drop span{color:#a1a1aa}.row{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:18px 0}label{font-size:13px;color:#a1a1aa;display:block;margin-bottom:7px}input{width:100%;padding:12px;border:1px solid #34343b;border-radius:10px;background:#0d0d0f;color:#fff;font:inherit}button{width:100%;padding:13px;border:0;border-radius:10px;background:#8b5cf6;color:#fff;font-weight:700;font-size:15px;cursor:pointer}button:disabled{opacity:.5;cursor:not-allowed}.files{margin:16px 0;color:#d4d4d8}.status{margin-top:16px;padding:12px;border-radius:10px;background:#0d0d0f;color:#a1a1aa;white-space:pre-wrap}.hint{margin-top:18px;color:#71717a;font-size:12px}.hidden{display:none}@media(max-width:600px){.row{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="card">
<h1>🍓 Blueberry Fruitsy Image Server</h1>
<div class="sub">Upload artwork directly to your gallery's image server.</div>
<div class="row">
<div><label>Collection</label><input id="collection" value="artwork" placeholder="e.g. artwork"></div>
<div><label>Upload token</label><input id="token" type="password" placeholder="Your UPLOAD_TOKEN"></div>
</div>
<div id="drop" class="drop">
<strong>Drop artwork here</strong><span>or click to choose one or more image files</span>
<input id="files" class="hidden" type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/bmp,image/svg+xml" multiple>
</div>
<div id="fileList" class="files">No files selected.</div>
<button id="upload" disabled>Upload artwork</button>
<div id="status" class="status">Ready.</div>
<div class="hint">Your token is only sent to this server over HTTPS. Do not put it in your GitHub repository.</div>
</div>
<script>
const drop=document.getElementById('drop'),filesInput=document.getElementById('files'),fileList=document.getElementById('fileList'),upload=document.getElementById('upload'),status=document.getElementById('status');
let files=[];
function setFiles(list){files=[...list];fileList.textContent=files.length?files.map(f=>`${f.name} (${Math.round(f.size/1024)} KB)`).join('\n'):'No files selected.';upload.disabled=!files.length;}
drop.onclick=()=>filesInput.click();filesInput.onchange=()=>setFiles(filesInput.files);drop.ondragover=e=>{e.preventDefault();drop.classList.add('drag')};drop.ondragleave=()=>drop.classList.remove('drag');drop.ondrop=e=>{e.preventDefault();drop.classList.remove('drag');setFiles(e.dataTransfer.files)};
upload.onclick=async()=>{const token=document.getElementById('token').value.trim(),collection=document.getElementById('collection').value.trim()||'artwork';if(!token){status.textContent='Enter your upload token first.';return}upload.disabled=true;let ok=0;for(const file of files){status.textContent=`Uploading ${file.name}...`;const form=new FormData();form.append('file',file);form.append('collection',collection);try{const r=await fetch('/upload',{method:'POST',headers:{Authorization:`Bearer ${token}`},body:form});const data=await r.json();if(!r.ok)throw new Error(data.error||'Upload failed');ok++;}catch(e){status.textContent+=`\n❌ ${file.name}: ${e.message}`;}}status.textContent=`Done. ${ok}/${files.length} file(s) uploaded.`+(ok<files.length?' Check the token and file names.':'');upload.disabled=false;};
</script>
</body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function handleIndex() {
  return new Response(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Blueberry Fruitsy Image Server</title><style>body{font-family:system-ui;background:#09090b;color:#eee;max-width:800px;margin:60px auto;padding:20px}a{color:#a78bfa}code{background:#18181b;padding:3px 6px;border-radius:5px}</style></head><body><h1>🍓 Blueberry Fruitsy Image Server</h1><p>Image API is online.</p><p><a href="/admin">Open the artwork upload dashboard →</a></p><p><a href="/collections.json">View collections.json →</a></p></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function sanitizeCollectionName(name) {
  return String(name).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'uploads';
}

function sanitizeFilename(name) {
  return String(name).split('\\').pop().split('/').pop().replace(/[^a-zA-Z0-9._-]+/g, '_') || `image-${Date.now()}.png`;
}

function isImageFile(filename) {
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.svg'];
  const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'));
  return imageExtensions.includes(ext);
}

function getContentType(filename) {
  const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'));
  return ({'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.gif':'image/gif','.bmp':'image/bmp','.svg':'image/svg+xml'})[ext] || 'application/octet-stream';
}

function formatCollectionName(name) {
  return name.replace(/-/g, ' ').replace(/_/g, ' ').split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

function formatTitle(filename) {
  return filename.replace(/\.[^.]+$/, '').replace(/-/g, ' ').replace(/_/g, ' ').split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

function corsResponse(body, options = {}) {
  const init = {...options, headers: {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Max-Age':'86400',...(options.headers || {})}};
  return new Response(body, init);
}

async function regenerateCollectionsJson(env) {
  try {
    const collections = await generateCollectionsJson(env);
    await env.METADATA.put('collections.json', JSON.stringify(collections, null, 2), { metadata: { generated: new Date().toISOString() } });
  } catch (error) {
    console.error('Error regenerating collections:', error);
  }
}
