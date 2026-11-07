const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { execFile } = require('child_process');
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
    await pool.query(`create table if not exists hosted_media (
        id uuid primary key default gen_random_uuid(),
        filename text unique not null,
        kind text not null,
        created_at timestamptz not null default now())`);
    await pool.query('create index if not exists hosted_media_created_idx on hosted_media (created_at)');
    await pool.query('alter table hosted_media enable row level security'); // no public API access
    const { error } = await supabase.storage.createBucket(BUCKET, { public: false });
    if (error && !/exist/i.test(error.message)) console.error('Bucket error:', error.message);
    cleanup();
    setInterval(cleanup, 15 * 60 * 1000);
    ensureYt().catch(e => console.error('yt-dlp:', e.message)); // warm up the link downloader
}

// Delete files + records older than 24 hours.
async function cleanup() {
    try {
        const { rows } = await pool.query(
            `select filename from hosted_media where created_at < now() - interval '${TTL_HOURS} hours'`);
        if (!rows.length) return;
        const names = rows.map(r => r.filename);
        const { error } = await supabase.storage.from(BUCKET).remove(names);
        if (error) throw error;
        await pool.query('delete from hosted_media where filename = any($1)', [names]);
        names.forEach(n => {
            fs.rm(path.join(uploadDir, n), { force: true }, () => {});
            fs.rm(path.join(uploadDir, n.replace(/\.mp4$/, '.mp3')), { force: true }, () => {});
        });
        console.log(`Cleanup removed ${names.length} file(s).`);
    } catch (e) {
        console.error('Cleanup failed:', e.message);
    }
}

async function store(filePath, name, mime) {
    const buf = await fs.promises.readFile(filePath);
    const { error } = await supabase.storage.from(BUCKET).upload(name, buf, { contentType: mime });
    if (error) throw error;
    await pool.query('insert into hosted_media (filename, kind) values ($1, $2)',
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
        if (req.query.dl) res.attachment(name); // ?dl=1 forces a download
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
        if (req.file.mimetype === 'image/gif') await shrinkIfNeeded(req.file.path);
        await store(req.file.path, req.file.filename, req.file.mimetype === 'image/gif' ? 'image/gif' : 'video/mp4');
        res.json({ url: fullUrl(req, req.file.filename) });
    } catch (e) {
        console.error(e);
        fs.rm(req.file.path, { force: true }, () => {});
        res.status(500).json({ error: 'Upload failed: ' + (e.message || e) + '.' });
    }
});

// ---- GIF tools: chroma key, border, 8 MB compressor ------------------------
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_SECONDS = 20;

// Edge grow/shrink with boxblur + threshold, so it works on any ffmpeg build.
const erode = r => `,boxblur=${r}:1,lutyuv=y='if(gte(val,250),255,0)'`;
const dilate = r => `,boxblur=${r}:1,lutyuv=y='if(gt(val,5),255,0)'`;

function gifFilter(o, w, fps, colors) {
    let f = `[0:v]fps=${fps},scale='min(iw,${w})':-1:flags=lanczos,format=rgba`;
    if (o.key) {
        f += `,colorkey=0x${o.key}:${o.sim}:${o.blend}`;            // remove the key colour
        if (o.green) f += ',despill=type=green';                      // no green fringe left on edges
        if (o.shrink) f += `,split=2[k][m];[m]alphaextract${erode(o.shrink)}[a];[k][a]alphamerge,format=rgba`;
    }
    if (o.border) {                                                   // outline around what is left
        const c = [0, 2, 4].map(i => parseInt(o.bcolor.substr(i, 2), 16));
        f += `,split=2[fg][w];[w]lutrgb=r=${c[0]}:g=${c[1]}:b=${c[2]},split=2[w1][w2];` +
             `[w2]alphaextract${dilate(o.border)}[wa];[w1][wa]alphamerge[wh];[wh][fg]overlay=format=auto,format=rgba`;
    }
    return f + `,split[s0][s1];[s0]palettegen=max_colors=${colors}:reserve_transparent=1[p];` +
               `[s1][p]paletteuse=dither=bayer:bayer_scale=4:alpha_threshold=128`;
}

function runGif(input, filter, out) {
    return new Promise((resolve, reject) => {
        ffmpeg(input)
            .inputOptions(['-t', String(MAX_SECONDS)])
            .complexFilter(filter)
            .outputOptions(['-an', '-loop', '0', '-gifflags', '-transdiff'])
            .on('end', resolve).on('error', reject)
            .save(out);
    });
}

// Re-encodes smaller (narrower, fewer fps, fewer colours) until the file fits in 8 MB.
async function makeGif(input, o, out) {
    let w = o.width, fps = o.fps, colors = 256;
    for (let i = 0; i < 6; i++) {
        await runGif(input, gifFilter(o, w, fps, colors), out);
        if (fs.statSync(out).size <= MAX_BYTES) return;
        w = Math.round(w * 0.8); fps = Math.max(6, fps - 2); colors = Math.max(64, colors - 48);
    }
    throw new Error('Still over 8 MB after compressing. Try a shorter clip');
}

async function shrinkIfNeeded(file) {
    if (fs.statSync(file).size <= MAX_BYTES) return;
    const tmpOut = file + '.small.gif';
    await makeGif(file, { width: 640, fps: 15 }, tmpOut);
    fs.renameSync(tmpOut, file);
}
// ---- end GIF tools ----------------------------------------------------------

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
        if (gif) await shrinkIfNeeded(out);
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

// ---- Convert (MP4/GIF -> transparent GIF) ----------------------------------
const convUpload = multer({ dest: path.join(os.tmpdir(), 'conv'), limits: { fileSize: 100 * 1024 * 1024 } });
const num = (v, min, max, d) => { const x = parseFloat(v); return isNaN(x) ? d : Math.min(max, Math.max(min, x)); };
const isHex = h => /^[0-9a-f]{6}$/i.test(h || '');

app.post('/convert', convUpload.single('file'), async (req, res) => {
    let input = req.file && req.file.path;
    if (!input) { // convert a video that was fetched from a link
        const n = path.basename(String(req.body.src || ''));
        if (/^[\w-]+\.(mp4|gif)$/.test(n)) input = await ensureLocal(n);
        if (!input) return res.status(400).json({ error: 'Choose a file or fetch a link first.' });
    }
    const b = req.body;
    const key = b.key === 'none' ? null : (isHex(b.key) ? b.key.toLowerCase() : '00ff00');
    let green = false;
    if (key) {
        const [r, g, bl] = [0, 2, 4].map(i => parseInt(key.substr(i, 2), 16));
        green = g > r + 40 && g > bl + 40;
    }
    const o = {
        key, green,
        sim: num(b.sim, 0.01, 0.6, 0.3), blend: num(b.blend, 0, 0.5, 0.1),
        shrink: Math.round(num(b.shrink, 0, 4, 1)), border: Math.round(num(b.border, 0, 8, 2)),
        bcolor: isHex(b.bcolor) ? b.bcolor : 'ffffff',
        width: Math.round(num(b.width, 120, 720, 480)), fps: Math.round(num(b.fps, 5, 20, 12))
    };
    const name = uuidv4().slice(0, 8) + '.gif';
    const out = path.join(uploadDir, name);
    try {
        await makeGif(input, o, out);
        await store(out, name, 'image/gif');
        res.json({ url: fullUrl(req, name), size: fs.statSync(out).size });
    } catch (e) {
        console.error(e);
        fs.rm(out, { force: true }, () => {});
        res.status(500).json({ error: 'Could not convert: ' + (e.message || e) });
    } finally {
        if (req.file) fs.rm(req.file.path, { force: true }, () => {});
    }
});

// ---- Link -> video (YouTube, Facebook, TikTok, ... via yt-dlp) -------------
const YT_BIN = path.join(__dirname, 'bin', 'yt-dlp');
const MAX_VIDEO_MB = 50; // Supabase free plan file limit
let ytBusy = false;

async function ensureYt() {
    if (fs.existsSync(YT_BIN)) return;
    fs.mkdirSync(path.dirname(YT_BIN), { recursive: true });
    const r = await fetch('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux');
    if (!r.ok) throw new Error('Could not download the video tool');
    await fs.promises.writeFile(YT_BIN, Buffer.from(await r.arrayBuffer()));
    await fs.promises.chmod(YT_BIN, 0o755);
}

function safeUrl(u) { // http(s) links to public hostnames only
    try {
        const x = new URL(u), h = x.hostname;
        return /^https?:$/.test(x.protocol) && !net.isIP(h) && h.includes('.') &&
            h !== 'localhost' && !/\.(local|internal|lan)$/.test(h);
    } catch (e) { return false; }
}

function toMp4(input, output) {
    return new Promise((resolve, reject) => {
        ffmpeg(input).videoCodec('libx264').audioCodec('aac')
            .outputOptions(['-pix_fmt', 'yuv420p', '-movflags', '+faststart'])
            .on('end', resolve).on('error', reject).save(output);
    });
}

app.post('/api/fetch', express.json(), async (req, res) => {
    const link = String((req.body && req.body.url) || '').trim();
    if (!safeUrl(link)) return res.status(400).json({ error: 'Enter a valid video link starting with http or https.' });
    if (ytBusy) return res.status(429).json({ error: 'Another download is running. Try again in a minute.' });
    ytBusy = true;
    const id = uuidv4().slice(0, 8);
    try {
        await ensureYt();
        const title = await new Promise((resolve, reject) => {
            execFile(YT_BIN, [
                '--no-playlist', '--no-warnings', '--socket-timeout', '20',
                '--max-filesize', MAX_VIDEO_MB + 'M', '--match-filter', '!is_live & duration<=?600',
                '-f', 'b[ext=mp4][height<=720]/bv*[ext=mp4][height<=720]+ba[ext=m4a]/b[height<=720]/b',
                '--merge-output-format', 'mp4', '--ffmpeg-location', require('ffmpeg-static'),
                '--print', 'title', '--no-simulate',
                '-o', path.join(uploadDir, id + '.%(ext)s'), '--', link
            ], { timeout: 180000, maxBuffer: 1 << 20 }, (err, out, errOut) => {
                if (!err) return resolve((out || '').trim().split('\n')[0].slice(0, 120) || 'Video');
                const msg = ((errOut || '').split('\n').filter(l => l.startsWith('ERROR')).pop() || err.message);
                reject(new Error(/Sign in|confirm you.re not a bot/i.test(msg)
                    ? 'This site blocked the server (it asked for sign-in). Try another link.' : msg.slice(0, 200)));
            });
        });
        const got = fs.readdirSync(uploadDir).find(f => f.startsWith(id + '.'));
        if (!got) throw new Error('Skipped: the video is longer than 10 minutes, live, or over ' + MAX_VIDEO_MB + ' MB.');
        const name = id + '.mp4', out = path.join(uploadDir, name);
        if (got !== name) { await toMp4(path.join(uploadDir, got), out); fs.rm(path.join(uploadDir, got), { force: true }, () => {}); }
        const size = fs.statSync(out).size;
        if (size > MAX_VIDEO_MB * 1024 * 1024) { fs.rmSync(out, { force: true }); throw new Error('Video is over ' + MAX_VIDEO_MB + ' MB.'); }
        await store(out, name, 'video/mp4');
        res.json({ url: fullUrl(req, name), name, title, size });
    } catch (e) {
        console.error(e);
        fs.readdirSync(uploadDir).filter(f => f.startsWith(id + '.')).forEach(f => fs.rm(path.join(uploadDir, f), { force: true }, () => {}));
        res.status(500).json({ error: e.message || 'Could not fetch the video.' });
    } finally {
        ytBusy = false;
    }
});

// MP3 of a stored video, made on first request and then reused.
app.get('/audio/:name', async (req, res) => {
    const name = path.basename(req.params.name);
    if (!/^[\w-]+\.mp4$/.test(name)) return res.sendStatus(404);
    const mp3 = path.join(uploadDir, name.replace(/\.mp4$/, '.mp3'));
    const part = mp3.replace(/\.mp3$/, '.part.mp3');
    try {
        const src = await ensureLocal(name);
        if (!src) return res.sendStatus(404);
        if (!fs.existsSync(mp3)) {
            await new Promise((resolve, reject) => {
                ffmpeg(src).noVideo().audioCodec('libmp3lame').audioBitrate('192k')
                    .on('end', resolve).on('error', reject).save(part);
            });
            fs.renameSync(part, mp3);
        }
        res.attachment(path.basename(mp3));
        res.sendFile(mp3);
    } catch (e) {
        fs.rm(part, { force: true }, () => {});
        res.status(422).send('This video has no audio track.');
    }
});

async function ensureLocal(name) {
    const p = path.join(uploadDir, name);
    if (!fs.existsSync(p)) {
        const { data, error } = await supabase.storage.from(BUCKET).download(name);
        if (error || !data) return null;
        fs.writeFileSync(p, Buffer.from(await data.arrayBuffer()));
    }
    return p;
}

// ---- Album -----------------------------------------------------------------
app.get('/api/media', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `select filename, kind, created_at from hosted_media
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
