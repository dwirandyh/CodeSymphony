# iOS Simulator Direct-Image Grind

Date: 2026-05-01

Related documents:

- [Browser tuning baseline](/Users/dwirandyh/Work/Personal/codesymphony/docs/ios-simulator-stream-browser-tuning-2026-05-01.md:1)
- [Native packet measurement: direct-image immediate](/Users/dwirandyh/Work/Personal/codesymphony/docs/ios-simulator-stream-active-jpeg-direct-image-immediate-2026-05-01.md:1)
- [Native packet measurement: direct-image initial](/Users/dwirandyh/Work/Personal/codesymphony/docs/ios-simulator-stream-active-jpeg-direct-image-2026-05-01.md:1)
- [Native packet measurement: scale 0.85 experiment](/Users/dwirandyh/Work/Personal/codesymphony/docs/ios-simulator-stream-active-jpeg-scale-085-2026-05-01.md:1)
- [Native packet measurement: adaptive JPEG experiment](/Users/dwirandyh/Work/Personal/codesymphony/docs/ios-simulator-stream-active-jpeg-direct-image-adaptive-2026-05-01.md:1)

## Best Current Configuration

Keep this as the product default for now:

- capture path: direct framebuffer
- codec: JPEG
- stream scale: `1.0`
- viewer presentation path: direct `<img>` updates with latest-frame-wins, without the extra `requestAnimationFrame` scheduling step

## Best Result Kept

From session `410660ba-cbf6-497f-8caf-0b39db9c5bf7`:

- native active cadence reached about `45.49 fps`
- native avg frame payload dropped to about `66.4 KiB`
- native bitrate during repeated `app_switcher <-> swipe_home` was about `24.75 Mbps`

Browser-side for the same direct-image-immediate pass:

- cumulative viewer summaries climbed into the `32.6 - 32.7 fps` range during the active run
- windowed active viewer cadence was about `38.6 fps`, inferred from summary deltas for the same viewer instance:
  - `300 frames @ 20.27s`
  - `1465 frames @ 50.46s`
- steady frame age stayed around `10 - 11 ms`
- steady decode latency stayed around `3 - 4 ms`
- direct-image backpressure dropped from triple-digit counts in the previous queueing model to low single digits in the kept immediate-presentation path

## What Improved

The important product change was not another capture-stack rewrite. It was removing the extra browser scheduling layer after switching to the direct-image path.

Before this pass:

- direct framebuffer + JPEG already solved the multi-second lag
- but the viewer still dropped too much throughput in the browser

After this pass:

- the browser now tracks the simulator much more closely during fast motion
- the remaining gap to perfect `60 fps` is mostly native JPEG throughput and browser decode cost, not websocket transport latency

## Rejected Experiments

### 1. Motion-adaptive JPEG for framebuffer frames

This did not outperform the simpler direct-image-immediate path.

- native active cadence: about `44.9 fps`
- native avg payload: about `69.9 KiB`
- result: no meaningful FPS gain, payload got larger, so this was not kept

### 2. Default framebuffer scale `0.85`

This reduced resolution to `342 x 743`, but it was not a net win.

- native active cadence: about `43.76 fps`
- native avg payload: about `55 KiB`
- browser summaries stayed materially below the kept full-scale direct-image result
- result: quality dropped more than performance improved, so this was reverted

## Current Conclusion

At the current full-scale stream resolution, the best measured path is:

- direct framebuffer capture
- JPEG transport
- direct-image immediate browser presentation

This is materially better than the earlier canvas-backed JPEG path and far better than the old H.264 browser path.

It still does not hit a true sustained `60 fps` in the web app at full quality, but it does get substantially closer while keeping:

- no Screen Recording permission requirement
- low frame age
- acceptable visual quality

The next step, if `60 fps` remains mandatory, is not another viewer refactor first. It is a product tradeoff decision:

- lower live-preview resolution further
- lower motion-frame JPEG quality more aggressively
- or move away from full-JPEG-per-frame transport for the browser path

## Flicker Iteration

Latest browser-side iteration on 2026-05-01 focused on the remaining "kedip" complaint in the direct-image path.

What changed:

- kept the double-buffered `<img>` presentation path
- stopped clearing the previously visible image slot immediately after the visibility swap
- waited for `image.decode()` before committing the new slot visible
- added lightweight viewer mount/connect debug markers so duplicate clients can be distinguished cleanly

Why this mattered:

- the previous implementation could still revoke the old blob URL in the same task as the slot swap
- if the browser had not painted the new slot yet, that could produce a momentary blank flash even though two image elements existed

What was validated:

- `ios.viewer` logs now show distinct viewer instance ids, which confirmed the earlier duplicate connections came from multiple browser clients (`127.0.0.1` and `localhost`), not from two mounts inside one page
- automated recent-app validation produced five consecutive screenshots without an obvious blank frame during the transition
- `control_to_next_frame` for the recent-app action measured about `20.6 ms` in the instrumented browser session

Current read:

- the direct-image path still is not a sustained `60 fps` browser path
- but the specific blank-frame flicker risk from immediate old-slot teardown is now removed from the viewer implementation
