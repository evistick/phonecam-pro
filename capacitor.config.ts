import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.phonecam.pro',
  appName: 'PhoneCam Pro',
  webDir: 'public/native',
  backgroundColor: '#0a0a1a',
  ios: {
    contentInset: 'always',
    allowsLinkPreview: false,
    preferredContentMode: 'mobile'
  }
};

export default config;