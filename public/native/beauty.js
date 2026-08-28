/**
 * PhoneCam Pro — Beauty pipeline for the phone (iPhone)
 * Runs on-device: MediaPipe face mesh -> real skin mask -> dual-blur retouch + glow.
 * Self-contained: the app hands it the raw MediaStream and it outputs a processed canvas track.
 */
(function (root) {
    'use strict';

    // Canonical MediaPipe Face Mesh index groups (468-pt topology)
    const FACE_HOLES = [
        { idxs: [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246], margin: 1.7 },
        { idxs: [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398], margin: 1.7 },
        { idxs: [70, 63, 105, 66, 107, 55, 65, 52, 53, 46], margin: 1.45 },
        { idxs: [300, 293, 334, 296, 336, 285, 295, 282, 283, 276], margin: 1.45 },
        { idxs: [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95, 185, 40, 39, 37, 0, 267, 269, 270, 409, 415, 310, 311, 312, 13, 82, 81, 42, 183, 78], margin: 1.4 },
        { idxs: [1, 2, 98, 327, 4, 5, 197, 195, 168], margin: 1.75 }
    ];

    function convexHull(pts) {
        pts = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
        const lo = [];
        for (const p of pts) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
        const up = [];
        for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
        lo.pop(); up.pop();
        return lo.concat(up);
    }

    function expandPoly(pts, f) {
        let cx = 0, cy = 0;
        for (const p of pts) { cx += p[0]; cy += p[1]; }
        cx /= pts.length; cy /= pts.length;
        return pts.map(p => [cx + (p[0] - cx) * f, cy + (p[1] - cy) * f]);
    }

    const meshTriCache = {};

    function delaunay(pts) {
        const n = pts.length, EPS = 1e-9;
        let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
        for (let i = 0; i < n; i++) {
            const p = pts[i];
            if (p.x < minx) minx = p.x;
            if (p.y < miny) miny = p.y;
            if (p.x > maxx) maxx = p.x;
            if (p.y > maxy) maxy = p.y;
        }
        const dx = (maxx - minx) || 1, dy = (maxy - miny) || 1, dmax = Math.max(dx, dy) * 10;
        const midx = (minx + maxx) / 2, midy = (miny + maxy) / 2;
        const P = pts.concat([{ x: midx - dmax, y: midy - dmax }, { x: midx, y: midy + dmax }, { x: midx + dmax, y: midy - dmax }]);
        let tris = [{ a: n, b: n + 1, c: n + 2 }];
        const inCirc = (a, b, c, p) => {
            const ax = P[a].x, ay = P[a].y, bx = P[b].x, by = P[b].y, cx = P[c].x, cy = P[c].y, px = p.x, py = p.y;
            const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
            if (Math.abs(d) < 1e-12) return false;
            const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
            const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
            const r2 = (ux - ax) * (ux - ax) + (uy - ay) * (uy - ay);
            return (ux - px) * (ux - px) + (uy - py) * (uy - py) <= r2 + EPS;
        };
        for (let i = 0; i < n; i++) {
            const p = P[i];
            const bad = [], next = [];
            for (const t of tris) { if (inCirc(t.a, t.b, t.c, p)) bad.push(t); else next.push(t); }
            const edges = new Map();
            const key = (e1, e2) => e1 < e2 ? e1 + '_' + e2 : e2 + '_' + e1;
            for (const t of bad) {
                for (const [e1, e2] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]]) {
                    const k = key(e1, e2);
                    if (edges.has(k)) { const v = edges.get(k); v.c += 1; if (v.c >= 2) edges.delete(k); }
                    else edges.set(k, { c: 1, e1, e2 });
                }
            }
            for (const kv of edges) next.push({ a: kv[1].e1, b: kv[1].e2, c: i });
            tris = next;
        }
        const out = [];
        for (const t of tris) { if (t.a < n && t.b < n && t.c < n) out.push([t.a, t.b, t.c]); }
        return out;
    }

    function inPoly(px, py, poly) {
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
            if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
        }
        return inside;
    }

    const beauty = {
        active: false,
        raf: null,
        params: { smooth: 0, glow: 0, faceMode: false },
        rawStream: null,
        rawTrack: null,
        vendorBase: 'vendor/mediapipe/',
        width: 0, height: 0,
        src: null, canvas: null, ctx: null,
        smoothCanvas: null, smoothCtx: null,
        maskCanvas: null, maskCtx: null, maskBlur: null, maskBlurCtx: null,
        detCanvas: null, detCtx: null,
        detTs: 0, landmarker: null, loading: null,
        prevLms: null, targetLms: null, curLms: null,
        landT0: 0, lastHit: 0, lastDet: 0,
        outStream: null, outTrack: null
    };

    function ensureCanvas(w, h) {
        const scale = Math.min(1, 1280 / w);
        const W = Math.max(2, Math.round(w * scale)), H = Math.max(2, Math.round(h * scale));
        if (beauty.width === W && beauty.height === H) return;
        beauty.width = W; beauty.height = H;
        if (!beauty.canvas) {
            beauty.canvas = document.createElement('canvas');
            beauty.ctx = beauty.canvas.getContext('2d');
            beauty.smoothCanvas = document.createElement('canvas');
            beauty.smoothCtx = beauty.smoothCanvas.getContext('2d');
            beauty.maskCanvas = document.createElement('canvas');
            beauty.maskCtx = beauty.maskCanvas.getContext('2d');
            beauty.maskBlur = document.createElement('canvas');
            beauty.maskBlurCtx = beauty.maskBlur.getContext('2d');
        }
        beauty.canvas.width = W; beauty.canvas.height = H;
    }

    function ensureDetCanvas() {
        const dw = 224;
        const dh = Math.max(30, Math.round(dw * beauty.height / beauty.width));
        if (!beauty.detCanvas) {
            beauty.detCanvas = document.createElement('canvas');
            beauty.detCtx = beauty.detCanvas.getContext('2d', { willReadFrequently: true });
        }
        if (beauty.detCanvas.width !== dw || beauty.detCanvas.height !== dh) {
            beauty.detCanvas.width = dw;
            beauty.detCanvas.height = dh;
        }
        return beauty.detCanvas;
    }

    async function ensureDetector() {
        if (beauty.landmarker) return true;
        if (beauty.loading) return beauty.loading;
        beauty.loading = (async () => {
            try {
                const { FaceLandmarker, FilesetResolver } = await import(beauty.vendorBase + 'vision_bundle.mjs');
                const files = await FilesetResolver.forVisionTasks(beauty.vendorBase + 'wasm');
                beauty.landmarker = await FaceLandmarker.createFromOptions(files, {
                    baseOptions: { modelAssetPath: beauty.vendorBase + 'face_landmarker.task', delegate: 'CPU' },
                    runningMode: 'VIDEO', numFaces: 1
                });
                return true;
            } catch (e) {
                console.warn('Beauty detector load failed:', e);
                return false;
            }
        })();
        return beauty.loading;
    }

    function interpolatedLms() {
        const now = performance.now();
        if (!beauty.targetLms) return null;
        if (now - beauty.lastHit > 130) {
            beauty.targetLms = null; beauty.prevLms = null; beauty.curLms = null;
            return null;
        }
        const prog = Math.min(1, (now - beauty.landT0) / 55);
        const ease = 1 - Math.pow(1 - prog, 3);
        const t = beauty.targetLms, p = beauty.prevLms || t;
        beauty.curLms = t.map((pt, i) => {
            const pp = p[i] || pt;
            return { x: pp.x + (pt.x - pp.x) * ease, y: pp.y + (pt.y - pp.y) * ease };
        });
        return beauty.curLms;
    }

    function buildFaceLayer() {
        const W = beauty.width, H = beauty.height;
        const lms = interpolatedLms();
        if (!lms) return;
        const sw = Math.max(64, Math.round(W / 4)), sh = Math.max(36, Math.round(H / 4));
        const sctx = beauty.smoothCtx;
        if (beauty.smoothCanvas.width !== sw) { beauty.smoothCanvas.width = sw; beauty.smoothCanvas.height = sh; }
        sctx.filter = 'blur(' + Math.max(1, Math.round(W / 800)) + 'px)';
        sctx.drawImage(beauty.canvas, 0, 0, sw, sh);
        sctx.filter = 'none';

        const mw = Math.round(W / 3), mh = Math.round(H / 3);
        if (beauty.maskCanvas.width !== mw) { beauty.maskCanvas.width = mw; beauty.maskCanvas.height = mh; beauty.maskBlur.width = mw; beauty.maskBlur.height = mh; }

        const m = beauty.maskCtx;
        m.clearRect(0, 0, mw, mh);
        if (!(lms.length in meshTriCache)) meshTriCache[lms.length] = delaunay(lms);
        const tris = meshTriCache[lms.length];
        const oval = expandPoly(convexHull(lms.map(p => [p.x, p.y])), 1.05);
        const feats = [];
        for (const f of FACE_HOLES) {
            if (!f.idxs.every(i => i < lms.length)) continue;
            feats.push(expandPoly(convexHull(f.idxs.map(i => [lms[i].x, lms[i].y])), 1.3));
        }
        m.fillStyle = '#fff';
        m.beginPath();
        for (const t of tris) {
            const a = lms[t[0]], b = lms[t[1]], c = lms[t[2]];
            const e1 = (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y);
            const e2 = (a.x - c.x) * (a.x - c.x) + (a.y - c.y) * (a.y - c.y);
            const e3 = (b.x - c.x) * (b.x - c.x) + (b.y - c.y) * (b.y - c.y);
            if (e1 > 0.08 || e2 > 0.08 || e3 > 0.08) continue;
            const gx = (a.x + b.x + c.x) / 3, gy = (a.y + b.y + c.y) / 3;
            if (!inPoly(gx, gy, oval)) continue;
            let sk = false;
            for (const f of feats) {
                if (inPoly(a.x, a.y, f) || inPoly(b.x, b.y, f) || inPoly(c.x, c.y, f)) { sk = true; break; }
            }
            if (sk) continue;
            m.moveTo(a.x * mw, a.y * mh);
            m.lineTo(b.x * mw, b.y * mh);
            m.lineTo(c.x * mw, c.y * mh);
            m.closePath();
        }
        m.fill();

        const mb = beauty.maskBlurCtx;
        mb.clearRect(0, 0, mw, mh);
        mb.filter = 'blur(' + Math.max(3, Math.round(mh / 40)) + 'px)';
        mb.drawImage(beauty.maskCanvas, 0, 0);
        mb.filter = 'none';
        m.clearRect(0, 0, mw, mh);
        m.drawImage(beauty.maskBlur, 0, 0);

        const lctx = beauty.ctx;
        lctx.globalCompositeOperation = 'source-over';
        lctx.globalAlpha = 0.25 + (beauty.params.smooth / 100) * 0.5;
        lctx.drawImage(beauty.maskCanvas, 0, 0, mw, mh, 0, 0, W, H);
        if (beauty.params.glow > 0) {
            lctx.globalCompositeOperation = 'screen';
            lctx.globalAlpha = 0.04 + (beauty.params.glow / 100) * 0.13;
            lctx.drawImage(beauty.smoothCanvas, 0, 0, sw, sh, 0, 0, W, H);
        }
        lctx.globalCompositeOperation = 'soft-light';
        lctx.globalAlpha = 0.06;
        lctx.drawImage(beauty.smoothCanvas, 0, 0, sw, sh, 0, 0, W, H);
        lctx.globalAlpha = 1;
        lctx.globalCompositeOperation = 'source-over';
    }

    function wholeFrameSmooth() {
        const W = beauty.width, H = beauty.height;
        const sw = Math.max(64, Math.round(W / 4)), sh = Math.max(36, Math.round(H / 4));
        const sctx = beauty.smoothCtx;
        if (beauty.smoothCanvas.width !== sw) { beauty.smoothCanvas.width = sw; beauty.smoothCanvas.height = sh; }
        sctx.filter = 'blur(' + Math.max(1, Math.round(W / 800)) + 'px)';
        sctx.drawImage(beauty.canvas, 0, 0, sw, sh);
        sctx.filter = 'none';
        const lctx = beauty.ctx;
        lctx.save();
        lctx.globalAlpha = 0.25 + (beauty.params.smooth / 100) * 0.5;
        lctx.drawImage(beauty.smoothCanvas, 0, 0, W, H);
        lctx.globalAlpha = 1;
        if (beauty.params.glow > 0) {
            lctx.globalCompositeOperation = 'screen';
            lctx.globalAlpha = 0.06 + (beauty.params.glow / 100) * 0.13;
            lctx.drawImage(beauty.smoothCanvas, 0, 0, W, H);
        }
        lctx.globalCompositeOperation = 'soft-light';
        lctx.globalAlpha = 0.05;
        lctx.drawImage(beauty.smoothCanvas, 0, 0, W, H);
        lctx.restore();
    }

    function loop() {
        if (!beauty.active) return;
        beauty.raf = requestAnimationFrame(loop);
        const s = beauty.rawStream;
        if (!s) return;
        if (beauty.src.srcObject !== s) beauty.src.srcObject = s;
        if (!beauty.src.videoWidth) return;
        const vw = beauty.src.videoWidth, vh = beauty.src.videoHeight;
        if (!vw || !vh) return;
        ensureCanvas(vw, vh);
        beauty.ctx.globalCompositeOperation = 'source-over';
        beauty.ctx.globalAlpha = 1;
        beauty.ctx.drawImage(beauty.src, 0, 0, beauty.width, beauty.height);
        if (!beauty.params.smooth) return;
        if (beauty.params.faceMode) {
            if (beauty.landmarker && performance.now() - beauty.lastDet >= 33) {
                beauty.lastDet = performance.now();
                try {
                    const res = beauty.landmarker.detectForVideo(ensureDetCanvas(), beauty.detTs += 33);
                    const arr = res.faceLandmarks || [];
                    if (arr.length) {
                        const tgt = arr[0].map(p => ({ x: p.x, y: p.y }));
                        if (!beauty.targetLms) {
                            beauty.prevLms = tgt.map(p => ({ x: p.x, y: p.y }));
                        } else {
                            beauty.prevLms = beauty.curLms || beauty.targetLms;
                            beauty.curLms = null;
                        }
                        beauty.targetLms = tgt;
                        beauty.landT0 = performance.now();
                        beauty.lastHit = beauty.landT0;
                    }
                } catch (e) { /* noop */ }
            }
            buildFaceLayer();
        } else {
            wholeFrameSmooth();
        }
    }

    root.PhoneCamBeauty = {
        async start(opts) {
            if (beauty.active) return beauty.outTrack;
            beauty.params = { smooth: opts.smooth || 0, glow: opts.glow || 0, faceMode: !!opts.faceMode };
            beauty.rawStream = opts.rawStream;
            beauty.rawTrack = opts.rawStream ? opts.rawStream.getVideoTracks()[0] : null;
            beauty.vendorBase = opts.vendorBase || 'vendor/mediapipe/';
            if (!beauty.src) {
                beauty.src = document.createElement('video');
                beauty.src.muted = true;
                beauty.src.setAttribute('playsinline', 'true');
                beauty.src.autoplay = true;
            }
            if (!beauty.canvas) ensureCanvas(1280, 720);
            if (beauty.params.faceMode) {
                const ok = await ensureDetector();
                if (!ok) beauty.params.faceMode = false;
            }
            if (!beauty.outStream) {
                beauty.outStream = beauty.canvas.captureStream(Math.min(30, opts.fps || 30));
                beauty.outTrack = beauty.outStream.getVideoTracks()[0];
            }
            beauty.active = true;
            beauty.raf = requestAnimationFrame(loop);
            return beauty.outTrack;
        },

        configure(p) {
            if ('smooth' in p) beauty.params.smooth = p.smooth;
            if ('glow' in p) beauty.params.glow = p.glow;
            if ('faceMode' in p) {
                beauty.params.faceMode = !!p.faceMode;
                if (beauty.params.faceMode && !beauty.landmarker) {
                    ensureDetector().then(ok => { if (!ok) beauty.params.faceMode = false; });
                }
            }
        },

        updateRaw(stream) {
            beauty.rawStream = stream;
            if (stream) beauty.rawTrack = stream.getVideoTracks()[0] || null;
        },

        getTrack() {
            return beauty.outTrack;
        },

        getRawTrack() {
            return beauty.rawTrack;
        },

        stop() {
            beauty.active = false;
            if (beauty.raf) cancelAnimationFrame(beauty.raf);
            beauty.raf = null;
            if (beauty.outTrack) {
                try { beauty.outTrack.stop(); } catch (e) { /* noop */ }
            }
            const raw = beauty.rawTrack;
            beauty.rawTrack = null;
            if (beauty.outStream) { try { beauty.outStream.getTracks().forEach(t => t.stop()); } catch (e) { /* noop */ } }
            beauty.outStream = null;
            beauty.outTrack = null;
            beauty.targetLms = beauty.prevLms = beauty.curLms = null;
            return raw;
        }
    };
})(window);