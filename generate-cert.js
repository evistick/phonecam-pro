/**
 * generate-cert.js
 * Generates self-signed SSL certificates for HTTPS
 * Required because getUserMedia needs a secure context on mobile devices
 */

const selfsigned = require('selfsigned');
const fs = require('fs');
const path = require('path');

const certDir = path.join(__dirname, 'certs');

if (!fs.existsSync(certDir)) {
    fs.mkdirSync(certDir, { recursive: true });
}

console.log('🔐 Generating self-signed SSL certificates...');

const attrs = [
    { name: 'commonName', value: 'PhoneCam Pro' },
    { name: 'organizationName', value: 'PhoneCam Pro' }
];

const opts = {
    keySize: 2048,
    days: 365,
    algorithm: 'sha256',
    extensions: [
        {
            name: 'subjectAltName',
            altNames: [
                { type: 2, value: 'localhost' },
                { type: 7, ip: '127.0.0.1' }
            ]
        }
    ]
};

const pems = selfsigned.generate(attrs, opts);

fs.writeFileSync(path.join(certDir, 'server.key'), pems.private);
fs.writeFileSync(path.join(certDir, 'server.cert'), pems.cert);

console.log('✅ Certificates generated successfully!');
console.log(`   📁 Key:  ${path.join(certDir, 'server.key')}`);
console.log(`   📁 Cert: ${path.join(certDir, 'server.cert')}`);
