# 📸 PhoneCam Pro

**PhoneCam Pro** convierte tu iPhone en una webcam HD profesional para tu PC, con la experiencia de **Camo Studio**: app nativa en el iPhone, panel de control en el escritorio y salida a OBS Studio como cámara virtual.

---

## ✨ Arquitectura (estilo Camo Studio)

```
iPhone (app nativa / Safari)           PC (servidor + Electron)
┌──────────────────────────┐          ┌───────────────────────────────┐
│  Cámara → WebRTC (1080p) │─────────▶│  Servidor HTTPS (Socket.IO)   │
│  Audio del micrófono     │  WiFi    │  Panel de control Electron    │
│  Filtros, zoom, flash    │ ◀────────│  Controles remotos            │
│  Bloqueo de orientación  │          │  OBS Browser Source           │
│  Pantalla negra          │          │  → Cámara virtual de OBS      │
└──────────────────────────┘          └───────────────────────────────┘
```

---

## 📱 App de iPhone (nativa, estilo Camo)

Dos formas de usar tu iPhone como cámara:

### Opción A — App nativa (Capacitor)
- La app es un proyecto iOS real en `ios/` (generado con Capacitor).
- **Se construye automáticamente en GitHub Actions** en un runner de macOS (sin necesitar Mac) y genera el archivo `.ipa`.
- El IPA se instala con **Sideloadly** o **AltStore** usando tu Apple ID.

### Opción B — Sin instalar nada (Safari)
1. Inicia el servidor en el PC.
2. Abre en el iPhone: `https://IP-DEL-PC:3000/mobile/`.
3. Escanea el QR del panel del PC y listo.
4. Puedes "Agregar a pantalla de inicio" (PWA) para que se vea como app.

---

## 🔐 Certificados HTTPS de confianza (requisito iOS)

iOS solo permite la cámara en páginas HTTPS **confiables**. El proyecto incluye una CA propia para que el iPhone confíe en tu PC local:

```bash
npm run generate-ca
```

Genera `certs/` (CA + certificado firmado) y el perfil `PhoneCamPro-Trust.mobileconfig`.

**Instalación en el iPhone (una sola vez):**
1. Lleva `PhoneCamPro-Trust.mobileconfig` a tu iPhone (AirDrop, iCloud Drive, WhatsApp…).
2. *Ajustes → General → Gestión de VPN y dispositivos* → Instala el perfil.
3. *Ajustes → General → Información → Ajustes de confianza de certificados* → activa **PhoneCam Pro Root CA**.
4. A partir de ahí la cámara funciona en Safari, en la app nativa y en OBS.

---

## 🚀 Cómo iniciar el escritorio

1. `npm install` (la primera vez).
2. Doble clic en `PhoneCam-Pro.vbs` (o `start.bat`, o `npm start`).
3. En el iPhone abre la app nativa o Safari y conéctate a la IP mostrada.
4. Escanea el QR con la app del iPhone.

---

## 🎥 Integración con OBS Studio (Cámara Virtual)

1. Abre **OBS Studio**.
2. *Fuentes → + → Navegador (Browser)*.
3. Pega la **URL OBS** que aparece en el panel de PhoneCam Pro.
4. Ancho `1920`, Alto `1080`, FPS `60`.
5. En OBS: *Controles → Iniciar cámara virtual*.
6. En Zoom/Discord/Teams selecciona **OBS Virtual Camera**.

---

## 🎮 Controles estilo Camo

| Función | Móvil | Escritorio |
|:---|:---:|:---:|
| Cambiar cámara (frontal/trasera) | ✅ | ✅ |
| Resolución (480p / 720p / 1080p / 4K) | ✅ | ✅ |
| FPS (15 / 30 / 60) | ✅ | ✅ |
| Filtros (B&N, Sepia, Cálido, …) | ✅ | ✅ |
| Brillo / Contraste / Saturación | ✅ | ✅ |
| Flash / Linterna | ✅ | ✅ |
| Zoom | ✅ | — |
| **Bloqueo de orientación** (Vertical/Horizontal) | ✅ | ✅ |
| **Pantalla negra** (sigue transmitiendo) | ✅ | — |
| Micrófono + ganancia | ✅ | ✅ |
| Batería en vivo | ✅ | ✅ |

---

## ⌨️ Atajos de teclado (escritorio)

| Tecla | Acción |
|:---|:---|
| `F` | Pantalla completa |
| `P` | Picture-in-Picture |
| `S` | Captura de pantalla |
| `R` | Grabar video |
| `G` | Guías de composición |
| `M` | Espejo horizontal |

---

## 🔨 Construir el IPA (sin Mac)

El workflow `.github/workflows/build-ios.yml` compila la app en un runner de macOS:

1. Sube este proyecto a un repositorio de GitHub.
2. Abre *Actions → Build iPhone App (IPA) → Run workflow*.
3. Descarga el artifact `PhoneCamPro-ipa`.
4. Instálalo en tu iPhone con **Sideloadly** o **AltStore** (firma con tu Apple ID).

> El IPA se genera sin firma para que lo firme Sideloadly/AltStore con tu Apple ID (validez de 7 días en cuenta gratuita).

---

## 📁 Estructura

```
phonecam-pro/
├── .github/workflows/build-ios.yml  # Build automático del IPA
├── ios/                             # Proyecto Xcode (Capacitor)
├── public/
│   ├── mobile/                      # Interfaz de cámara del iPhone
│   ├── native/                      # Launcher de la app nativa
│   ├── desktop/                     # Panel de control de PC
│   ├── obs/                         # Vista limpia para OBS
│   └── shared/                      # Módulos WebRTC y configuración
├── certs/                           # CA + certificado HTTPS
├── generate-ca.js                   # Genera CA, cert y perfil iOS
├── capacitor.config.ts              # Configuración de la app nativa
├── server.js                        # Servidor HTTPS + WebRTC signaling
├── main.js                          # Electron (escritorio)
└── package.json
```