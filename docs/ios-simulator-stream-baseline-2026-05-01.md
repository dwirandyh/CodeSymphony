# iOS Simulator Stream Baseline

Date: 2026-05-01
Generated at: 2026-05-01T01:32:59.841Z

## Environment

| Field | Value |
| --- | --- |
| Runtime base URL | `http://127.0.0.1:4331` |
| Active session | `aee20d85-aead-4a3d-9efa-78c714412436` |
| Device | `iPhone 17 Pro` |
| UDID | `4F8060B7-142F-4628-880D-FF1A74C20B91` |
| Simulator runtime | `com.apple.CoreSimulator.SimRuntime.iOS-26-1` |
| Current stream path | `ScreenCaptureKit -> SCStream` |
| Host Screen Recording permission | Required |
| Host system audio capture | Disabled (`capturesAudio = false`) |

## Capture Geometry

| Metric | Value |
| --- | ---: |
| Logical device size | `402 x 874` pt |
| Current capture size | `323 x 703` px |
| Width ratio vs logical size | `0.8x` |
| Height ratio vs logical size | `0.8x` |

Interpretation:

- The current ScreenCaptureKit baseline is window-size dependent.
- A framebuffer migration must be compared in two modes:
  - matched output resolution to the current `323 x 703` px baseline
  - native framebuffer resolution, measured separately

## Measured Baseline

| Dimension | Baseline |
| --- | ---: |
| First frame | `825.6ms` |
| First frame age | `18ms` |
| First frame decode latency | `2ms` |
| First frame transport age | `16ms` |
| Warm steady-state FPS | `56.5` |
| Warm avg frame interval | `17.7ms` |
| Warm avg frame age | `5.3ms` |
| Warm avg decode latency | `1.2ms` |
| Warm avg transport age | `4.1ms` |
| Control-to-next-frame latency | `13.3ms, 2.5ms` |
| Max measured control-to-next-frame | `13.3ms` |
| Bridge CPU (10 x 1000ms) | avg `14.49%`, min `12.6%`, max `15.8%` |
| Bridge RSS (10 x 1000ms) | avg `21 MiB`, min `20.9 MiB`, max `21 MiB` |

## Comparison Matrix For Framebuffer Migration

| Dimension | Why it matters | Current baseline | Framebuffer target |
| --- | --- | ---: | --- |
| Host privacy friction | This is the main product reason to migrate | Screen Recording permission required | No Screen Recording prompt |
| Startup to first frame | Determines perceived stream startup | `825.6ms` | Not slower than `+10%` at matched resolution |
| Warm steady-state FPS | Captures smoothness under idle/normal interaction | `56.5` | Same or higher |
| Avg frame age | Proxy for end-to-end freshness | `5.3ms` | Same or lower |
| Avg decode latency | Keeps viewer-side decode overhead visible | `1.2ms` | Same or lower |
| Control-to-next-frame | Closest current proxy to interaction responsiveness | `13.3ms` max | `<= 15ms` at matched resolution |
| Bridge CPU | Prevents “permission-free but much heavier” regressions | `14.49%` avg | Same or lower at matched resolution |
| Bridge RSS | Prevents persistent process bloat | `21 MiB` avg | Same or lower |
| Output resolution policy | Prevents invalid apples-to-oranges comparisons | `323 x 703` px | Run both matched-resolution and native-resolution modes |

## Notes

- The warm-path baseline should be compared against the framebuffer warm path. Do not compare framebuffer steady-state numbers against the current startup outliers (`maxFrameAgeMs`, `maxFrameIntervalMs`) from the initial connection phase.
- The current path does not capture host/system audio. If the framebuffer path also skips audio, then audio permission is not part of the migration acceptance criteria.
- Latest metrics session used: `aee20d85-aead-4a3d-9efa-78c714412436`.
