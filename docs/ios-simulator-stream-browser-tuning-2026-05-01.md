# iOS Simulator Browser Stream Tuning

Date: 2026-05-01

Related documents:

- [Framebuffer vs ScreenCaptureKit comparison](/Users/dwirandyh/Work/Personal/codesymphony/docs/ios-simulator-stream-comparison-2026-05-01.md:1)
- [Active H.264 packet measurement](/Users/dwirandyh/Work/Personal/codesymphony/docs/ios-simulator-stream-active-h264-2026-05-01.md:1)
- [Active JPEG packet measurement](/Users/dwirandyh/Work/Personal/codesymphony/docs/ios-simulator-stream-active-jpeg-2026-05-01.md:1)

## Why This Pass Was Needed

Direct framebuffer capture already removed the Screen Recording permission requirement, but the browser stream still felt delayed and choppy.

The root cause was not native capture anymore. It was the browser path:

- native H.264 packets were arriving quickly
- browser-side H.264 decode was producing multi-second `frameAgeMs`
- the viewer was trying to render every decoded frame immediately instead of prioritizing the newest one

## Changes Applied

### 1. Browser viewer now renders latest-frame-first

`IosSimulatorViewer.tsx` now queues decoded frames and only paints the freshest frame on the next animation frame.

This removes viewer-side render backlog and keeps the canvas closer to the current simulator state instead of replaying stale frames.

### 2. Framebuffer automatic codec now prefers JPEG

`SimulatorBridge` automatic mode now defaults to `jpeg` instead of `h264`.

This matches the practical behavior of `serve-sim`, which also uses framebuffer capture with MJPEG/JPEG for the browser path.

### 3. JPEG quality was tuned down for live preview

The JPEG encoder now targets a more realistic quality range for an interactive simulator preview instead of near-lossless values.

That reduces per-frame payload cost while keeping the image acceptably sharp at the current `402 x 874` logical stream size.

## Result

### Previous browser behavior with framebuffer + H.264

Observed from session `2bf4b691-31ce-42c3-b700-ace08ff68042`:

- viewer `avgFrameAgeMs`: about `1.6s`
- viewer `avgFrameDecodeLatencyMs`: about `1.6s`
- viewer `approxFps`: about `8.7`
- worst startup frames were more than `11s` stale because the browser was painting old frames long after they were captured

### New native behavior with framebuffer + JPEG

Measured in [active JPEG packet measurement](/Users/dwirandyh/Work/Personal/codesymphony/docs/ios-simulator-stream-active-jpeg-2026-05-01.md:1):

- native active cadence: about `37.65 fps`
- avg frame payload: about `69 KiB`
- bitrate during repeated `app_switcher <-> swipe_home`: about `21.32 Mbps`

### New browser behavior with framebuffer + JPEG

Observed from session `04950adf-c353-40e5-8978-8411db0eb604`:

- first frame after fresh connect: about `73.8ms` to `76.5ms`
- steady interactive `frameAgeMs`: usually about `8ms` to `25ms`
- steady interactive `frameDecodeLatencyMs`: usually about `2ms` to `15ms`
- active viewer `approxFps`: up to about `14.1`
- `control_to_next_frame`: typically `19ms` to `52ms`
- worst `control_to_next_frame` seen in this run: `103.8ms`

## Interpretation

This tuning pass materially improved responsiveness.

The browser no longer trails the simulator by seconds. It now tracks within tens of milliseconds, which is the threshold that matters most for gesture feedback and perceived sync.

The remaining gap is throughput, not latency:

- native JPEG packet production can exceed `37 fps`
- the browser path in this app currently lands closer to `10-14 fps` during active interaction

So the main remaining opportunity is further viewer throughput optimization, not another capture-stack rewrite.

## Current Recommendation

For the iOS simulator web viewer in this repository:

- keep direct framebuffer capture as the default capture path
- keep JPEG as the default browser codec
- keep H.264 available only as an explicit override for further experiments

At this point, JPEG is the better product default because it is substantially more realtime in the browser while still avoiding Screen Recording permissions.
