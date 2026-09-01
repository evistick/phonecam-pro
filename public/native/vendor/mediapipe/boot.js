// Boot de MediaPipe para PhoneCam Pro.
// Carga el bundle como ES module estático (más fiable en WKWebView que el
// import() dinámico) y expone la API como global para beauty.js.
import { FaceLandmarker, FilesetResolver } from './vision_bundle.mjs';
window.__mp = { FaceLandmarker, FilesetResolver };
