/**
 * PhoneCam Pro — Beauty pipeline (iPhone) — v3 "Instagram/TikTok style"
 *
 * Objetivo: alisar el rostro y aclarar la piel SOLO en la cara, sin difuminar el
 * fondo, con aspecto natural (sin "parche" visible) y fluido a 60fps.
 *
 * Claves del diseño:
 *  - Detección de rostro (MediaPipe Face Landmarker) con throttle y sin bloquear
 *    el render; la máscara se reutiliza e interpola entre detecciones.
 *  - Máscara de piel por color (YCrCb) limitada al contorno facial detectado:
 *    cubre exactamente la piel (nunca cabello/ojos/boca/fondo), lo que elimina
 *    el aspecto de "parche" y evita difuminar el fondo.
 *  - Procesado en baja resolución: rápido y fluido.
 *
 * API externa (inalterada): start / configure / updateRaw / getTrack /
 * getRawTrack / stop. Expone root.PhoneCamBeauty.
 */
(function (root) {
    'use strict';

    // Índices de la malla MediaPipe (468 puntos).
    const FACE_OVAL_RING = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
    const RING_LEFT_BROW = [55, 65, 52, 53, 46, 105, 66, 107];
    const RING_RIGHT_BROW = [285, 295, 282, 283, 276, 334, 296, 336];
    const RING_LEFT_EYE = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
    const RING_RIGHT_EYE = [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398];
    const RING_MOUTH = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95, 185, 40, 39, 37, 0, 267, 269, 270, 409, 415, 310, 311, 312, 13, 82, 81, 42, 183, 78];
    // Zona de los cachetes (mejillas): se les da un suavizado/aclarado extra suave.
    const LEFT_CHEEK_CTR = [205, 203, 206, 207, 50, 123, 117, 118, 119, 101, 36];
    const RIGHT_CHEEK_CTR = [432, 436, 435, 425, 281, 352, 367, 347, 346, 371, 401];
    const NOSE_TIP = 1; // punta de la nariz, para dimensionar el radio del cachete.
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
        if (!pts.length) return pts;
        let cx = 0, cy = 0;
        for (const p of pts) { cx += p[0]; cy += p[1]; }
        cx /= pts.length; cy /= pts.length;
        return pts.map(p => [cx + (p[0] - cx) * f, cy + (p[1] - cy) * f]);
    }

    function tracePoly(ctx, pts) {
        if (pts.length < 3) return;
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.closePath();
        ctx.fill();
    }

    function isSkin(r, g, b) {
        const Y = 0.299 * r + 0.587 * g + 0.114 * b;
        const Cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
        const Cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
        if (Y < 16 || Y > 235) return false;
        return (Cb >= 77 && Cb <= 127) && (Cr >= 133 && Cr <= 173);
    }

    const beauty = {
        active: false,
        raf: null,
        params: { smooth: 40, glow: 40, sharp: 0, faceMode: true },
        rawStream: null,
        rawTrack: null,
        vendorBase: 'vendor/mediapipe/',
        width: 0, height: 0,
        out: null, outCtx: null,
        low: null, lowCtx: null, lowW: 0, lowH: 0,
        face: null, faceCtx: null, faceW: 0, faceH: 0,
        mask: null, maskCtx: null, maskW: 0, maskH: 0,
        mask2: null, mask2Ctx: null,
        skin: null, skinCtx: null, skinW: 0, skinH: 0,
        src: null,
        detCanvas: null, detCtx: null, detTs: 0,
        landmarker: null, loading: null,
        lm: null, lmHit: 0, lastDet: 0,
        maskValid: false,
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

    let domSlot;
    function attachToDom(el) {
        if (domSlot) return;
        domSlot = document.createElement('div');
        domSlot.setAttribute('aria-hidden', 'true');
        domSlot.style.cssText = 'position:fixed;left:-9999px;top:0;width:4px;height:4px;overflow:hidden;opacity:0;z-index:-1;pointer-events:none;';
        domSlot.appendChild(el);
        (document.body || document.documentElement).appendChild(domSlot);
    }

    function ensureCanvas(w, h) {
        const scale = Math.min(1, 1280 / w);
        const W = Math.max(2, Math.round(w * scale)), H = Math.max(2, Math.round(h * scale));
        if (beauty.width === W && beauty.height === H) return;
        beauty.width = W; beauty.height = H;
        if (!beauty.out) {
            beauty.out = document.createElement('canvas');
            beauty.outCtx = beauty.out.getContext('2d');
            beauty.low = document.createElement('canvas');
            beauty.lowCtx = beauty.low.getContext('2d');
            beauty.face = document.createElement('canvas');
            beauty.faceCtx = beauty.face.getContext('2d');
            beauty.mask = document.createElement('canvas');
            beauty.maskCtx = beauty.mask.getContext('2d', { willReadFrequently: true });
            beauty.mask2 = document.createElement('canvas');
            beauty.mask2Ctx = beauty.mask2.getContext('2d');
            beauty.skin = document.createElement('canvas');
            beauty.skinCtx = beauty.skin.getContext('2d');
            beauty.cheek = document.createElement('canvas');
            beauty.cheekCtx = beauty.cheek.getContext('2d');
            beauty.lip = document.createElement('canvas');
            beauty.lipCtx = beauty.lip.getContext('2d');
        }
        beauty.out.width = W; beauty.out.height = H;
        beauty.lowW = Math.max(64, Math.round(W / 2));
        beauty.lowH = Math.max(36, Math.round(H / 2));
        beauty.low.width = beauty.lowW; beauty.low.height = beauty.lowH;
        beauty.faceW = beauty.lowW; beauty.faceH = beauty.lowH;
        beauty.face.width = beauty.faceW; beauty.face.height = beauty.faceH;
        beauty.maskW = Math.max(48, Math.round(W / 5));
        beauty.maskH = Math.max(28, Math.round(H / 5));
        beauty.mask.width = beauty.maskW; beauty.mask.height = beauty.maskH;
        beauty.mask2.width = beauty.maskW; beauty.mask2.height = beauty.maskH;
        beauty.cheek.width = beauty.maskW; beauty.cheek.height = beauty.maskH;
        beauty.lip.width = beauty.maskW; beauty.lip.height = beauty.maskH;
        beauty.skinW = beauty.lowW; beauty.skinH = beauty.lowH;
        beauty.skin.width = beauty.skinW; beauty.skin.height = beauty.skinH;
        beauty.maskValid = false;
    }

    function ensureDetCanvas() {
        const dw = 320;
        const dh = Math.max(30, Math.round(dw * beauty.height / beauty.width));
        if (!beauty.detCanvas) {
            beauty.detCanvas = document.createElement('canvas');
            beauty.detCtx = beauty.detCanvas.getContext('2d', { willReadFrequently: true });
        }
        if (beauty.detCanvas.width !== dw || beauty.detCanvas.height !== dh) {
            beauty.detCanvas.width = dw; beauty.detCanvas.height = dh;
        }
        return beauty.detCanvas;
    }

    async function ensureDetector() {
        if (beauty.landmarker) return true;
        if (beauty.loading) return beauty.loading;
        beauty.loading = (async () => {
            const deadline = performance.now() + 12000;
            try {
                let mp = window.__mp;
                while (!mp && performance.now() < deadline) {
                    await new Promise(r => setTimeout(r, 50));
                    mp = window.__mp;
                }
                if (!mp) {
                    try { mp = await import(beauty.vendorBase + 'vision_bundle.mjs'); } catch (e) {}
                }
                if (!mp || !mp.FaceLandmarker) {
                    console.warn('Beauty detector: MediaPipe API no disponible', !!mp);
                    return false;
                }
                const { FaceLandmarker, FilesetResolver } = mp;
                const files = await FilesetResolver.forVisionTasks(beauty.vendorBase + 'wasm');
                beauty.landmarker = await FaceLandmarker.createFromOptions(files, {
                    baseOptions: { modelAssetPath: beauty.vendorBase + 'face_landmarker.task', delegate: 'CPU' },
                    runningMode: 'VIDEO', numFaces: 1,
                    minFaceDetectionConfidence: 0.4,
                    minTrackingConfidence: 0.4
                });
                return true;
            } catch (e) {
                console.warn('Beauty detector load failed:', e);
                return false;
            }
        })();
        return beauty.loading;
    }

    function setTargetLms(raw) {
        const tgt = raw.map(p => ({ x: p.x, y: p.y }));
        if (!beauty.lm) {
            beauty.lm = tgt.map(p => ({ x: p.x, y: p.y }));
        } else {
            const p = beauty.lm;
            const a = 0.6;
            for (let i = 0; i < tgt.length; i++) {
                p[i].x += (tgt[i].x - p[i].x) * a;
                p[i].y += (tgt[i].y - p[i].y) * a;
            }
        }
        beauty.lmHit = performance.now();
        beauty.maskValid = false;
    }

    function hullOf(idxs, mw, mh) {
        const lms = beauty.lm;
        if (!lms) return [];
        const pts = [];
        for (const i of idxs) { const p = lms[i]; if (p) pts.push([p.x * mw, p.y * mh]); }
        return pts.length >= 3 ? convexHull(pts) : [];
    }

    function centroidOf(idxs, mw, mh) {
        const lms = beauty.lm;
        if (!lms) return null;
        let cx = 0, cy = 0, n = 0;
        for (const i of idxs) { const p = lms[i]; if (p) { cx += p.x; cy += p.y; n++; } }
        if (!n) return null;
        return [cx / n * mw, cy / n * mh];
    }

    // Construye la máscara de piel por color limitada al contorno facial.
    function buildSkinMask() {
        const mw = beauty.maskW, mh = beauty.maskH;
        const mask = beauty.maskCtx;

        // 1) Pintar el frame reducido en mask para leer los colores de la piel.
        mask.clearRect(0, 0, mw, mh);
        mask.drawImage(beauty.out, 0, 0, mw, mh);

        // 2) Detectar píxel piel por color (en mask, baja resolución).
        const img = mask.getImageData(0, 0, mw, mh);
        const d = img.data;
        for (let k = 0; k < d.length; k += 4) {
            d[k + 3] = isSkin(d[k], d[k + 1], d[k + 2]) ? 255 : 0;
        }
        mask.putImageData(img, 0, 0);

        // 3) Restringir al contorno de la cara (silueta facial).
        const m2 = beauty.mask2Ctx;
        m2.clearRect(0, 0, mw, mh);
        m2.fillStyle = '#000';
        m2.fillRect(0, 0, mw, mh);
        m2.fillStyle = '#fff';
        tracePoly(m2, expandPoly(hullOf(FACE_OVAL_RING, mw, mh), 1.05));

        // Restar rasgos que NO deben llevar filtro: cejas, ojos y boca.
        // La NARIZ se deja DENTRO (es piel): así recibe blanqueador y suavizado.
        // Las fosas nasales (oscuras) se excluyen solas con el test de color YCrCb.
        m2.globalCompositeOperation = 'destination-out';
        m2.fillStyle = '#fff';
        for (const ring of [RING_LEFT_BROW, RING_RIGHT_BROW, RING_LEFT_EYE, RING_RIGHT_EYE, RING_MOUTH]) {
            tracePoly(m2, expandPoly(hullOf(ring, mw, mh), 1.15));
        }
        m2.globalCompositeOperation = 'source-over';

        // 4) skinColor AND faceSilhouette → quedarse con piel dentro del rostro.
        mask.globalCompositeOperation = 'destination-in';
        mask.drawImage(beauty.mask2, 0, 0);
        mask.globalCompositeOperation = 'source-over';

        // 5) Suavizar el borde de la máscara para que el retoque sea imperceptible.
        const tmp = beauty.mask2Ctx;
        tmp.clearRect(0, 0, mw, mh);
        tmp.filter = 'blur(' + Math.max(2, Math.round(mh / 30)) + 'px)';
        tmp.drawImage(beauty.mask, 0, 0);
        tmp.filter = 'none';
        mask.clearRect(0, 0, mw, mh);
        mask.drawImage(beauty.mask2, 0, 0);

        // 6) Máscaras de región: cachetes (suavizado/aclarado extra) y labios (clarear).
        const cheekR = Math.max(2, Math.round(mw * 0.09));
        const noseC = centroidOf([NOSE_TIP], mw, mh);
        const cheekCtx = beauty.cheekCtx;
        cheekCtx.clearRect(0, 0, mw, mh);
        if (noseC) {
            cheekCtx.fillStyle = '#fff';
            const lc = centroidOf(LEFT_CHEEK_CTR, mw, mh);
            const rc = centroidOf(RIGHT_CHEEK_CTR, mw, mh);
            if (lc) cheekCircle(cheekCtx, lc, cheekR);
            if (rc) cheekCircle(cheekCtx, rc, cheekR);
        }
        // Restringir cachetes a la zona de piel ya validada (máscara de piel).
        cheekCtx.globalCompositeOperation = 'destination-in';
        cheekCtx.drawImage(beauty.mask, 0, 0);
        cheekCtx.globalCompositeOperation = 'source-over';
        cheekCtx.filter = 'blur(' + Math.max(2, Math.round(mh / 20)) + 'px)';
        cheekCtx.drawImage(beauty.cheek, 0, 0);
        cheekCtx.filter = 'none';
        // Redibujar tras el blur (necesario: blur sobre sí mismo se acumula en blanco).
        const cheekTmp = beauty.mask2Ctx;
        cheekTmp.clearRect(0, 0, mw, mh);
        cheekTmp.drawImage(beauty.cheek, 0, 0);
        cheekCtx.clearRect(0, 0, mw, mh);
        cheekCtx.drawImage(cheekTmp.canvas, 0, 0);

        // Labios: usar el contorno de la boca como zona.
        const lipCtx = beauty.lipCtx;
        lipCtx.clearRect(0, 0, mw, mh);
        const mouthPoly = hullOf(RING_MOUTH, mw, mh);
        if (mouthPoly.length) {
            lipCtx.fillStyle = '#fff';
            tracePoly(lipCtx, expandPoly(mouthPoly, 0.85));
            lipCtx.filter = 'blur(' + Math.max(2, Math.round(mh / 28)) + 'px)';
            lipCtx.drawImage(beauty.lip, 0, 0);
            lipCtx.filter = 'none';
            const lipTmp = beauty.mask2Ctx;
            lipTmp.clearRect(0, 0, mw, mh);
            lipTmp.drawImage(beauty.lip, 0, 0);
            lipCtx.clearRect(0, 0, mw, mh);
            lipCtx.drawImage(lipTmp.canvas, 0, 0);
        }

        beauty.maskValid = true;
    }

    function cheekCircle(ctx, c, r) {
        ctx.beginPath();
        ctx.arc(c[0], c[1], r, 0, Math.PI * 2);
        ctx.fill();
    }

    // Aplica suavizado + aclarado sobre la cara (máscara de piel).
    function applyRetouch() {
        const smoothK = beauty.params.smooth / 100;
        const glowK = beauty.params.glow / 100;

        // Blur del frame en baja resolución (barato) → imagen suavizada.
        // w/90 da un difuminado claramente visible (look belleza marcada).
        const blurPx = Math.max(3, Math.round(beauty.width / 90));
        const lowCtx = beauty.lowCtx;
        lowCtx.filter = 'blur(' + blurPx + 'px)';
        lowCtx.drawImage(beauty.out, 0, 0, beauty.lowW, beauty.lowH);
        lowCtx.filter = 'none';

        // face = imagen suavizada enmascarada por la piel.
        const f = beauty.faceCtx;
        f.clearRect(0, 0, beauty.faceW, beauty.faceH);
        f.drawImage(beauty.low, 0, 0);
        f.globalCompositeOperation = 'destination-in';
        f.drawImage(beauty.mask, 0, 0, beauty.maskW, beauty.maskH, 0, 0, beauty.faceW, beauty.faceH);
        f.globalCompositeOperation = 'source-over';

        const ctx = beauty.outCtx;
        // Suavizado marcado tipo Instagram (piel bien lisa, sin plastificar del todo).
        if (smoothK > 0) {
            ctx.globalAlpha = Math.min(0.95, 0.45 + smoothK * 0.55);
            ctx.drawImage(beauty.face, 0, 0, beauty.faceW, beauty.faceH, 0, 0, beauty.width, beauty.height);
            ctx.globalAlpha = 1;
        }

        // Aclarado de piel (whiten) sutil, tipo Instagram.
        if (glowK > 0 && (smoothK > 0 || beauty.skinW)) {
            const s = beauty.skinCtx;
            s.clearRect(0, 0, beauty.skinW, beauty.skinH);
            s.fillStyle = '#ffffff';
            s.fillRect(0, 0, beauty.skinW, beauty.skinH);
            s.globalCompositeOperation = 'destination-in';
            s.drawImage(beauty.mask, 0, 0, beauty.maskW, beauty.maskH, 0, 0, beauty.skinW, beauty.skinH);
            s.globalCompositeOperation = 'source-over';
            ctx.globalCompositeOperation = 'overlay';
            ctx.globalAlpha = 0.08 + glowK * 0.22;
            ctx.drawImage(beauty.skin, 0, 0, beauty.skinW, beauty.skinH, 0, 0, beauty.width, beauty.height);
            ctx.globalCompositeOperation = 'source-over';
            ctx.globalAlpha = 1;
        }

        const cw = beauty.skinW, chh = beauty.skinH;
        const s = beauty.skinCtx;
        // Cachetes: suavizado extra (repintar la cara ya suavizada solo ahí).
        if (smoothK > 0 && beauty.maskValid) {
            s.clearRect(0, 0, cw, chh);
            s.globalCompositeOperation = 'copy';
            s.drawImage(beauty.face, 0, 0, beauty.faceW, beauty.faceH, 0, 0, cw, chh);
            s.globalCompositeOperation = 'destination-in';
            s.drawImage(beauty.cheek, 0, 0, beauty.maskW, beauty.maskH, 0, 0, cw, chh);
            s.globalCompositeOperation = 'source-over';
            ctx.globalAlpha = Math.min(0.6, 0.2 + smoothK * 0.4);
            ctx.drawImage(beauty.skin, 0, 0, cw, chh, 0, 0, beauty.width, beauty.height);
            ctx.globalAlpha = 1;
        }
        // Cachetes: aclarado (whiten) extra suave.
        if (glowK > 0 && beauty.maskValid) {
            s.clearRect(0, 0, cw, chh);
            s.fillStyle = '#ffffff';
            s.fillRect(0, 0, cw, chh);
            s.globalCompositeOperation = 'destination-in';
            s.drawImage(beauty.cheek, 0, 0, beauty.maskW, beauty.maskH, 0, 0, cw, chh);
            s.globalCompositeOperation = 'source-over';
            ctx.globalCompositeOperation = 'overlay';
            ctx.globalAlpha = 0.1 + glowK * 0.12;
            ctx.drawImage(beauty.skin, 0, 0, cw, chh, 0, 0, beauty.width, beauty.height);
            ctx.globalCompositeOperation = 'source-over';
            ctx.globalAlpha = 1;
        }
        // Labios: aclarado suave (screen añade luz sin saturar).
        if (glowK > 0 && beauty.maskValid) {
            s.clearRect(0, 0, cw, chh);
            s.fillStyle = '#ffffff';
            s.fillRect(0, 0, cw, chh);
            s.globalCompositeOperation = 'destination-in';
            s.drawImage(beauty.lip, 0, 0, beauty.maskW, beauty.maskH, 0, 0, cw, chh);
            s.globalCompositeOperation = 'source-over';
            ctx.globalCompositeOperation = 'screen';
            ctx.globalAlpha = 0.18 + glowK * 0.12;
            ctx.drawImage(beauty.skin, 0, 0, cw, chh, 0, 0, beauty.width, beauty.height);
            ctx.globalCompositeOperation = 'source-over';
            ctx.globalAlpha = 1;
        }
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
        if (beauty.src.paused) { const p = beauty.src.play && beauty.src.play(); if (p && p.catch) p.catch(() => {}); }
        if (!beauty.src.videoWidth || !beauty.src.videoHeight) return;
        const vw = beauty.src.videoWidth, vh = beauty.src.videoHeight;
        if (!vw || !vh) return;
        ensureCanvas(vw, vh);
        beauty.outCtx.globalAlpha = 1;
        beauty.outCtx.globalCompositeOperation = 'source-over';
        beauty.outCtx.drawImage(beauty.src, 0, 0, beauty.width, beauty.height);

        const smoothK = beauty.params.smooth / 100;
        const glowK = beauty.params.glow / 100;
        if (smoothK <= 0 && glowK <= 0) return;

        // Detección de rostro (throttled ~33ms, no bloquea el render).
        if (beauty.landmarker && performance.now() - beauty.lastDet >= 33) {
            beauty.lastDet = performance.now();
            try {
                const dc = ensureDetCanvas();
                beauty.detCtx.drawImage(beauty.out, 0, 0, dc.width, dc.height);
                const res = beauty.landmarker.detectForVideo(dc, beauty.detTs += 33);
                const arr = res.faceLandmarks || [];
                if (arr.length) {
                    setTargetLms(arr[0]);
                } else if (performance.now() - beauty.lmHit > 300) {
                    beauty.lm = null; beauty.maskValid = false;
                }
            } catch (e) { /* noop */ }
        }

        if (!beauty.lm) return;
        if (!beauty.maskValid) buildSkinMask();
        applyRetouch();
    }

    root.PhoneCamBeauty = {
        async start(opts) {
            if (beauty.active) return beauty.outTrack;
            beauty.params = {
                smooth: (opts.smooth === undefined ? 40 : opts.smooth),
                glow: (opts.glow === undefined ? 40 : opts.glow),
                sharp: (opts.sharp === undefined ? 0 : opts.sharp),
                faceMode: (opts.faceMode === undefined ? true : !!opts.faceMode)
            };
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
            if (!beauty.out) ensureCanvas(1280, 720);
            if (beauty.params.faceMode) {
                const ok = await ensureDetector();
                if (!ok) {
                    beauty.params.faceMode = false;
                    beauty.params.smooth = 0;
                    beauty.params.glow = 0;
                    if (root.dispatchEvent) root.dispatchEvent(new CustomEvent('beauty-detector-unavailable'));
                }
            }
            if (!beauty.outStream) {
                const fps = Math.min(60, opts.fps || 30);
                beauty.outStream = beauty.out.captureStream(fps);
                beauty.outTrack = beauty.outStream.getVideoTracks()[0];
            }
            beauty.active = true;
            beauty.lastDet = 0;
            beauty.lm = null; beauty.maskValid = false;
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

        getTrack() { return beauty.outTrack; },
        getRawTrack() { return beauty.rawTrack; },

        stop() {
            beauty.active = false;
            if (beauty.raf) cancelAnimationFrame(beauty.raf);
            beauty.raf = null;
            if (beauty.outTrack) { try { beauty.outTrack.stop(); } catch (e) {} }
            const raw = beauty.rawTrack;
            beauty.rawTrack = null;
            if (beauty.outStream) { try { beauty.outStream.getTracks().forEach(t => t.stop()); } catch (e) {} }
            beauty.outStream = null; beauty.outTrack = null;
            if (beauty.src) { try { beauty.src.pause(); } catch (e) {} try { beauty.src.srcObject = null; } catch (e) {} }
            beauty.srcObject = null;
            beauty.lm = null; beauty.maskValid = false;
            return raw;
        }
    };
})(window);
