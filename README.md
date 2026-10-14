# AndacCatcher

**AndacCatcher** is an experimental video-downloading project for Windows, combining a Chrome extension with a Rust native messaging host and FFmpeg.

It detects supported media on web pages and provides a workflow for selecting HLS quality, downloading videos, and managing download history. It is intended for videos you own or are authorized to download; it does not bypass DRM or access restrictions.

> **Project status:** Active development (v1.5.3). The current release is a developer setup, not a one-click installer. Some features depend on the website and the media source.

## Features

- Detects supported video elements and media requests in Chrome
- HLS (`.m3u8`) quality selection where variant information is available
- HLS-to-MP4 downloads using FFmpeg through a Rust native host
- Download progress, cancellation, and experimental pause/resume on Windows
- Configurable concurrent HLS downloads (1–3), with a reorderable queue
- Persistent download history, search, status filters, and removal of individual history entries
- Open a completed download or reveal it in File Explorer
- Direct-download handling for some non-HLS video URLs via Chrome

**Known limitations:** Not all websites expose a usable media URL. DRM-protected media is not supported. Certain streams may reject FFmpeg requests (for example, HTTP 403). Pause/resume does not persist across browser or computer restarts. Source matching on complex embedded players is still under development.

## Technology stack

| Component | Technology |
| --- | --- |
| Browser extension | JavaScript, HTML, CSS, Chrome Manifest V3 |
| Native host | Rust |
| Media processing | FFmpeg / FFprobe |
| Browser-to-desktop communication | Chrome Native Messaging |
| Supported development environment | Windows |

## Repository structure

```text
AndacCatcher/
├── extension/
│   ├── manifest.json
│   ├── background.js
│   ├── content.js
│   ├── content.css
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
└── desktop/
    ├── Cargo.toml
    ├── Cargo.lock
    └── src/
        ├── main.rs
        └── hls.rs
```

## Requirements

- Windows
- Google Chrome
- [Rust and Cargo](https://rustup.rs/)
- [FFmpeg](https://ffmpeg.org/download.html), including `ffmpeg` and `ffprobe`, available on `PATH`

## Development setup

### 1. Clone the repository

```powershell
git clone https://github.com/EmreAndac/AndacCatcher.git
cd AndacCatcher
```

### 2. Build the Rust native host

```powershell
cd desktop
cargo build --release
cd ..
```

The executable will be built under `desktop\target\release\`.

### 3. Load the Chrome extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked** and choose the `extension` folder.
4. Copy the extension ID shown by Chrome.

### 4. Configure Native Messaging

The extension communicates with a locally registered Chrome Native Messaging host. The current host name in the project is:

```text
com.videocatcher.downloader
```

Create a local native-host manifest that points to the **absolute path** of the compiled executable and permits your extension ID. For Chrome on Windows, register the manifest path under the corresponding `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.videocatcher.downloader` registry key.

Example manifest (**replace both placeholders with your own values**):

```json
{
  "name": "com.videocatcher.downloader",
  "description": "AndacCatcher native messaging host",
  "path": "C:\\ABSOLUTE\\PATH\\TO\\AndacCatcher\\desktop\\target\\release\\video_downloader.exe",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://YOUR_EXTENSION_ID/"
  ]
}
```

> The executable name above reflects the current development build. Confirm the actual executable name in `desktop\target\release`. Do not commit your machine-specific manifest or credentials. Keep the existing native host identifier unchanged unless you also update the extension and Windows registration.

### 5. Reload and test

1. Reload the extension on `chrome://extensions`.
2. Refresh a page containing a supported, authorized test video.
3. Click **Download Video**, choose a quality (if offered), and start the download.
4. Check the extension popup for progress and history.

For local HTML test pages, enable **Allow access to file URLs** in the extension details.

## Planned improvements

- Improve per-video source matching for embedded and dynamically generated players
- Improve quality panel positioning and ensure only one panel is open at a time
- Refine error reporting for unavailable or unauthorized streams
- Package a simpler Windows installation process
- Performance testing and further download optimizations

## Responsible use

Only download content when you have the rights or permission to do so. Respect copyright, website terms, and applicable law. AndacCatcher does not provide DRM circumvention.

## License

No license has been selected yet. Until a license is added, the repository's public visibility does **not** automatically grant others permission to redistribute or modify the code.
