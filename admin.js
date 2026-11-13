// Upload files from the browser and commit them to GitHub in ONE commit.
// Render redeploys from GitHub, so nothing is lost on restart (Render's disk is temporary).
const crypto = require('crypto');

const API = process.env.GITHUB_API || 'https://api.github.com';
const REPO = process.env.GITHUB_REPO || 'Mahir-g9/gif';
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const SKIP = /(^|\/)(node_modules|\.git)(\/|$)/;

async function gh(method, url, body) {
    const r = await fetch(`${API}/repos/${REPO}${url}`, {
        method,
        headers: {
            Authorization: 'Bearer ' + process.env.GITHUB_TOKEN,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'media-host-admin',
            'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('GitHub says: ' + (d.message || r.status));
    return d;
}

async function readTree() {
    const ref = await gh('GET', `/git/ref/heads/${BRANCH}`);
    const head = ref.object.sha;
    const commit = await gh('GET', `/git/commits/${head}`);
    const t = await gh('GET', `/git/trees/${commit.tree.sha}?recursive=1`);
    return { head, treeSha: commit.tree.sha, items: t.tree.filter(i => !SKIP.test(i.path)) };
}

// For each file name: where does it already exist? Also lists the folders you can choose from.
async function plan(names) {
    const { items } = await readTree();
    const folders = ['', ...items.filter(i => i.type === 'tree').map(i => i.path)].sort();
    const files = names.map(name => ({
        name,
        matches: items.filter(i => i.type === 'blob' && i.path.split('/').pop() === name).map(i => i.path)
    }));
    return { repo: REPO, branch: BRANCH, folders, files };
}

const okPath = p => /^[A-Za-z0-9_][A-Za-z0-9_.\-/]{0,150}$/.test(p) && !p.includes('..') && !p.includes('//') && !SKIP.test(p) && !p.endsWith('/');

async function push(files, message) {
    if (!files.length) throw Object.assign(new Error('No files selected.'), { status: 400 });
    for (const f of files) {
        if (!okPath(f.path)) throw Object.assign(new Error('Not allowed: "' + f.path + '". Use letters, numbers, dots, dashes and underscores only.'), { status: 400 });
    }
    const { head, treeSha } = await readTree();
    const entries = [];
    for (const f of files) {
        const b = await gh('POST', '/git/blobs', { content: f.content.toString('base64'), encoding: 'base64' });
        entries.push({ path: f.path, mode: '100644', type: 'blob', sha: b.sha });
    }
    const t = await gh('POST', '/git/trees', { base_tree: treeSha, tree: entries });
    const c = await gh('POST', '/git/commits', { message, tree: t.sha, parents: [head] });
    await gh('PATCH', `/git/refs/heads/${BRANCH}`, { sha: c.sha });
    return { sha: c.sha, url: `https://github.com/${REPO}/commit/${c.sha}`, files: files.map(f => f.path) };
}

// Password check (header x-admin-key) with a simple lockout after 10 wrong tries.
const attempts = new Map();
function auth(req) {
    if (!process.env.ADMIN_PASSWORD || !process.env.GITHUB_TOKEN) {
        return { status: 503, error: 'Set ADMIN_PASSWORD and GITHUB_TOKEN in Render first.' };
    }
    const ip = req.ip, now = Date.now();
    let a = attempts.get(ip) || { n: 0, t: now };
    if (now - a.t > 15 * 60 * 1000) a = { n: 0, t: now };
    if (a.n >= 10) return { status: 429, error: 'Too many wrong passwords. Try again in 15 minutes.' };
    const h = s => crypto.createHash('sha256').update(String(s)).digest();
    if (crypto.timingSafeEqual(h(req.get('x-admin-key') || ''), h(process.env.ADMIN_PASSWORD))) {
        attempts.delete(ip);
        return null;
    }
    a.n++; attempts.set(ip, a);
    return { status: 401, error: 'Wrong password.' };
}

const guard = (req, res, next) => {
    const bad = auth(req);
    bad ? res.status(bad.status).json({ error: bad.error }) : next();
};

module.exports = { plan, push, auth, guard, okPath };
