/* Shared loader: LOADING types out, a green bar shows the upload, then a blue bar
   fills the same track while the server processes. Bars start slow, speed up in the
   middle and rush at the end. Stripes step at 4 fps. */
(function () {
    const stripes = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Cpath d='M-6 30L30-6M6 30L42-6M-18 30L18-6' stroke='white' stroke-opacity='.55' stroke-width='4'/%3E%3C/svg%3E\")";
    const css = `.ld{width:100%;text-align:center}
.ld-t{font-weight:800;letter-spacing:.3em;font-size:1.1rem;min-height:1.4em;margin-bottom:12px}
.ld-bar{position:relative;height:22px;border:2px solid currentColor;border-radius:10px 3px 10px 3px;overflow:hidden}
.ld-bar i{position:absolute;top:0;bottom:0;left:0;width:0}
.ld-bar .g{background:#2ecc40}.ld-bar .b{background:#2f5bff}
.ld-bar::after{content:"";position:absolute;inset:0;background-image:${stripes};background-size:24px 24px;animation:ldmove 1s steps(4) infinite}
.ld-l{margin-top:10px;font-weight:700;letter-spacing:.2em;font-size:.85rem;min-height:1.3em}
@keyframes ldmove{to{background-position:24px 0}}
@media (prefers-reduced-motion:reduce){.ld-bar::after{animation:none}}`;
    const st = document.createElement('style'); st.textContent = css; document.head.append(st);

    const ease = t => t * t;                                  // slow, fast, very fast
    const WORD = 'LOADING', GAPS = [300, 260, 220, 170, 120, 80, 50]; // typing speeds up too

    function build(el) {
        el.innerHTML = '<div class="ld" role="status"><div class="ld-t"></div><div class="ld-bar"><i class="g"></i><i class="b"></i></div><div class="ld-l"></div></div>';
        const t = el.querySelector('.ld-t'), g = el.querySelector('.g'), b = el.querySelector('.b'), l = el.querySelector('.ld-l');
        const quick = matchMedia('(prefers-reduced-motion: reduce)').matches;
        let n = 0, alive = true, state = 'load', hasUp = false, up = 0, gv = 0, bv = 0, t0 = 0, est = 20, done = null;

        (function type() {
            if (!alive) return;
            t.textContent = WORD.slice(0, ++n);
            if (n < WORD.length) setTimeout(type, quick ? 0 : GAPS[n - 1]);
        })();

        function frame(now) {
            if (!alive) return;
            const gt = state === 'upload' ? ease(up) : (hasUp && state !== 'load' ? 1 : 0);
            gv += (gt - gv) * 0.3; if (Math.abs(gt - gv) < 0.002) gv = gt;
            const gDone = !hasUp || gv >= 1;
            if ((state === 'process' || state === 'finish') && gDone) {
                if (!t0) t0 = now;
                if (state === 'process') bv = Math.max(bv, 0.9 * ease(Math.min(1, (now - t0) / (est * 1000))));
                else { bv += (1 - bv) * 0.3; if (bv > 0.995) { bv = 1; if (done) { const d = done; done = null; setTimeout(d, 150); } } }
            }
            g.style.width = gv * 100 + '%'; b.style.width = bv * 100 + '%';
            l.textContent = state === 'upload' ? 'UPLOADING' : (state === 'process' || state === 'finish') ? 'PROCESSING' : '';
            requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);

        return {
            upload() { hasUp = true; state = 'upload'; },
            up(p) { up = Math.max(up, Math.min(1, p)); },
            process(seconds) { state = 'process'; est = seconds || 20; },
            finish() { state = 'finish'; return new Promise(r => { done = r; }); },
            remove() { alive = false; el.innerHTML = ''; }
        };
    }

    // POST with a loader. body can be a function (sync or async) that returns the body.
    // Resolves with the parsed JSON, rejects with an Error that has the server's message.
    async function run(el, o) {
        const L = build(el);
        try {
            const body = typeof o.body === 'function' ? await o.body() : o.body;
            const data = await new Promise((resolve, reject) => {
                const x = new XMLHttpRequest();
                x.open('POST', o.url);
                if (o.json) x.setRequestHeader('Content-Type', 'application/json');
                for (const k in (o.headers || {})) x.setRequestHeader(k, o.headers[k]);
                if (o.upload) {
                    L.upload();
                    x.upload.onprogress = e => { if (e.lengthComputable) L.up(e.loaded / e.total); };
                    x.upload.onload = () => { L.up(1); L.process(o.est); };
                } else L.process(o.est);
                x.onerror = () => reject(new Error('Network error. Check your connection.'));
                x.onload = () => {
                    let d = {}; try { d = JSON.parse(x.responseText); } catch (e) {}
                    x.status < 400 ? resolve(d) : reject(new Error(d.error || 'Request failed.'));
                };
                x.send(body);
            });
            await L.finish();
            L.remove();
            return data;
        } catch (e) {
            L.remove();
            throw e;
        }
    }

    window.Loader = { run };
})();
