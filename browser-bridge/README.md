# Optional video bridge

Use this for switching between concurrent video tabs and Music, or when your browser does not supply Mac Now Playing metadata. The extension is limited to YouTube, X and Twitter.

1. Open your browser’s extensions page, enable developer mode, and load this `browser-bridge/` folder unpacked.
2. Register the native host using the **existing browser profile parent** that contains `NativeMessagingHosts`:

   ```sh
   ./scripts/install-browser-bridge.sh "/absolute/browser/profile-parent"
   ```

3. Keep Car Thing running and reload the video page.

The fixed extension ID comes from its bundled public key. No pairing token enters the extension. Native messaging and controls have fixture coverage; live X playback is unverified. Thumbnails depend on the site’s image and cross-origin access. Safari and Firefox are not supported by this extension.
