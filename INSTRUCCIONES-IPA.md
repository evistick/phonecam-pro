# Cómo generar el IPA de PhoneCam Pro

Notas para reconstruir el `.ipa` del iPhone cada vez que se pida. La app es una web
(`public/mobile`) envuelta en **Capacitor** (`ios/`). El IPA se genera **sin firma**
(unsigned) y se instala por **sideload** en el iPhone.

---

## Camino A — GitHub Actions (recomendado, sin necesidad de Mac)

El workflow `.github/workflows/build-ios.yml` compila en un runner **macOS** y publica
el IPA automáticamente en cada push a `main`.

1. Editar la app (`public/mobile/`) o el bundle nativo (`public/native/`).
2. `git add . && git commit -m "..." && git push origin main`.
3. Esperar la build (≈4-6 min) y verificar su resultado:
   - Estado: https://github.com/evistick/phonecam-pro/actions
   - API: `GET https://api.github.com/repos/evistick/phonecam-pro/actions/runs`
4. Resultados de la build:
   - **Release estable (sin login, link fijo):**
     `https://github.com/evistick/phonecam-pro/releases/download/test-build/PhoneCamPro-unsigned.ipa`
   - **Artefacto** `PhoneCamPro-ipa` en la página de Actions (requiere login, expira a los 90 días).

> El tag/release `test-build` se borra y re-crea en cada build con el IPA nuevo, así el link de
> descarga nunca cambia. Por eso el archivo local `build/PhoneCamPro-unsigned.ipa` puede
> re-descargarse desde ese link tras cada build.

### Qué hace el workflow
`npm ci` → `npx cap sync ios` → `xcodebuild archive` con `CODE_SIGNING_ALLOWED=NO` →
empaqueta `Payload/PhoneCamPro.app` en `PhoneCamPro-unsigned.ipa` → sube artefacto → lo
publica como asset del release `test-build` (`GH_TOKEN: ${{ github.token }}`, permiso
`contents: write`).

### Nota Windows
Si `npx` está bloqueado por ExecutionPolicy, usar:
`node node_modules/@capacitor/cli/bin/capacitor sync ios`

---

## Camino B — Local en un Mac (necesita Xcode)

```bash
git clone https://github.com/evistick/phonecam-pro.git
cd phonecam-pro
npm install
npx cap sync ios

# IPA sin firmar (para sideload)
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release \
  -archivePath build/PhoneCamPro.xcarchive -destination 'generic/platform=iOS' \
  archive CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO

mkdir -p build/ipa/Payload
cp -R build/PhoneCamPro.xcarchive/Products/Applications/App.app build/ipa/Payload/PhoneCamPro.app
cd build/ipa && zip -r ../PhoneCamPro-unsigned.ipa Payload
```

### IPA firmado (si `build-ios.yml` no alcanza)
- Abrir `ios/App/App.xcodeproj` en Xcode → target **App** → **Signing & Capabilities** →
  elegir **Team** (cuenta gratis = 7 días; desarrollador = sin expiración).
- `Product → Archive` → Organizer → **Distribute App** (*Development* o *Ad Hoc*) → *Export*.

---

## Datos del proyecto iOS

- **Bundle ID:** `com.phonecam.pro` (en `capacitor.config.ts`, `appId`).
- **webDir:** `public/native` — `npx cap sync ios` copia los assets a `ios/App/App/public`
  (esa carpeta está en `.gitignore`, se regenera).
- **Info.plist** (`ios/App/App/Info.plist`) ya tiene:
  `NSCameraUsageDescription`, `NSMicrophoneUsageDescription`,
  `NSLocalNetworkUsageDescription`, `NSAppTransportSecurity` (local network permitida).
- La app nativa pide "IP de tu PC" en la pantalla de conexión manual (la web `mobile` la resuelve sola).
- Icono/xcassets: `ios/App/App/Assets.xcassets` (si los iconos están vacíos, Xcode usa placeholder).

---

## Instalación en el iPhone (sideload del IPA unsigned)

- Herramientas: **Sideloadly** (Windows/Mac) o **AltStore SideStore** (este iPhone ya usa SideStore).
- Cuenta: Apple ID gratis → validez **7 días** (renovar con "Refresh" en SideStore/AltStore).
- Pasos con Sideloadly: descargar el `.ipa` → abrir Sideloadly → colocar el `.ipa` →
  Apple ID → instalar.
- Con SideStore: copiar el `.ipa` al iPhone y abrirlo con SideStore ("Open in SideStore").

---

## Checklist al cambiar la app

1. ¿Cambio solo la **UI web**? → editar `public/mobile/*` y probar en el teléfono desde la
   página del servidor (no hace falta IPA).
2. ¿Quiero la **app nativa** actualizada? → replicar los mismos cambios en `public/native/*`
   (index.html / app.js / style.css son tres archivos hermanos) y luego push para rehacer el IPA.
3. ¿El server necesita correr en el PC? → sí, la app se conecta a `https://<ip-del-pc>:3000`
   (HTTPS con certs locales; el certificado raíz se instala con `PhoneCamPro-Trust.mobileconfig`).
4. Copia local del IPA: `build/PhoneCamPro-unsigned.ipa` (sobreescribible desde el link del release).