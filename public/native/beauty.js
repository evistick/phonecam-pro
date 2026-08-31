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

    // Contorno completo del rostro (frente → sienes → mandíbula → barbilla) en orden.
    const FACE_OVAL_RING = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
    // Nariz: puente + alas + puntas; los orificios se extraen aparte.
    const NOSE_RING_IDX = [168, 6, 197, 195, 5, 4, 1, 19, 94, 2, 98, 327, 326, 328, 289, 298, 331, 309, 3, 51, 218, 219, 220, 115, 48, 64, 98, 2];
    const NOSTRIL_IDX = [2, 97, 98, 327, 326, 328, 129, 206, 209, 198, 217, 327, 2, 97, 98, 327, 326, 328, 129, 206, 209, 198, 217];
    // Ojos: contorno completo para tallar con borde suave (alarga el saco hacia el pómulo).
    const EYE_LEFT_IDX = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
    const EYE_RIGHT_IDX = [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398];
    // Cejas: banda horizontal para tallar junto con el ojo dejando piel arriba.
    const BROW_LEFT_IDX = [55, 65, 52, 53, 46, 105, 66, 107];
    const BROW_RIGHT_IDX = [285, 295, 282, 283, 276, 334, 296, 336];
    // Boca: labios completos (el interior de los labios queda sin suavizar).
    const MOUTH_IDX = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95, 185, 40, 39, 37, 0, 267, 269, 270, 409, 415, 310, 311, 312, 13, 82, 81, 42, 183, 78];

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

    const beauty = {
        active: false,
        raf: null,
        params: { smooth: 0, glow: 0, sharp: 40, faceMode: false },
        rawStream: null,
        rawTrack: null,
        vendorBase: 'vendor/mediapipe/',
        width: 0, height: 0,
        src: null, canvas: null, ctx: null,
        smoothCanvas: null, smoothCtx: null,
        maskCanvas: null, maskCtx: null, maskBlur: null, maskBlurCtx: null,
        skinLayer: null, skinCtx: null,
        sharpLayer: null, sharpCtx: null,
        underCv: null, underCtx: null, rosyCv: null, rosyCtx: null,
        underMask: null, underMaskCtx: null, underMaskBlur: null, underMaskBlurCtx: null,
        detCanvas: null, detCtx: null,
        detTs: 0, landmarker: null, loading: null,
        prevLms: null, targetLms: null, curLms: null, smoothLms: null,
        landT0: 0, lastHit: 0, lastDet: 0,
        outStream: null, outTrack: null,
        srcObject: null,
        startPlayback(stream) {
            beauty.srcObject = null;
            if (stream && stream.getVideoTracks().length) {
                beauty.srcObject = stream;
                beauty.src.srcObject = stream;
            } else if (beauty.rawTrack) {
                const m = new MediaStream([beauty.rawTrack]);
                beauty.srcObject = m;
                beauty.src.srcObject = m;
            }
            const p = beauty.src.play && beauty.src.play();
            if (p && p.catch) p.catch(() => {});
        }
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
            beauty.skinLayer = document.createElement('canvas');
            beauty.skinCtx = beauty.skinLayer.getContext('2d');
            beauty.sharpLayer = document.createElement('canvas');
            beauty.sharpCtx = beauty.sharpLayer.getContext('2d');
            beauty.underCv = document.createElement('canvas');
            beauty.underCtx = beauty.underCv.getContext('2d');
            beauty.rosyCv = document.createElement('canvas');
            beauty.rosyCtx = beauty.rosyCv.getContext('2d');
            beauty.underMask = document.createElement('canvas');
            beauty.underMaskCtx = beauty.underMask.getContext('2d');
            beauty.underMaskBlur = document.createElement('canvas');
            beauty.underMaskBlurCtx = beauty.underMaskBlur.getContext('2d');
        }
        beauty.canvas.width = W; beauty.canvas.height = H;
        beauty.sharpLayer.width = W; beauty.sharpLayer.height = H;
    }

    let domSlot;

    function attachToDom(el) {
        if (domSlot) return;
        domSlot = document.createElement('div');
        domSlot.setAttribute('aria-hidden', 'true');
        domSlot.style.cssText = 'position:fixed;left:-9999px;top:0;width:4px;height:4px;overflow:hidden;opacity:0;z-index:-1;pointer-events:none;';
        domSlot.appendChild(el);
        (document.body || document.documentElement).appendChild(domSlot);
    }

    function ensureDetCanvas() {
        // 512px: alta resolución para landmarks precisos de ojos/nariz/boca.
        // Mayor que antes (384) → menos sub-muestreo, landmarks más estables en rasgos finos.
        const dw = 512;
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
        if (now - beauty.lastHit > 160) {
            beauty.targetLms = null; beauty.prevLms = null; beauty.curLms = null; beauty.smoothLms = null;
            return null;
        }
        const prog = Math.min(1, (now - beauty.landT0) / 55);
        const ease = 1 - Math.pow(1 - prog, 3);
        const t = beauty.targetLms, p = beauty.prevLms || t;
        const raw = t.map((pt, i) => {
            const pp = p[i] || pt;
            return { x: pp.x + (pt.x - pp.x) * ease, y: pp.y + (pt.y - pp.y) * ease };
        });
        // Low-pass exponencial adicional sobre la posición interpolada para
        // reducir el jitter de alta frecuencia (temblor) de los landmarks.
        if (!beauty.smoothLms) {
            beauty.smoothLms = raw.map(pt => ({ x: pt.x, y: pt.y }));
        } else {
            const alpha = 0.4; // más bajo = más suave pero algo más lento
            for (let i = 0; i < raw.length; i++) {
                const s = beauty.smoothLms[i], r = raw[i];
                s.x += (r.x - s.x) * alpha;
                s.y += (r.y - s.y) * alpha;
            }
        }
        beauty.curLms = beauty.smoothLms;
        return beauty.curLms;
    }

    function underEyeBands(lms) {
        const bands = [];
        for (const eye of [FACE_HOLES[0], FACE_HOLES[1]]) {
            if (!eye.idxs.every(i => i < lms.length)) continue;
            let minx = 1, maxx = 0, miny = 1, maxy = 0, my = 0;
            for (const i of eye.idxs) {
                const p = lms[i];
                if (p.x < minx) minx = p.x;
                if (p.x > maxx) maxx = p.x;
                if (p.y < miny) miny = p.y;
                if (p.y > maxy) maxy = p.y;
                my += p.y;
            }
            my /= eye.idxs.length;
            let lowMax = 0;
            for (const i of eye.idxs) { const p = lms[i]; if (p.y > my && p.y > lowMax) lowMax = p.y; }
            const ex = Math.max(0.01, maxx - minx), ey = Math.max(0.004, maxy - miny);
            bands.push({ cx: (minx + maxx) / 2, cy: lowMax + ey * 0.6, rx: ex * 0.9, ry: ey * 1.15 });
        }
        return bands;
    }

    function buildUnderMask(lms) {
        const mw = beauty.maskCanvas.width, mh = beauty.maskCanvas.height;
        const m = beauty.underMaskCtx;
        m.clearRect(0, 0, mw, mh);
        m.fillStyle = '#fff';
        for (const b of underEyeBands(lms)) {
            m.beginPath();
            m.ellipse(b.cx * mw, b.cy * mh, b.rx * mw, b.ry * mh, 0, 0, Math.PI * 2);
            m.fill();
        }
        const mb = beauty.underMaskBlurCtx;
        mb.clearRect(0, 0, mw, mh);
        mb.filter = 'blur(' + Math.max(3, Math.round(mh / 45)) + 'px)';
        mb.drawImage(beauty.underMask, 0, 0);
        mb.filter = 'none';
        m.clearRect(0, 0, mw, mh);
        m.drawImage(beauty.underMaskBlur, 0, 0);
    }

    function buildFaceLayer() {
        const W = beauty.width, H = beauty.height;
        const lms = interpolatedLms();
        if (!lms) return;
        const sw = Math.max(64, Math.round(W / 4)), sh = Math.max(36, Math.round(H / 4));
        const sctx = beauty.smoothCtx;
        if (beauty.smoothCanvas.width !== sw) {
            beauty.smoothCanvas.width = sw; beauty.smoothCanvas.height = sh;
            beauty.skinLayer.width = sw; beauty.skinLayer.height = sh;
            beauty.underCv.width = sw; beauty.underCv.height = sh;
            beauty.rosyCv.width = sw; beauty.rosyCv.height = sh;
        }
        sctx.filter = 'blur(' + Math.max(2, Math.round(W / 130)) + 'px)';
        sctx.drawImage(beauty.canvas, 0, 0, sw, sh);
        sctx.filter = 'none';

        const pK = beauty.sharpCtx;
        pK.globalCompositeOperation = 'source-over';
        pK.globalAlpha = 1;
        pK.clearRect(0, 0, W, H);
        pK.drawImage(beauty.canvas, 0, 0, W, H);

        const mw = Math.round(W / 2.2), mh = Math.round(H / 2.2);
        if (beauty.maskCanvas.width !== mw) {
            beauty.maskCanvas.width = mw; beauty.maskCanvas.height = mh;
            beauty.maskBlur.width = mw; beauty.maskBlur.height = mh;
            beauty.underMask.width = mw; beauty.underMask.height = mh;
            beauty.underMaskBlur.width = mw; beauty.underMaskBlur.height = mh;
        }

        const m = beauty.maskCtx;
        m.clearRect(0, 0, mw, mh);

        // Máscara de "cara completa": contorno del rostro + rasgos con borde suave.
        const ringPts = (idxs) => idxs.map(i => [lms[i].x * mw, lms[i].y * mh]);
        const fillPoly = (pts, bright) => {
            if (!pts.length) return;
            m.fillStyle = 'rgb(' + (bright | 0) + ',' + (bright | 0) + ',' + (bright | 0) + ')';
            m.beginPath();
            m.moveTo(pts[0][0], pts[0][1]);
            for (let i = 1; i < pts.length; i++) m.lineTo(pts[i][0], pts[i][1]);
            m.closePath();
            m.fill();
        };

        // 1) Toda la cara (frente, mejillas, mandíbula): suavizado completo.
        //    Se expande muy poco para que el borde coincida con el contorno del
        //    rostro y no invada el fondo ni el cabello (evita borde de "máscara").
        const oval = expandPoly(convexHull(ringPts(FACE_OVAL_RING)), 1.02);
        fillPoly(oval, 255);

        // 2) Rasgos a proteger con transición suave: cejas y ojos (duras),
        //    boca (mediana) y nariz (muy leve).
        fillPoly(expandPoly(convexHull(ringPts(BROW_LEFT_IDX)), 1.3), 0);
        fillPoly(expandPoly(convexHull(ringPts(BROW_RIGHT_IDX)), 1.3), 0);
        fillPoly(expandPoly(convexHull(ringPts(EYE_LEFT_IDX)), 1.3), 0);
        fillPoly(expandPoly(convexHull(ringPts(EYE_RIGHT_IDX)), 1.3), 0);
        fillPoly(expandPoly(convexHull(ringPts(MOUTH_IDX)), 1.35), 0);
        // Nariz: leve suavizado (gris) para que el puente y las alas se noten
        // filtradas pero sin el aspecto "parche" de las zonas duras.
        m.globalAlpha = 0.42;
        fillPoly(expandPoly(convexHull(ringPts(NOSE_RING_IDX)), 1.05), 0);
        m.globalAlpha = 1;
        fillPoly(expandPoly(convexHull(ringPts(NOSTRIL_IDX)), 1.2), 0);

        const mb = beauty.maskBlurCtx;
        mb.clearRect(0, 0, mw, mh);
        mb.filter = 'blur(' + Math.max(2, Math.round(mh / 22)) + 'px)';
        mb.drawImage(beauty.maskCanvas, 0, 0);
        mb.filter = 'none';
        m.clearRect(0, 0, mw, mh);
        m.drawImage(beauty.maskBlur, 0, 0);

        buildUnderMask(lms);

        const pK2 = beauty.sharpCtx;
        pK2.globalCompositeOperation = 'destination-in';
        pK2.drawImage(beauty.maskCanvas, 0, 0, mw, mh, 0, 0, W, H);
        pK2.globalCompositeOperation = 'source-over';

        const ctx = beauty.ctx;
        const smoothK = beauty.params.smooth / 100;
        const whiteK = beauty.params.glow / 100;
        const sharpK = beauty.params.sharp / 100;

        const sK = beauty.skinCtx;
        sK.clearRect(0, 0, sw, sh);
        sK.drawImage(beauty.smoothCanvas, 0, 0);
        sK.globalCompositeOperation = 'destination-in';
        sK.drawImage(beauty.maskCanvas, 0, 0, mw, mh, 0, 0, sw, sh);
        sK.globalCompositeOperation = 'source-over';

        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        if (smoothK > 0) {
            ctx.globalAlpha = 0.35 + smoothK * 0.5;
            ctx.drawImage(beauty.skinLayer, 0, 0, sw, sh, 0, 0, W, H);
        }

        const uC = beauty.underCtx;
        uC.clearRect(0, 0, sw, sh);
        uC.drawImage(beauty.smoothCanvas, 0, 0);
        uC.globalCompositeOperation = 'screen';
        uC.fillStyle = 'rgba(255, 208, 200, 0.5)';
        uC.fillRect(0, 0, sw, sh);
        uC.globalCompositeOperation = 'destination-in';
        uC.drawImage(beauty.underMaskBlur, 0, 0, mw, mh, 0, 0, sw, sh);
        uC.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 0.2 + smoothK * 0.25 + whiteK * 0.1;
        ctx.drawImage(beauty.underCv, 0, 0, sw, sh, 0, 0, W, H);

        const rC = beauty.rosyCtx;
        rC.clearRect(0, 0, sw, sh);
        rC.fillStyle = 'rgb(255, 186, 196)';
        rC.fillRect(0, 0, sw, sh);
        rC.globalCompositeOperation = 'destination-in';
        rC.drawImage(beauty.maskCanvas, 0, 0, mw, mh, 0, 0, sw, sh);
        rC.globalCompositeOperation = 'source-over';
        ctx.globalCompositeOperation = 'overlay';
        ctx.globalAlpha = 0.06 + whiteK * 0.15;
        ctx.drawImage(beauty.rosyCv, 0, 0, sw, sh, 0, 0, W, H);
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = 0.05 + whiteK * 0.14;
        ctx.drawImage(beauty.rosyCv, 0, 0, sw, sh, 0, 0, W, H);

        if (whiteK > 0) {
            ctx.globalCompositeOperation = 'screen';
            ctx.globalAlpha = 0.02 + whiteK * 0.08;
            ctx.drawImage(beauty.smoothCanvas, 0, 0, sw, sh, 0, 0, W, H);
        }

        // Detalle nítido encima (textura de poros sin arrugas → NÍTIDO)
        if (smoothK > 0 && sharpK > 0) {
            ctx.globalCompositeOperation = 'overlay';
            ctx.globalAlpha = 0.25 + sharpK * 0.5;
            ctx.drawImage(beauty.sharpLayer, 0, 0, W, H);
        }
        ctx.restore();
    }

    function wholeFrameSmooth() {
        const W = beauty.width, H = beauty.height;
        const sw = Math.max(64, Math.round(W / 4)), sh = Math.max(36, Math.round(H / 4));
        const sctx = beauty.smoothCtx;
        if (beauty.smoothCanvas.width !== sw) { beauty.smoothCanvas.width = sw; beauty.smoothCanvas.height = sh; }
        sctx.filter = 'blur(' + Math.max(2, Math.round(W / 400)) + 'px)';
        sctx.drawImage(beauty.canvas, 0, 0, sw, sh);
        sctx.filter = 'none';
        const lctx = beauty.ctx;
        lctx.save();
        lctx.globalAlpha = 0.15 + (beauty.params.smooth / 100) * 0.35;
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
        const hasRaw = beauty.rawTrack && beauty.rawTrack.readyState !== 'ended';
        if (hasRaw && (!beauty.srcObject || !beauty.srcObject.getVideoTracks().length)) {
            beauty.startPlayback(null);
        } else if (beauty.srcObject !== s && s.getVideoTracks().length) {
            beauty.startPlayback(s);
        }
        if (beauty.src.paused) {
            const p = beauty.src.play && beauty.src.play();
            if (p && p.catch) p.catch(() => {});
        }
        if (!beauty.src.videoWidth || !beauty.src.videoHeight) return;
        const vw = beauty.src.videoWidth, vh = beauty.src.videoHeight;
        if (!vw || !vh) return;
        ensureCanvas(vw, vh);
        beauty.ctx.globalCompositeOperation = 'source-over';
        beauty.ctx.globalAlpha = 1;
        beauty.ctx.drawImage(beauty.src, 0, 0, beauty.width, beauty.height);
        if (!beauty.params.smooth && !beauty.params.glow) return;
        if (beauty.params.faceMode) {
            if (beauty.landmarker && performance.now() - beauty.lastDet >= 25) {
                beauty.lastDet = performance.now();
                try {
                    const dc = ensureDetCanvas();
                    beauty.detCtx.drawImage(beauty.canvas, 0, 0, dc.width, dc.height);
                    const res = beauty.landmarker.detectForVideo(dc, beauty.detTs += 25);
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
            // buildFaceLayer() ya retorna sin tocar la imagen si no hay cara
            // detectada (belleza recién activada o cara fuera de cuadro), así el
            // suavizado NUNCA se aplica a todo el frame por error.
            buildFaceLayer();
        } else if (beauty.params.smooth || beauty.params.glow) {
            // Fallback sin detección de rostro solo si se pidió explícitamente
            // desactivar el modo cara (p.ej. filtro "suavizar todo el video").
            wholeFrameSmooth();
        }
    }

    root.PhoneCamBeauty = {
        async start(opts) {
            if (beauty.active) return beauty.outTrack;
            beauty.params = { smooth: opts.smooth || 0, glow: opts.glow || 0, sharp: (opts.sharp === undefined ? 40 : opts.sharp), faceMode: !!opts.faceMode };
            beauty.rawStream = opts.rawStream;
            beauty.rawTrack = opts.rawStream ? opts.rawStream.getVideoTracks()[0] : null;
            beauty.vendorBase = opts.vendorBase || 'vendor/mediapipe/';
            if (!beauty.src) {
                beauty.src = document.createElement('video');
                beauty.src.muted = true;
                beauty.src.playsInline = true;
                beauty.src.setAttribute('playsinline', '');
                beauty.src.setAttribute('webkit-playsinline', '');
                beauty.src.autoplay = true;
                attachToDom(beauty.src);
            }
            beauty.srcObject = null;
            beauty.src.srcObject = null;
            beauty.startPlayback(beauty.rawStream);
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
            if ('sharp' in p) beauty.params.sharp = p.sharp;
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
            if (beauty.src) {
                try { beauty.src.pause(); } catch (e) { /* noop */ }
                try { beauty.src.srcObject = null; } catch (e) { /* noop */ }
            }
            beauty.srcObject = null;
            beauty.targetLms = beauty.prevLms = beauty.curLms = beauty.smoothLms = null;
            return raw;
        }
    };
})(window);