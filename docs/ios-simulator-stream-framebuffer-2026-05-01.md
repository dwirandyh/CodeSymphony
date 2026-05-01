# iOS Simulator Stream Measurement

Note: this document reflects the earlier `framebuffer + jpeg` iteration before the final `framebuffer + h264` tuning pass. For the current active-path runtime measurement, see [ios-simulator-stream-active-h264-2026-05-01.md](/Users/dwirandyh/Work/Personal/codesymphony/docs/ios-simulator-stream-active-h264-2026-05-01.md:1).

Date: 2026-05-01
Generated at: 2026-05-01T02:04:26.051Z

## Environment

| Field | Value |
| --- | --- |
| Runtime base URL | `http://127.0.0.1:4331` |
| Active session | `817ab850-6802-407f-af86-0fffe890ab1c` |
| Device | `iPhone 17 Pro` |
| UDID | `4F8060B7-142F-4628-880D-FF1A74C20B91` |
| Simulator runtime | `com.apple.CoreSimulator.SimRuntime.iOS-26-1` |
| Current stream path | `Direct framebuffer -> IOSurface -> JPEG` |
| Host Screen Recording permission | Not required |
| Host system audio capture | Disabled |

## Capture Geometry

| Metric | Value |
| --- | ---: |
| Logical device size | `402 x 874` pt |
| Current capture size | `402 x 874` px |
| Width ratio vs logical size | `1x` |
| Height ratio vs logical size | `1x` |

Interpretation:

- The current framebuffer path is no longer window-size dependent.
- The important apples-to-apples comparison is:
  - matched output resolution to the baseline `323 x 703` px ScreenCaptureKit capture
  - logical-size framebuffer output at `402 x 874` px

## Measured Result

| Dimension | Result |
| --- | ---: |
| First frame | `61.2ms` |
| First frame age | `212ms` |
| First frame decode latency | `2ms` |
| First frame transport age | `210ms` |
| Warm steady-state FPS | `2.7` |
| Warm avg frame interval | `372ms` |
| Warm avg frame age | `14ms` |
| Warm avg decode latency | `2.8ms` |
| Warm avg transport age | `11.2ms` |
| Control-to-next-frame latency | `n/a` |
| Max measured control-to-next-frame | `n/a` |
| Bridge CPU (10 x 1000ms) | avg `1.03%`, min `0.3%`, max `2%` |
| Bridge RSS (10 x 1000ms) | avg `47.6 MiB`, min `46.1 MiB`, max `47.7 MiB` |

## Comparison Matrix For Framebuffer Migration

| Dimension | Why it matters | Current baseline | Framebuffer target |
| --- | --- | ---: | --- |
| Host privacy friction | This is the main product reason to migrate | Screen Recording permission required | No Screen Recording prompt |
| Startup to first frame | Determines perceived stream startup | `61.2ms` | Not slower than `+10%` at matched resolution |
| Warm steady-state FPS | Captures smoothness under idle/normal interaction | `2.7` | Same or higher |
| Avg frame age | Proxy for end-to-end freshness | `14ms` | Same or lower |
| Avg decode latency | Keeps viewer-side decode overhead visible | `2.8ms` | Same or lower |
| Control-to-next-frame | Closest current proxy to interaction responsiveness | `n/a` max | `<= 15ms` at matched resolution |
| Bridge CPU | Prevents “permission-free but much heavier” regressions | `1.03%` avg | Same or lower at matched resolution |
| Bridge RSS | Prevents persistent process bloat | `47.6 MiB` avg | Same or lower |
| Output resolution policy | Prevents invalid apples-to-oranges comparisons | `402 x 874` px | Run both matched-resolution and native-resolution modes |

## Notes

- This measurement is running on the direct framebuffer path. Compare it against [docs/ios-simulator-stream-baseline-2026-05-01.md](/Users/dwirandyh/Work/Personal/codesymphony/docs/ios-simulator-stream-baseline-2026-05-01.md:1) for the ScreenCaptureKit baseline.
- The warm-path baseline should be compared against the framebuffer warm path. Do not compare framebuffer steady-state numbers against the current startup outliers (`maxFrameAgeMs`, `maxFrameIntervalMs`) from the initial connection phase.
- The current path does not capture host/system audio. If the framebuffer path also skips audio, then audio permission is not part of the migration acceptance criteria.
- Latest metrics session used: `817ab850-6802-407f-af86-0fffe890ab1c`.
