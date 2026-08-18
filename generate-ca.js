/**
 * generate-ca.js — Generates a private CA + server certificate signed by it,
 * plus an iOS .mobileconfig profile to trust the CA on the iPhone.
 *
 * Why: iOS only grants camera (getUserMedia) and WebRTC on HTTPS pages whose
 * certificate is trusted by the device. A self-signed leaf cert cannot be
 * trusted on iOS; installing this CA once makes every local HTTPS connection
 * to the PC "just work" in Safari, the native app and OBS.
 *
 * Uses node-forge directly because the `selfsigned` npm package cannot sign
 * leaf certificates with an external CA.
 *
 * Usage: node generate-ca.js
 */

const forge = require('node-forge');
const fs = require('fs');
const path = require('path');
const os = require('os');

const projectDir = __dirname;
const certDir = path.join(projectDir, 'certs');

function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
}

function createKeyPair() {
    return forge.pki.rsa.generateKeyPair(2048);
}

function buildCert(name, keyPair, signerKey, isCA, caAttrs) {
    const cert = forge.pki.createCertificate();
    cert.publicKey = keyPair.publicKey;
    cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(16)).slice(0, 32);

    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + (isCA ? 10 : 2));

    const attrs = [
        { name: 'commonName', value: name },
        { name: 'organizationName', value: 'PhoneCam Pro' },
        { name: 'countryName', value: 'US' }
    ];
    cert.setSubject(attrs);
    cert.setIssuer(isCA ? attrs : caAttrs);

    if (isCA) {
        cert.setExtensions([
            { name: 'basicConstraints', cA: true },
            { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true },
            { name: 'subjectKeyIdentifier' }
        ]);
    } else {
        cert.setExtensions([
            {
                name: 'basicConstraints',
                cA: false
            },
            {
                name: 'keyUsage',
                digitalSignature: true,
                keyEncipherment: true
            },
            {
                name: 'extKeyUsage',
                serverAuth: true
            },
            {
                name: 'subjectAltName',
                altNames: [
                    { type: 2, value: 'localhost' },
                    { type: 7, ip: '127.0.0.1' },
                    { type: 7, ip: LOCAL_IP }
                ]
            },
            { name: 'subjectKeyIdentifier' }
        ]);
    }

    cert.sign(signerKey || keyPair.privateKey, forge.md.sha256.create());
    return cert;
}

if (!fs.existsSync(certDir)) {
    fs.mkdirSync(certDir, { recursive: true });
}

const LOCAL_IP = getLocalIP();
console.log('🔐 Generando CA + certificado firmado...');
console.log(`   IP detectada: ${LOCAL_IP}`);

// ─── 1. Create the Certificate Authority ──────────────────────
const caKeys = createKeyPair();
const caCert = buildCert('PhoneCam Pro Root CA', caKeys, null, true);

// ─── 2. Create a server certificate signed by the CA ─────────
const serverKeys = createKeyPair();
const serverCert = buildCert('PhoneCam Pro Server', serverKeys, caKeys.privateKey, false, caCert.subject.attributes);

const caPem = forge.pki.certificateToPem(caCert);
const serverPem = forge.pki.certificateToPem(serverCert);
const serverKeyPem = forge.pki.privateKeyToPem(serverKeys.privateKey);

fs.writeFileSync(path.join(certDir, 'ca.crt'), caPem);
fs.writeFileSync(path.join(certDir, 'ca.key'), forge.pki.privateKeyToPem(caKeys.privateKey));
fs.writeFileSync(path.join(certDir, 'server.cert'), serverPem);
fs.writeFileSync(path.join(certDir, 'server.key'), serverKeyPem);

console.log('✅ Certificados generados:');
console.log(`   CA:         ${path.join(certDir, 'ca.crt')}`);
console.log(`   Servidor:   ${path.join(certDir, 'server.cert')}`);
console.log(`   Clave:      ${path.join(certDir, 'server.key')}`);

// ─── 3. Build the iOS .mobileconfig profile ───────────────────
// The CA certificate (DER/base64) embedded in a CertificatePayload so the
// iPhone can install and trust it.
const derBytes = forge.asn1.toDer(forge.pki.certificateToAsn1(caCert)).getBytes();
const derB64 = Buffer.from(derBytes, 'binary').toString('base64');

const ipHex = LOCAL_IP.replace(/\./g, '').padEnd(12, '0').slice(0, 12).toUpperCase();
const payloadUUID = '3C5F9A2E-8B44-4D1A-9C3E-' + ipHex;
const profileUUID = '8D7E4B21-6F93-4C2A-B8E5-' + ipHex.split('').reverse().join('');

const profile = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>PayloadContent</key>
    <array>
        <dict>
            <key>PayloadCertificateFileName</key>
            <string>PhoneCamPro-CA.crt</string>
            <key>PayloadContent</key>
            <data>${derB64}</data>
            <key>PayloadDescription</key>
            <string>Confia en el servidor local de PhoneCam Pro</string>
            <key>PayloadDisplayName</key>
            <string>PhoneCam Pro Root CA</string>
            <key>PayloadIdentifier</key>
            <string>com.phonecam.pro.ca</string>
            <key>PayloadType</key>
            <string>com.apple.security.root</string>
            <key>PayloadUUID</key>
            <string>${payloadUUID}</string>
            <key>PayloadVersion</key>
            <integer>1</integer>
        </dict>
    </array>
    <key>PayloadDescription</key>
    <string>Certificado raiz de PhoneCam Pro para usar tu iPhone como webcam en tu red local.</string>
    <key>PayloadDisplayName</key>
    <string>PhoneCam Pro - Confianza de red local</string>
    <key>PayloadIdentifier</key>
    <string>com.phonecam.pro.profile</string>
    <key>PayloadRemovalDisallowed</key>
    <false/>
    <key>PayloadType</key>
    <string>Configuration</string>
    <key>PayloadUUID</key>
    <string>${profileUUID}</string>
    <key>PayloadVersion</key>
    <integer>1</integer>
</dict>
</plist>`;

const profilePath = path.join(projectDir, 'PhoneCamPro-Trust.mobileconfig');
fs.writeFileSync(profilePath, profile);
console.log('✅ Perfil iOS creado:');
console.log(`   ${profilePath}`);
console.log('');
console.log('📲 Instalacion en el iPhone:');
console.log(`1. Abre ${profilePath} en tu iPhone`);
console.log('   (sube el archivo a iCloud Drive, o envialo por AirDrop/WhatsApp)');
console.log('2. Ajustes > General > Gestion de VPN y dispositivos > Instalar perfil');
console.log('3. Ajustes > General > Informacion > Ajustes de confianza de certificados');
console.log('   > Activa "PhoneCam Pro Root CA"');
console.log('4. Listo. La camara funcionara en Safari y en la app nativa.');
console.log('');