const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ffmpeg = require('fluent-ffmpeg');
const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');

ffmpeg.setFfmpegPath(require('ffmpeg-static'));

const app = express();
app.set('trust proxy', 1); // Render terminates TLS, so links come out as https
const PORT = process.env.PORT || 3000;

// ---- Supabase ------------------------------------------------------------
const REF = 'heoweopzgscysmiinbji';
const BUCKET = 'media';
const TTL_HOURS = 24;

if (!process.env.SUPABASE_PASSWORD) console.warn('SUPABASE_PASSWORD is not set.');
if (!process.env.SUPABASE_SERVICE_KEY) console.warn('SUPABASE_SERVICE_KEY is not set.');

// Config object (not a URL string) so special characters in the password are safe.
// If Render cannot reach the direct host (IPv6 only), set SUPABASE_DB_HOST / SUPABASE_DB_USER
// to the Session pooler values from Supabase > Connect.
const pool = new Pool({
    host: process.env.SUPABASE_DB_HOST || `db.${REF}.supabase.co`,
    port: Number(process.env.SUPABASE_DB_PORT || 5432),
    user: process.env.SUPABASE_DB_USER || 'postgres',
    password: process.env.SUPABASE_PASSWORD,
    database: 'postgres',
    ssl: { rejectUnauthorized: false }
});
const supabase = createClient(`https://${REF}.supabase.co`, process.env.SUPABASE_SERVICE_KEY || 'missing', {
    auth: { persistSession: false }
});

async function init() {
    await pool.query(`create table if not exists media (
        id uuid primary key default gen_random_uuid(),
        filename text unique not null,
        kind text not null,
        created_at timestamptz not null default now())`);
    await pool.query('create index if not exists media_created_idx on media (created_at)');
    await pool.query('alter table media enable row level security'); // no public API access
    const { error } = await supabase.storage.createBucket(BUCKET, { public: false });
    if (error && !/exist/i.test(error.message)) console.error('Bucket error:', error.message);
    cleanup();
    setInterval(cleanup, 15 * 60 * 1000);
}

// Delete files + records older than 24 hours.
async function cleanup() {
    try {
        const { rows } = await pool.query(
            `select filename from media where created_at < now() - interval '${TTL_HOURS} hours'`);
        if (!rows.length) return;
        const names = rows.map(r => r.filename);
        const { error } = await supabase.storage.from(BUCKET).remove(names);
        if (error) throw error;
        await pool.query('delete from media where filename = any($1)', [names]);
        names.forEach(n => fs.rm(path.join(uploadDir, n), { force: true }, () => {}));
        console.log(`Cleanup removed ${names.length} file(s).`);
    } catch (e) {
        console.error('Cleanup failed:', e.message);
    }
}

async function store(filePath, name, mime) {
    const buf = await fs.promises.readFile(filePath);
    const { error } = await supabase.storage.from(BUCKET).upload(name, buf, { contentType: mime });
    if (error) throw error;
    await pool.query('insert into media (filename, kind) values ($1, $2)',
        [name, mime === 'image/gif' ? 'gif' : 'video']);
}

// ---- Local cache (Discord needs fast direct files with Range support) ----
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, uploadDir),
        filename: (req, file, cb) => {
            const ext = file.mimetype === 'image/gif' ? '.gif' : '.mp4';
            cb(null, uuidv4().slice(0, 8) + ext);
        }
    }),
    limits: { fileSize: 100 * 1024 * 1024 }
});

app.use(express.static(path.join(__dirname, 'public')));

// Direct link. Falls back to Supabase Storage if the local copy is gone (Render restarts).
app.get('/uploads/:name', async (req, res) => {
    const name = path.basename(req.params.name);
    if (!/^[\w-]+\.(mp4|gif)$/.test(name)) return res.sendStatus(404);
    const p = path.join(uploadDir, name);
    try {
        if (!fs.existsSync(p)) {
            const { data, error } = await supabase.storage.from(BUCKET).download(name);
            if (error || !data) return res.sendStatus(404);
            fs.writeFileSync(p, Buffer.from(await data.arrayBuffer()));
        }
        res.sendFile(p);
    } catch (e) {
        res.sendStatus(404);
    }
});

const fullUrl = (req, name) => `${req.protocol}://${req.get('host')}/uploads/${name}`;

// ---- Upload ----------------------------------------------------------------
app.post('/upload', upload.single('video'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No video uploaded!' });
    try {
        await store(req.file.path, req.file.filename, req.file.mimetype === 'image/gif' ? 'image/gif' : 'video/mp4');
        res.json({ url: fullUrl(req, req.file.filename) });
    } catch (e) {
        console.error(e);
        fs.rm(req.file.path, { force: true }, () => {});
        res.status(500).json({ error: 'Upload failed: ' + (e.message || e) + '.' });
    }
});

// ---- Publish (frames -> MP4 / GIF) ----------------------------------------
const frameUpload = multer({
    dest: path.join(os.tmpdir(), 'frames'),
    limits: { files: 200, fileSize: 8 * 1024 * 1024 }
});

function render(dir, fps, gif, out) {
    return new Promise((resolve, reject) => {
        let cmd = ffmpeg()
            .input(path.join(dir, 'f%03d.png'))
            .inputOptions(['-framerate', String(fps)]);
        if (gif) {
            cmd = cmd
                .complexFilter(['split[a][b]', '[a]palettegen[p]', '[b][p]paletteuse'])
                .outputOptions(['-loop', '0']);
        } else {
            cmd = cmd
                .videoCodec('libx264')
                .videoFilters('scale=trunc(iw/2)*2:trunc(ih/2)*2')
                .outputOptions(['-pix_fmt', 'yuv420p', '-movflags', '+faststart']);
        }
        cmd.on('end', resolve).on('error', reject).save(out);
    });
}

app.post('/publish', frameUpload.array('frames', 200), async (req, res) => {
    const files = req.files || [];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-'));
    try {
        if (!files.length) return res.status(400).json({ error: 'No frames received.' });
        const gif = req.body.format === 'gif';
        const fps = Math.min(Math.max(parseInt(req.body.fps, 10) || 8, 1), 30);
        files.forEach((f, i) => fs.renameSync(f.path, path.join(dir, `f${String(i).padStart(3, '0')}.png`)));
        const name = uuidv4().slice(0, 8) + (gif ? '.gif' : '.mp4');
        const out = path.join(uploadDir, name);
        await render(dir, fps, gif, out);
        await store(out, name, gif ? 'image/gif' : 'video/mp4');
        res.json({ url: fullUrl(req, name) });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Could not publish: ' + (e.message || e) + '.' });
    } finally {
        files.forEach(f => fs.rm(f.path, { force: true }, () => {}));
        fs.rm(dir, { recursive: true, force: true }, () => {});
    }
});

// ---- Album -----------------------------------------------------------------
app.get('/api/media', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `select filename, kind, created_at from media
             where created_at > now() - interval '${TTL_HOURS} hours'
             order by created_at desc limit 200`);
        res.json(rows.map(r => ({ url: fullUrl(req, r.filename), kind: r.kind, createdAt: r.created_at })));
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Could not load album.' });
    }
});

init()
    .catch(e => console.error('Init failed:', e.message))
    .finally(() => app.listen(PORT, () => console.log(`Server is running on port ${PORT}`)));
