import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.local.onepagereader',
  appName: '一页',
  webDir: 'dist',
  android: {
    allowMixedContent: false,
    backgroundColor: '#f5f0e7',
  },
  plugins: {
    // Capacitor 8 otherwise adds physical padding around the WebView on
    // older Android System WebView versions. This app handles the system-bar
    // safe areas in CSS so the page background can extend edge to edge.
    SystemBars: {
      insetsHandling: 'disable',
    },
    StatusBar: {
      overlaysWebView: true,
    },
  },
}

export default config
