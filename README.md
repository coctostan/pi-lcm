# pi-lcm

## What It Does

Long coding sessions accumulate context noise: tool results from hours ago inflate the context window without helping the model. pi-lcm strips tool results older than `freshTailCount` turns and makes them retrievable on demand via the `lcm_expand` tool, keeping the active context lean without losing any information. Sessions shorter than `freshTailCount` turns see zero behavioral difference from vanilla pi.

---

## How It Works

```
context event fires
  │
  ├─ strippedCount == 0 AND below contextThreshold?
  │    └─ return unchanged (zero cost)
  │
  └─ above contextThreshold OR entries already stripped?
       ├─ strip old tool results (replace with placeholder)
       ├─ register lcm_expand tool
       └─ pass curated context to LLM
```

---

## Install

```bash
pi install git:github.com/your-org/pi-lcm
```

Then enable the extension in pi settings (`~/.pi/agent/settings.json`):

```json
{
  "packages": ["git:github.com/your-org/pi-lcm"]
}
```

Restart pi to apply.

---

## Configuration

| Field | Default | Description |
|---|---|---|
| `freshTailCount` | `32` | Number of most-recent turns treated as "fresh" — never stripped |
| `maxExpandTokens` | `4000` | Token budget returned by a single `lcm_expand` call |
| `contextThreshold` | `0.75` | Context usage fraction (0–1) at which stripping activates |

Config file path: `~/.pi/agent/extensions/pi-lcm.config.json`

Example — tighten the threshold and reduce expand budget:

```json
{
  "contextThreshold": 0.65,
  "maxExpandTokens": 2000
}
```

---

## Tools

### `lcm_expand(id)`

Retrieves the full content of a stripped tool result. When an entry is stripped, the model sees a placeholder like:

```
[Content available via lcm_expand("abc123")]
```

The model calls `lcm_expand("abc123")` to fetch the original content, up to `maxExpandTokens` tokens.

`lcm_expand` is **only registered when at least one entry has been stripped** — it does not appear in the tool list for short, unaffected sessions.

---

## Status Bar

The status bar is **hidden when no entries have been stripped**.

When entries have been stripped but context usage data is unavailable:

```
🟢 3 stripped | tail: 32
```

When context usage data is available, a usage percentage and icon are shown:

```
🟢 42% | 3 stripped | tail: 32   ← below 60%
🟡 72% | 3 stripped | tail: 32   ← 60–84%
🔴 91% | 3 stripped | tail: 32   ← 85%+
```

---

## v0.1 Limitations

- **Placeholder, not summary.** Stripped entries are replaced with a short placeholder — the model sees only that content exists, not what it says. Call `lcm_expand` to retrieve it.
- **In-memory store.** The entry store lives in memory and resets on pi restart. Calling `lcm_expand` for an entry from a previous session returns "not found".
- **Tool results only.** Only tool results are stripped in v0.1. User messages and assistant messages are never stripped.

---

## Roadmap

See [ROADMAP.md](./ROADMAP.md) for planned improvements.
