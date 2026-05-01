# iOS Simulator Stream Comparison

Date: 2026-05-01

Compared documents:

- [ScreenCaptureKit baseline](/Users/dwirandyh/Work/Personal/codesymphony/docs/ios-simulator-stream-baseline-2026-05-01.md:1)
- [Direct framebuffer measurement](/Users/dwirandyh/Work/Personal/codesymphony/docs/ios-simulator-stream-framebuffer-2026-05-01.md:1)
- [Browser tuning follow-up](/Users/dwirandyh/Work/Personal/codesymphony/docs/ios-simulator-stream-browser-tuning-2026-05-01.md:1)

## Headline

The direct framebuffer path is viable and removes the macOS Screen Recording permission requirement.

It materially improves startup latency and bridge CPU usage, while trading away high idle-frame cadence because the new path is event-driven with a low refresh floor instead of a continuous 60 fps capture loop.

## Metric Delta

| Dimension | ScreenCaptureKit baseline | Direct framebuffer | Delta / interpretation |
| --- | ---: | ---: | --- |
| Host Screen Recording permission | Required | Not required | Main product win |
| Capture dependency on simulator window size | Yes | No | Main technical win |
| First frame | `825.6ms` | `61.2ms` | Much faster startup |
| Warm steady-state FPS | `56.5` | `2.7` | Not apples-to-apples; framebuffer path is event-driven while idle |
| Avg frame age | `5.3ms` | `14ms` | Higher, but still low |
| Avg decode latency | `1.2ms` | `2.8ms` | Higher, but still low |
| Bridge CPU avg | `14.49%` | `1.03%` | Major efficiency improvement |
| Bridge RSS avg | `21 MiB` | `47.6 MiB` | Higher memory footprint |
| Output resolution | `323 x 703` px | `402 x 874` px | Framebuffer path is currently sharper than baseline |

## Active Stream Notes

Additional packet-level measurement for the current framebuffer + H.264 runtime path is saved in:

- [Active H.264 packet measurement](/Users/dwirandyh/Work/Personal/codesymphony/docs/ios-simulator-stream-active-h264-2026-05-01.md:1)

Headline from that run:

- Active runtime cadence during repeated `app_switcher <-> swipe_home` gestures: about `26.69 fps`
- Stream resolution during that run: `402 x 874`
- Approx payload bitrate during that run: `13.02 Mbps`

Important nuance:

- Raw native JPEG packet cadence can be higher than H.264 in isolated bridge tests.
- Browser-side follow-up tuning showed that the theoretical H.264 advantage did not materialize in this app's real viewer path.
- The practical browser default should be chosen by end-to-end responsiveness, not by native packet cadence alone.

## Decision

The framebuffer path is the better default if the priority is:

- removing Screen Recording permission friction
- making startup feel immediate
- avoiding window-size-dependent capture behavior
- reducing continuous bridge CPU load

The remaining tradeoffs are acceptable for now, but still worth follow-up tuning:

- idle refresh cadence is low by design, so static scenes do not report high FPS
- memory usage is higher than the old path
- we still need a matched-resolution comparison run at roughly `323 x 703` px for a strict apples-to-apples quality/perf pass
- the current measurement did not capture viewer-side `control_to_next_frame` samples on the framebuffer path

## Recommendation

Keep direct framebuffer as the preferred iOS simulator capture path, retain `ScreenCaptureKit` as fallback, and use JPEG as the default browser codec for now.

H.264 should stay behind an explicit override until the browser decode path is proven to be lower-latency than JPEG in real user interaction.
