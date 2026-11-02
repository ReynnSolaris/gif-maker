# GIF Maker for Videos (Brave / Chrome extension)

Hover any `<video>` on a page (Instagram, Reddit, Twitter/X, news sites, local files…), click the
**GIF** button that appears in its corner, pick a start/end range on a thumbnail timeline, choose
FPS and size, preview the real GIF, and save it.

## Install (unpacked)

1. Open `brave://extensions` (or `chrome://extensions`).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder (the one containing `manifest.json`).
4. Reload any tabs that were already open.

## Install (packed)

`dist/gif-maker-<version>.crx` is the signed, packed build. Drag it onto `chrome://extensions`
(Developer mode on) to install it. `dist/gif-maker-<version>.zip` is the same files, ready for the
Chrome Web Store upload. Rebuild both with `powershell -File .\pack.ps1`.
`gif-maker.pem` is the signing key: keep it private (it is git-ignored) so the extension ID stays
the same across versions.

## Use

- **Hover a video** → a small `GIF` pill shows up top-right of the video (like IDM's download bar).
  Click it to open the editor.
- **Right-click a video** → "Make GIF from this video" (works even when the hover button is hidden).
- **Toolbar popup** → switch the hover button on/off, set default FPS / size / dithering, and choose
  whether to be asked where to save. `Alt+Shift+G` toggles the button too.

In the editor:

| Control | What it does |
| --- | --- |
| Timeline | Thumbnail strip of the whole video. Drag the pink handles for **start** and **end**, drag the top edge of the range to move it, click anywhere to peek at that frame. |
| Start / End | Exact times in seconds. |
| FPS | 1–50. More frames = smoother and bigger. |
| Size | 160 / 240 / 320 / 480 / 640 px wide, original, or a custom width (height follows the aspect ratio). |
| Dither | Floyd–Steinberg dithering for smoother gradients (bigger file). |
| Smaller file | Stores only the pixels that change between frames. |
| Loop range on page | Plays the selected range on the page's own player so you can judge the cut. |
| ▶ Play / Pause | Captures the range once and loops it in the preview at the chosen FPS, before you encode anything. Pause freezes on the current frame. |
| Make GIF | Encodes while frames are still being captured (or instantly if Play already captured them) and shows the **actual** GIF in the preview with its file size. |
| Save GIF | Downloads it (uses the page title + range as the file name). |

The panel is draggable by its header; `Esc` closes it.

## How it works

- `content.js` runs on every page, finds the video under the pointer, shows the button, and captures
  frames by seeking the page's own `<video>` and drawing it to a canvas.
- The editor (`editor.html`) is an extension iframe; frames are streamed to it over a `MessageChannel`
  (transferred buffers, no copies).
- `gif-worker.js` is a self-contained GIF89a encoder (median-cut palette per frame, optional
  dithering, LZW, frame differencing). No third-party code.
- If a site serves the video cross-origin without CORS (so the canvas is "tainted"), the editor fetches
  the file itself with the extension's host permission and captures from that copy. Sites that stream
  via MSE blobs *and* taint the canvas cannot be captured.

## Limits

- Up to 600 frames per GIF and ~160 M pixels in memory. Lower the FPS, size or length if you hit them.
- GIF timing is in 1/100 s, so very high FPS values are approximated.
- DRM-protected video (Netflix etc.) cannot be captured by any extension.

## Local test

`node test/server.js` then open `http://localhost:8787/test/harness.html`. That page loads
`content.js` with a stubbed `chrome` object so the whole flow can be exercised without installing
the extension. `node test/encode-test.js` round-trips the encoder through ffmpeg.
