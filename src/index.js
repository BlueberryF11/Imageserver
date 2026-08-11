/**
 * Cloudflare Worker - Blueberry Fruitsy Image Server
 * Reads artwork directly from the blueberry-images R2 bucket.
 * collections.json is generated from objects under collections/<collection>/<file>.
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') return corsResponse('OK');
    if (path === '/admin' || path === '/upload.html') return handleAdminPage();
    if (path === '/collections.json') return handleGetCollections(env);
    if (path.startsWith('/collections/')) return handleGetImage(path, env);
    if (path === '/upload' && request.method === 'POST') return handleUpload(request, env);
    if (path === '/') return handleIndex(env);
    return new Response('Not found', { status: 404 });
  },

  async scheduled(event, env) {
    await regenerateCollectionsJson(env);
  },
};

async function handleGetCollections(env) {
  try {
    const collections = await generateCollectionsJson(env);
    await env.METADATA.put('collections.json', JSON.stringify(collections, null, 2), {
      metadata: { generated: new Date().toISOString() },
    });
    return corsResponse(JSON.stringify(collections, null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    });
  } catch (error) {
    console.error(error);
    return corsResponse(JSON.stringify({ error: 'Failed to load collections', details: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
}

async function generateCollectionsJson(env) {
  const collectionMap = new Map();
  let cursor;

  do {
    const response = await env.IMAGES.list(cursor ? { cursor } : {});

    for (const object of response.objects) {
      const parts = object.key.split('/');
      if (parts.length !== 3 || parts[0] !== 'collections') continue;

      const collectionName = parts[1];
      const filename = parts[2];
      if (!collectionName || !filename || filename.startsWith('.') || !isImageFile(filename)) continue;

      if (!collectionMap.has(collectionName)) {
        collectionMap.set(collectionName, {
          name: formatCollectionName(collectionName),
          description: `Collection: ${formatCollectionName(collectionName)}`,
          path: `collections/${collectionName}`,
          images: [],
        });
      }

      collectionMap.get(collectionName).images.push({
        id: object.key,
        filename,
        title: formatTitle(filename),
        url: `/collections/${encodeURIComponent(collectionName)}/${encodeURIComponent(filename)}`,
        uploaded: object.uploaded ? object.uploaded.toISOString() : null,
        size: object.size,
      });
    }

    cursor = response.truncated ? response.cursor : undefined;
  } while (cursor);

  return Array.from(collectionMap.values())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(collection => ({
      ...collection,
      images: collection.images.sort((a, b) => {
        if (!a.uploaded || !b.uploaded) return a.filename.localeCompare(b.filename);
        return new Date(b.uploaded) - new Date(a.uploaded);
      }),
    }));
}

async function handleUpload(request, env) {
  const auth = request.headers.get('Authorization');
  const token = env.UPLOAD_TOKEN;
  if (!token) return json({ error: 'UPLOAD_TOKEN is not configured.' }, 500);
  if (!auth?.startsWith('Bearer ')) return json({ error: 'Unauthorized' }, 401);
  if (auth.slice(7) !== token) return json({ error: 'Invalid token' }, 403);

  try {
    const form = await request.formData();
    const file = form.get('file');
    const rawCollection = String(form.get('collection') || '').trim();

    if (!rawCollection) return json({ error: 'A collection is required.' }, 400);
    if (!file || typeof file.arrayBuffer !== 'function') return json({ error: 'No file provided.' }, 400);
    if (!isImageFile(file.name)) return json({ error: 'Invalid image file type.' }, 400);

    const collection = sanitizeCollectionName(rawCollection);
    const filename = sanitizeFilename(file.name);
    const key = `collections/${collection}/${filename}`;

    await env.IMAGES.put(key, await file.arrayBuffer(), {
      httpMetadata: {
        contentType: file.type || getContentType(filename),
        cacheControl: 'public, max-age=31536000',
      },
      customMetadata: {
        uploadedBy: 'admin',
        uploadedAt: new Date().toISOString(),
      },
    });

    await regenerateCollectionsJson(env);

    return json({
      success: true,
      message: `${filename} uploaded successfully`,
      file: { name: filename, collection, key },
    }, 201);
  } catch (error) {
    console.error(error);
    return json({ error: 'Upload failed', details: error.message }, 500);
  }
}

async function handleGetImage(path, env) {
  try {
    const key = decodeURIComponent(path.slice(1));
    const object = await env.IMAGES.get(key);
    if (!object) return new Response('Image not found', { status: 404 });

    return new Response(object.body, {
      headers: {
        'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (error) {
    console.error(error);
    return new Response('Error loading image', { status: 500 });
  }
}

async function handleIndex(env) {
  const collections = await generateCollectionsJson(env);
  const total = collections.reduce((sum, c) => sum + c.images.length, 0);

  const collectionCards = collections.length
    ? collections.map(collection => `
      <section class="collection">
        <div class="collection-head">
          <div><h2>${escapeHtml(collection.name)}</h2><p>${collection.images.length} image${collection.images.length === 1 ? '' : 's'}</p></div>
          <code>${escapeHtml(collection.path)}</code>
        </div>
        <div class="grid">
          ${collection.images.map(image => `
            <a class="image" href="${image.url}" target="_blank" rel="noopener">
              <img src="${image.url}" alt="${escapeHtml(image.title)}" loading="lazy">
              <span>${escapeHtml(image.title)}</span>
            </a>`).join('')}
        </div>
      </section>`).join('')
    : '<div class="empty"><h2>No artwork yet.</h2><p>Upload something from the admin page and it will appear here.</p></div>';

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Blueberry Fruitsy Image Server</title>
  <style>
  *{box-sizing:border-box}body{margin:0;background:#09090b;color:#f4f4f5;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.wrap{width:min(1100px,calc(100% - 32px));margin:auto;padding:48px 0 70px}.top{display:flex;justify-content:space-between;align-items:end;gap:20px;margin-bottom:38px}.eyebrow{color:#a78bfa;text-transform:uppercase;letter-spacing:.12em;font-size:12px;font-weight:800}h1{font-size:42px;margin:6px 0 8px}.sub{color:#a1a1aa}.actions a{display:inline-block;padding:10px 14px;border:1px solid #303038;border-radius:10px;color:#fff;text-decoration:none}.stats{color:#71717a;font-size:13px}.collection{margin-top:42px}.collection-head{display:flex;justify-content:space-between;align-items:end;margin-bottom:14px;border-bottom:1px solid #24242a;padding-bottom:12px}.collection h2{margin:0;font-size:22px}.collection p{margin:4px 0 0;color:#71717a;font-size:13px}.collection code{color:#71717a}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:14px}.image{display:block;color:#fff;text-decoration:none;background:#151518;border:1px solid #292930;border-radius:14px;overflow:hidden}.image img{display:block;width:100%;aspect-ratio:1/1;object-fit:cover;background:#111}.image span{display:block;padding:10px 11px;font-size:13px}.empty{border:1px dashed #38383f;border-radius:16px;padding:50px;text-align:center;color:#a1a1aa}.empty h2{color:#fff}.foot{margin-top:44px;color:#52525b;font-size:12px} @media(max-width:650px){.top{display:block}.actions{margin-top:18px}h1{font-size:32px}.grid{grid-template-columns:repeat(2,1fr)}}
  </style></head><body><main class="wrap"><header class="top"><div><div class="eyebrow">Blueberry Fruitsy // Image Server</div><h1>Artwork</h1><div class="sub">${collections.length} collection${collections.length === 1 ? '' : 's'} · ${total} image${total === 1 ? '' : 's'}</div></div><div class="actions"><a href="/admin">Upload artwork</a></div></header>${collectionCards}<div class="foot"><a href="/collections.json" style="color:#71717a">collections.json</a> · Images from the blueberry-images R2 bucket</div></main></body></html>`;

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

function handleAdminPage() {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Blueberry Fruitsy • Upload</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#09090b;color:#f4f4f5;font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;padding:24px}.card{width:min(680px,100%);background:#151518;border:1px solid #2d2d33;border-radius:20px;padding:28px}h1{margin:0 0 8px}.sub{color:#a1a1aa;margin-bottom:25px}.row{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:18px}label{display:block;color:#a1a1aa;font-size:13px;margin-bottom:7px}input{width:100%;padding:12px;border:1px solid #34343b;border-radius:10px;background:#0d0d0f;color:#fff;font:inherit}.drop{border:2px dashed #4b4b55;border-radius:16px;padding:42px 20px;text-align:center;cursor:pointer}.drop.drag{border-color:#8b5cf6;background:#8b5cf611}.drop strong{display:block;font-size:18px}.drop span{color:#a1a1aa}.hidden{display:none}.files{margin:16px 0;color:#d4d4d8;white-space:pre-line}button{width:100%;padding:13px;border:0;border-radius:10px;background:#8b5cf6;color:#fff;font-weight:700;cursor:pointer}button:disabled{opacity:.5}.status{margin-top:16px;padding:12px;background:#0d0d0f;border-radius:10px;white-space:pre-wrap;color:#a1a1aa}@media(max-width:600px){.row{grid-template-columns:1fr}}</style></head><body><div class="card"><h1>Upload artwork</h1><div class="sub">Choose a collection. Nothing is assigned automatically.</div><div class="row"><div><label>Collection</label><input id="collection" placeholder="e.g. singles, album-art, sketches"></div><div><label>Upload token</label><input id="token" type="password" placeholder="Your UPLOAD_TOKEN"></div></div><div id="drop" class="drop"><strong>Drop artwork here</strong><span>or click to choose image files</span><input id="files" class="hidden" type="file" accept="image/*" multiple></div><div id="list" class="files">No files selected.</div><button id="upload" disabled>Upload</button><div id="status" class="status">Ready.</div></div><script>const d=document.getElementById('drop'),f=document.getElementById('files'),l=document.getElementById('list'),b=document.getElementById('upload'),s=document.getElementById('status');let files=[];function setFiles(x){files=[...x];l.textContent=files.length?files.map(x=>x.name).join('\\n'):'No files selected.';b.disabled=!files.length}d.onclick=()=>f.click();f.onchange=()=>setFiles(f.files);d.ondragover=e=>{e.preventDefault();d.classList.add('drag')};d.ondragleave=()=>d.classList.remove('drag');d.ondrop=e=>{e.preventDefault();d.classList.remove('drag');setFiles(e.dataTransfer.files)};b.onclick=async()=>{const token=document.getElementById('token').value.trim(),collection=document.getElementById('collection').value.trim();if(!collection){s.textContent='Please enter a collection name.';return}if(!token){s.textContent='Please enter your upload token.';return}b.disabled=true;let ok=0;for(const file of files){s.textContent='Uploading '+file.name+'...';const form=new FormData();form.append('file',file);form.append('collection',collection);try{const r=await fetch('/upload',{method:'POST',headers:{Authorization:'Bearer '+token},body:form});const data=await r.json();if(!r.ok)throw Error(data.error||'Upload failed');ok++}catch(e){s.textContent+='\\n❌ '+file.name+': '+e.message}}s.textContent='Done. '+ok+'/'+files.length+' uploaded.';b.disabled=false}</script></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function sanitizeCollectionName(name) { return String(name).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, ''); }
function sanitizeFilename(name) { return String(name).split('\\').pop().split('/').pop().replace(/[^a-zA-Z0-9._-]+/g, '_') || `image-${Date.now()}.png`; }
function isImageFile(filename) { return ['.jpg','.jpeg','.png','.webp','.gif','.bmp','.svg'].includes(filename.toLowerCase().slice(filename.lastIndexOf('.'))); }
function getContentType(filename) { return ({'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.gif':'image/gif','.bmp':'image/bmp','.svg':'image/svg+xml'})[filename.toLowerCase().slice(filename.lastIndexOf('.'))] || 'application/octet-stream'; }
function formatCollectionName(name) { return name.replace(/[-_]/g,' ').split(' ').map(w=>w.charAt(0).toUpperCase()+w.slice(1)).join(' '); }
function formatTitle(filename) { return filename.replace(/\.[^.]+$/,'').replace(/[-_]/g,' ').split(' ').map(w=>w.charAt(0).toUpperCase()+w.slice(1)).join(' '); }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function json(data,status=200){return corsResponse(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}})}
function corsResponse(body, options={}) { return new Response(body,{...options,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Max-Age':'86400',...(options.headers||{})}}); }
async function regenerateCollectionsJson(env) { const collections=await generateCollectionsJson(env); await env.METADATA.put('collections.json',JSON.stringify(collections,null,2),{metadata:{generated:new Date().toISOString()}}); }

