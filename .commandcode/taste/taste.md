# Taste (Continuously Learned by [CommandCode][cmd])

[cmd]: https://commandcode.ai/

# communication
- User communicates in Indonesian; respond in Indonesian when user does. Confidence: 0.80

# ui-styling
- Use soft white backgrounds (bg-white/[0.06], bg-white/[0.04]) with rounded-md instead of blue accent backgrounds for selected/hover states in popover/menu items. Confidence: 0.70
- For model selector list item rows: order elements as [Name · summary] [detail] [Edit button] [✓ Check]. Edit button and check are both on the right side, with Edit before Check. Confidence: 0.65

# ui-patterns
- For select-style options (e.g., reasoning effort), use a vertical list with check icons on selected items, not horizontal chip/pill buttons. Label on top, options stacked below, text left-aligned with the label. Confidence: 0.70
- For hover-reveal buttons inside list rows, use `opacity-0` + `group-hover:opacity-100` with fixed height (`h-4 inline-flex items-center`) instead of `hidden` + `group-hover:inline-block` to prevent row height changes. Confidence: 0.75
- When a popover grows (e.g., editor side panel opens), keep the base panel position anchored — use the base width (without the side panel) for viewport clamping so the original panel doesn't shift. Confidence: 0.75

