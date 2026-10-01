/**
 * Deploy Hub API — Cloudflare Worker
 *
 * 학생·선생님이 올린 웹사이트를 관리자 GitHub 계정의 저장소로 만들고 GitHub Pages로 배포합니다.
 * GitHub 토큰은 이 Worker 안에만 보관되고, 브라우저에는 절대 전달되지 않습니다.
 *
 * 환경 변수 (Cloudflare 대시보드 → Settings → Variables and Secrets)
 *   GITHUB_TOKEN    (Secret)  저장소 생성/삭제·Contents·Pages 권한이 있는 GitHub 토큰
 *   GITHUB_OWNER    (Text)    GitHub 아이디 (토큰 소유자)
 *   ACCESS_CODE     (Secret)  학생·선생님이 새 사이트를 만들 때 입력하는 접속 코드
 *   ADMIN_CODE      (Secret)  관리자 코드 (모든 사이트 삭제·편집 키 재발급)
 *   SIGNING_SECRET  (Secret)  편집 키 서명용 임의의 긴 문자열 (바꾸면 기존 편집 키가 모두 무효화됨)
 *   ALLOWED_ORIGINS (Text, 선택) 허용할 프론트엔드 주소, 쉼표 구분. 예: https://myid.github.io  (기본값 *)
 *   RESERVED_NAMES  (Text, 선택) 학생이 쓸 수 없는 저장소 이름, 쉼표 구분. 예: deploy-hub,blog
 *   TOPIC           (Text, 선택) 관리 대상 저장소에 붙는 토픽 (기본값 deploy-hub)
 */

const GH_API = 'https://api.github.com';
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const MAX_BATCH_FILES = 40;
const MAX_TREE_FILES = 1000;
const REQUIRED_ENV = ['GITHUB_TOKEN', 'GITHUB_OWNER', 'ACCESS_CODE', 'ADMIN_CODE', 'SIGNING_SECRET'];
const GALLERY_CACHE_PATH = '/__cache/sites-v1';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    let res;
    try {
      res = await route(request, env, ctx);
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      const status = e instanceof HttpError ? e.status : 500;
      const message = e instanceof HttpError ? e.message : '서버 내부 오류가 발생했어요. 잠시 후 다시 시도해 주세요.';
      res = json({ error: message }, status);
    }
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    return new Response(res.body, { status: res.status, headers });
  },
};

/* ───────────────────────── Routing ───────────────────────── */

async function route(req, env, ctx) {
  const missing = REQUIRED_ENV.filter((k) => !env[k]);
  if (missing.length) throw new HttpError(500, `서버 설정이 끝나지 않았어요. 누락된 환경 변수: ${missing.join(', ')}`);

  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const method = req.method;
  if (parts[0] !== 'api') throw new HttpError(404, '알 수 없는 경로예요.');
  const [, resource, rawName, action] = parts;

  if (resource === 'health' && method === 'GET') {
    return json({ ok: true, owner: env.GITHUB_OWNER, pagesBase: pagesBase(env) });
  }

  if (resource === 'sites') {
    if (!rawName) {
      if (method === 'GET') return listSites(req, env, ctx);
      if (method === 'POST') return createSite(req, env, ctx);
    } else {
      const name = validName(env, rawName);
      if (!action) {
        if (method === 'GET') return getSite(env, name);
        if (method === 'PATCH') return updateSite(req, env, ctx, name);
        if (method === 'DELETE') return deleteSite(req, env, ctx, name);
      }
      if (action === 'blobs' && method === 'POST') return uploadBlobs(req, env, name);
      if (action === 'commit' && method === 'POST') return commitSite(req, env, ctx, name);
      if (action === 'status' && method === 'GET') return siteStatus(env, name, url.searchParams.get('commit'));
    }
  }

  if (resource === 'admin' && method === 'POST') {
    if (rawName === 'verify') {
      await requireAdmin(req, env);
      return json({ ok: true });
    }
    if (rawName === 'token') {
      await requireAdmin(req, env);
      const body = await readJson(req);
      const name = validName(env, body.name);
      await getManagedRepo(env, name);
      return json({ name, token: await editToken(env, name), url: siteUrl(env, name) });
    }
  }

  throw new HttpError(404, '알 수 없는 요청이에요.');
}

/* ───────────────────────── Handlers ───────────────────────── */

async function listSites(req, env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(new URL(GALLERY_CACHE_PATH, req.url).toString());
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const sites = [];
  for (let page = 1; page <= 10; page++) {
    const r = await gh(env, 'GET', `/user/repos?affiliation=owner&per_page=100&sort=updated&page=${page}`);
    if (!r.ok) throw ghError(r, '사이트 목록을 불러오지 못했어요.');
    for (const repo of r.data) {
      if ((repo.topics || []).includes(topic(env))) sites.push(siteInfo(env, repo));
    }
    if (r.data.length < 100) break;
  }

  const res = json({ sites });
  res.headers.set('Cache-Control', 'public, max-age=30');
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

async function getSite(env, name) {
  const r = await gh(env, 'GET', `/repos/${env.GITHUB_OWNER}/${name}`);
  if (r.status === 404) return json({ exists: false, name });
  if (!r.ok) throw ghError(r, '사이트 정보를 확인하지 못했어요.');
  const managed = (r.data.topics || []).includes(topic(env));
  return json({ exists: true, managed, ...(managed ? siteInfo(env, r.data) : { name }) });
}

async function createSite(req, env, ctx) {
  const body = await readJson(req);
  const code = String(body.code || '');
  if (!safeEqual(code, env.ACCESS_CODE) && !safeEqual(code, env.ADMIN_CODE)) {
    await sleep(1000);
    throw new HttpError(401, '접속 코드가 올바르지 않아요.');
  }
  const name = validName(env, body.name);
  const title = clean(body.title, 60) || name;
  const author = clean(body.author, 30);

  const r = await gh(env, 'POST', '/user/repos', {
    name,
    description: describe(title, author),
    homepage: siteUrl(env, name),
    private: false,
    auto_init: true,
    has_issues: false,
    has_projects: false,
    has_wiki: false,
  });
  if (r.status === 422) throw new HttpError(409, '이미 사용 중인 주소예요. 다른 이름을 골라 주세요.');
  if (!r.ok) throw ghError(r, '저장소를 만들지 못했어요.');

  const t = await gh(env, 'PUT', `/repos/${env.GITHUB_OWNER}/${name}/topics`, { names: [topic(env)] });
  if (!t.ok) {
    await gh(env, 'DELETE', `/repos/${env.GITHUB_OWNER}/${name}`);
    throw ghError(t, '저장소 설정에 실패했어요.');
  }

  ctx.waitUntil(purgeGallery(req));
  return json({ name, token: await editToken(env, name), url: siteUrl(env, name) }, 201);
}

async function uploadBlobs(req, env, name) {
  await requireEditor(req, env, name);
  const body = await readJson(req);
  const files = body.files;
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_BATCH_FILES) {
    throw new HttpError(400, `한 번에 1~${MAX_BATCH_FILES}개의 파일만 올릴 수 있어요.`);
  }
  if (!files.every((f) => typeof f === 'string' && BASE64_RE.test(f))) {
    throw new HttpError(400, '파일 형식이 올바르지 않아요.');
  }

  // Workers는 동시 연결이 6개로 제한되므로 6개씩 나눠 병렬 업로드
  const shas = new Array(files.length);
  for (let i = 0; i < files.length; i += 6) {
    await Promise.all(
      files.slice(i, i + 6).map(async (content, j) => {
        const r = await gh(env, 'POST', `/repos/${env.GITHUB_OWNER}/${name}/git/blobs`, { content, encoding: 'base64' });
        if (!r.ok) throw ghError(r, '파일을 올리지 못했어요.');
        shas[i + j] = r.data.sha;
      })
    );
  }
  return json({ shas });
}

async function commitSite(req, env, ctx, name) {
  await requireEditor(req, env, name);
  const repo = await getManagedRepo(env, name);
  const body = await readJson(req);
  const entries = body.files;
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_TREE_FILES) {
    throw new HttpError(400, `파일은 1~${MAX_TREE_FILES}개까지 배포할 수 있어요.`);
  }

  const seen = new Set();
  const tree = entries.map((e) => {
    const path = cleanPath(e && e.path);
    if (!path || !SHA_RE.test(String(e.sha))) throw new HttpError(400, `잘못된 파일 정보예요: ${e && e.path}`);
    if (seen.has(path)) throw new HttpError(400, `같은 경로의 파일이 두 개 있어요: ${path}`);
    seen.add(path);
    return { path, mode: '100644', type: 'blob', sha: e.sha };
  });
  if (!seen.has('index.html')) throw new HttpError(400, '최상위 폴더에 index.html이 있어야 해요.');
  // Jekyll 처리를 건너뛰어 빌드가 빨라지고 _로 시작하는 파일도 그대로 배포됨
  if (!seen.has('.nojekyll')) tree.push({ path: '.nojekyll', mode: '100644', type: 'blob', content: '\n' });

  const owner = env.GITHUB_OWNER;
  const branch = repo.default_branch || 'main';

  // 방금 만든 저장소는 브랜치가 준비되기까지 잠깐 걸릴 수 있음
  let ref;
  for (let i = 0; i < 4; i++) {
    ref = await gh(env, 'GET', `/repos/${owner}/${name}/git/ref/heads/${branch}`);
    if (ref.ok) break;
    await sleep(1500);
  }
  if (!ref.ok) throw ghError(ref, '저장소가 아직 준비되지 않았어요. 잠시 후 다시 시도해 주세요.');

  // base_tree 없이 만들면 이전 파일이 모두 교체됨 (재배포 = 전체 덮어쓰기)
  const t = await gh(env, 'POST', `/repos/${owner}/${name}/git/trees`, { tree });
  if (!t.ok) throw ghError(t, '파일 목록을 만들지 못했어요.');

  const message = clean(body.message, 200) || 'Deploy from Deploy Hub';
  const c = await gh(env, 'POST', `/repos/${owner}/${name}/git/commits`, {
    message,
    tree: t.data.sha,
    parents: [ref.data.object.sha],
  });
  if (!c.ok) throw ghError(c, '변경 사항을 저장하지 못했어요.');

  const u = await gh(env, 'PATCH', `/repos/${owner}/${name}/git/refs/heads/${branch}`, { sha: c.data.sha, force: false });
  if (u.status === 422) throw new HttpError(409, '다른 곳에서 동시에 배포 중이에요. 잠시 후 다시 시도해 주세요.');
  if (!u.ok) throw ghError(u, '변경 사항을 반영하지 못했어요.');

  const pages = await gh(env, 'GET', `/repos/${owner}/${name}/pages`);
  if (pages.status === 404) {
    const p = await gh(env, 'POST', `/repos/${owner}/${name}/pages`, { source: { branch, path: '/' } });
    if (!p.ok && p.status !== 409) throw ghError(p, 'GitHub Pages를 켜지 못했어요.');
  } else if (!pages.ok) {
    throw ghError(pages, 'GitHub Pages 상태를 확인하지 못했어요.');
  }

  ctx.waitUntil(purgeGallery(req));
  return json({ commit: c.data.sha, url: siteUrl(env, name) });
}

async function siteStatus(env, name, commit) {
  const owner = env.GITHUB_OWNER;
  const b = await gh(env, 'GET', `/repos/${owner}/${name}/pages/builds/latest`);
  if (b.ok) {
    let status = b.data.status; // queued | building | built | errored
    if (commit && SHA_RE.test(commit) && b.data.commit && b.data.commit !== commit) status = 'queued';
    return json({
      status,
      error: status === 'errored' ? (b.data.error && b.data.error.message) || '빌드에 실패했어요.' : null,
      url: siteUrl(env, name),
    });
  }
  if (b.status !== 404) throw ghError(b, '빌드 상태를 확인하지 못했어요.');

  const p = await gh(env, 'GET', `/repos/${owner}/${name}/pages`);
  if (p.status === 404) return json({ status: 'pending', error: null, url: siteUrl(env, name) });
  if (!p.ok) throw ghError(p, '빌드 상태를 확인하지 못했어요.');
  return json({ status: p.data.status || 'queued', error: null, url: siteUrl(env, name) });
}

async function updateSite(req, env, ctx, name) {
  await requireEditor(req, env, name);
  const repo = await getManagedRepo(env, name);
  const body = await readJson(req);
  const cur = parseDescription(repo.description, name);
  const title = body.title === undefined ? cur.title : clean(body.title, 60) || name;
  const author = body.author === undefined ? cur.author : clean(body.author, 30);
  const r = await gh(env, 'PATCH', `/repos/${env.GITHUB_OWNER}/${name}`, { description: describe(title, author) });
  if (!r.ok) throw ghError(r, '사이트 정보를 수정하지 못했어요.');
  ctx.waitUntil(purgeGallery(req));
  return json(siteInfo(env, r.data));
}

async function deleteSite(req, env, ctx, name) {
  await requireEditor(req, env, name);
  await getManagedRepo(env, name);
  const r = await gh(env, 'DELETE', `/repos/${env.GITHUB_OWNER}/${name}`);
  if (!r.ok && r.status !== 404) throw ghError(r, '사이트를 삭제하지 못했어요. (토큰에 삭제 권한이 있는지 확인하세요)');
  ctx.waitUntil(purgeGallery(req));
  return json({ ok: true });
}

/* ───────────────────────── Auth ───────────────────────── */

async function requireAdmin(req, env) {
  const code = req.headers.get('X-Admin-Code') || '';
  if (!safeEqual(code, env.ADMIN_CODE)) {
    await sleep(1000);
    throw new HttpError(401, '관리자 코드가 올바르지 않아요.');
  }
}

async function requireEditor(req, env, name) {
  const admin = req.headers.get('X-Admin-Code');
  if (admin && safeEqual(admin, env.ADMIN_CODE)) return 'admin';
  const token = req.headers.get('X-Edit-Token') || '';
  if (!token || !safeEqual(token, await editToken(env, name))) {
    await sleep(500);
    throw new HttpError(403, '편집 키가 올바르지 않아요.');
  }
  return 'owner';
}

// 편집 키 = HMAC(SIGNING_SECRET, owner/name). 서버에 따로 저장할 필요가 없음.
async function editToken(env, name) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(env.SIGNING_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${env.GITHUB_OWNER}/${name}`.toLowerCase()));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
}

function safeEqual(a, b) {
  a = String(a);
  b = String(b);
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ───────────────────────── GitHub ───────────────────────── */

async function gh(env, method, path, body) {
  const headers = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'deploy-hub-worker',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(GH_API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text };
  }
  return { ok: res.ok, status: res.status, data, headers: res.headers };
}

function ghError(r, fallback) {
  const detail = r.data && r.data.message ? ` (${r.data.message})` : '';
  if (r.status === 401) return new HttpError(500, '서버의 GitHub 토큰이 만료되었거나 올바르지 않아요. 관리자에게 알려 주세요.');
  if (r.status === 403 || r.status === 429) {
    if (r.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(detail)) {
      return new HttpError(429, 'GitHub 요청 한도에 도달했어요. 몇 분 뒤에 다시 시도해 주세요.');
    }
    return new HttpError(502, `${fallback} GitHub 권한이 부족해요.${detail}`);
  }
  return new HttpError(502, `${fallback}${detail}`);
}

async function getManagedRepo(env, name) {
  const r = await gh(env, 'GET', `/repos/${env.GITHUB_OWNER}/${name}`);
  if (r.status === 404) throw new HttpError(404, '사이트를 찾을 수 없어요.');
  if (!r.ok) throw ghError(r, '사이트 정보를 확인하지 못했어요.');
  if (!(r.data.topics || []).includes(topic(env))) throw new HttpError(403, '이 시스템에서 관리하는 사이트가 아니에요.');
  return r.data;
}

/* ───────────────────────── Helpers ───────────────────────── */

function topic(env) {
  return (env.TOPIC || 'deploy-hub').toLowerCase();
}

function pagesBase(env) {
  return `https://${env.GITHUB_OWNER.toLowerCase()}.github.io/`;
}

function siteUrl(env, name) {
  return `${pagesBase(env)}${name}/`;
}

function validName(env, raw) {
  const name = String(raw || '').trim().toLowerCase();
  if (!NAME_RE.test(name) || name.includes('--')) {
    throw new HttpError(400, '주소는 영문 소문자, 숫자, 하이픈(-)으로 3~40자여야 해요.');
  }
  const reserved = (env.RESERVED_NAMES || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (reserved.includes(name)) throw new HttpError(409, '사용할 수 없는 주소예요. 다른 이름을 골라 주세요.');
  return name;
}

function cleanPath(raw) {
  const path = String(raw || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const segs = path.split('/');
  if (!path || path.length > 300) return null;
  if (segs.some((s) => !s || s === '.' || s === '..' || s.toLowerCase() === '.git')) return null;
  if (/[\x00-\x1f]/.test(path)) return null;
  return path;
}

function clean(value, max) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

function describe(title, author) {
  return author ? `[${author.replace(/[[\]]/g, '')}] ${title}` : title;
}

function parseDescription(desc, name) {
  const m = /^\[([^\]]*)\]\s*(.*)$/.exec(desc || '');
  return m ? { author: m[1], title: m[2] || name } : { author: '', title: desc || name };
}

function siteInfo(env, repo) {
  const { title, author } = parseDescription(repo.description, repo.name);
  return {
    name: repo.name,
    title,
    author,
    url: siteUrl(env, repo.name),
    createdAt: repo.created_at,
    updatedAt: repo.pushed_at || repo.updated_at,
  };
}

async function purgeGallery(req) {
  await caches.default.delete(new Request(new URL(GALLERY_CACHE_PATH, req.url).toString()));
}

async function readJson(req) {
  try {
    return (await req.json()) || {};
  } catch {
    throw new HttpError(400, '요청 형식이 올바르지 않아요.');
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function corsHeaders(req, env) {
  const origin = req.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  const allow = allowed.includes('*') ? '*' : allowed.includes(origin) ? origin : allowed[0] || '';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Edit-Token, X-Admin-Code',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
