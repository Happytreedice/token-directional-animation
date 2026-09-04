# Token Directional Animation

[![Foundry v12+](https://img.shields.io/badge/Foundry-v12%20--%20v14-orange)](https://foundryvtt.com/)
[![Release](https://img.shields.io/badge/Release-v0.1.5-blue)](https://github.com/Happytreedice/token-directional-animation/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Support on Boosty](https://img.shields.io/badge/Support-Boosty-orange.svg)](https://boosty.to/happytreedice)

A Foundry VTT module (verified for **v14**, minimum v12) that changes a token's
texture based on its movement direction across **8 octants** — N, NE, E, SE, S,
SW, W, NW. Multi-waypoint paths update the facing **per segment**, textures are
preloaded and cached to avoid flicker, and the dynamic token ring, elevation
handling and mesh filters are preserved (the TokenDocument is never modified —
all swaps happen on the canvas mesh only).

## Installation

In Foundry VTT, navigate to **Configuration and Setup** → **Add-on Modules** → **Install Module**, and paste the Manifest URL:

```
https://github.com/Happytreedice/token-directional-animation/releases/latest/download/module.json
```

## How it works

Movement direction is computed from each path segment's displacement using
`atan2(dy, dx)` (canvas coordinates, positive Y = South), bucketed into eight
45° sectors centered on each compass direction:

```
        N
   NW       NE
 W             E
   SW       SE
        S
```

In Foundry v13/v14 a multi-waypoint move is animated as a chain of
`Token#animate` calls, one per segment. The module wraps `Token#animate`
(cooperatively via [libWrapper](https://foundryvtt.com/packages/lib-wrapper)
when it is active, with a safe direct wrapper otherwise) and:

1. computes each queued segment's octant at call time (the first segment uses
   `TokenDocument#movement.origin`, later ones the previously queued target);
2. swaps the mesh texture exactly when that segment starts animating;
3. applies the configured **idle behavior** when the whole chain finishes,
   stops (`stopToken`) — while a *paused* movement keeps its current facing.

The wrapper is a pure observer: it never changes the arguments or return value
of `Token#animate`, and every module code path is guarded so a failure cannot
break core token animation.

## Animation sources

A token's directional textures can come from any of these sources (configured
per token, or auto-detected):

### 1. `index.json` (Icewind Dale pack style)

```json
{
  "dirs": {
    "S":  {"webm": "modules/my-pack/assets/goblin/anim/S.webm", "frames": 8},
    "SW": {"webm": "modules/my-pack/assets/goblin/anim/SW.webm"},
    "W":  "modules/my-pack/assets/goblin/anim/W.webm",
    "N":  {"src": "modules/my-pack/assets/goblin/anim/N.webm"}
  },
  "idle": "modules/my-pack/assets/goblin/token.webp"
}
```

* Each `dirs` entry may be a **string** or an **object** with a `webm`, `webp`,
  `img`, `src` or `path` key. Extra keys (`frames`, `size`, …) are ignored.
* An optional top-level `idle` or `token` entry provides the idle texture.
* A flat top-level map (`{"S": "...", "N": "..."}`) without `dirs` also works.
* **Broken inner paths are healed**: if a path written in the index does not
  exist (some packs ship mismatched layouts), the module falls back to
  resolving it relative to the index.json location, and finally to just the
  file name next to the index.

### 2. Path template

```
modules/my-pack/assets/goblin/{dir}.webm
```

`{dir}` is replaced with each direction name (`N`, `NE`, …). Directions whose
files don't exist are simply skipped.

### 3. Directory

```
modules/my-pack/assets/goblin/anim
```

The directory is checked for an `index.json` first, then probed for
`N.webm`, `NE.webm`, … (falling back through webp, png, jpg, jpeg, gif, svg,
avif).

### 4. Auto-detection

With no source configured, the module can detect one from the token's texture
path (globally toggleable):

* an `index.json` sitting next to the texture, or
* the texture itself being a directional file (e.g. `.../anim/S.webm`), or
* the texture living in a directory named `anim`.

Detection results (positive and negative) are cached per path for the session.

## Partial direction sets

* **5-direction sources** (e.g. only `N`, `NE`, `E`, `SE`, `S`): when
  **mirroring** is enabled, the missing horizontal side is covered by rendering
  the opposite texture horizontally flipped (`W`←`E`, `NW`←`NE`, `SW`←`SE`) —
  the flip is applied on the mesh and composes correctly with a token whose
  `texture.scaleX` is already negative.
* **Sparser sources** (e.g. 4-directional) still resolve every octant via a
  nearest-direction fallback (ties resolve clockwise).

## Idle behavior

When a token stops moving, it can:

| Behavior | Result |
|---|---|
| **Revert to default** | Shows the `index.json` idle entry if one exists, otherwise the token's own document texture. |
| **Keep last direction** | Stays facing the direction of the last movement segment. |
| **Custom idle texture** | Shows the per-token idle texture (falling back to the index idle entry, then the document texture). |

The world setting provides the default; each token can override it.

## Configuration

### Token Configuration → “Directions” tab

Injected into both the Token and Prototype Token configuration sheets:

* **Enable Directional Animation** — force the module on for this token.
* **Animation Source** — index.json path, `{dir}` template, or directory.
  Leave empty to auto-detect from the token texture.
* **Mirror Missing Directions** — yes / no / use world default.
* **Idle Behavior** — per-token override of the world default.
* **Idle Texture** — used when idle behavior is “custom”.

All fields are stored as flags under `flags.token-directional-animation.*` and
travel with the prototype token.

### World / client settings

* **Enable Directional Animation** *(world)* — master switch.
* **Auto-Detect Animation Sources** *(world)* — try auto-detection even for
  tokens without explicit configuration.
* **Default Idle Behavior** *(world)*.
* **Mirror Missing Directions** *(world default)*.
* **Preload Directional Textures** *(client)* — preload every candidate
  token's textures on scene load (recommended; prevents first-move flicker).
* **Debug Logging** *(client)*.

## Texture handling details

* Textures load through Foundry's `loadTexture` / `TextureLoader` (PIXI.Assets
  cache), and are additionally preloaded when a movement is initiated
  (`preMoveToken`) so the first segment never waits on I/O.
* Swaps assign the cached `PIXI.Texture` directly to the token's
  `PrimarySpriteMesh` and re-fit it through the token's own render flags
  (`refreshMesh` + `refreshSize`), so texture fit, anchor, dynamic ring scale
  adjustments, elevation and attached filters behave exactly as with a core
  texture change.
* `.webm` sources are kept looping and muted via Foundry's `VideoHelper`.
* Full token redraws (which reload the document texture) are detected via the
  `drawToken` hook and the module texture is re-applied.

## API

Available after `ready` as `game.modules.get("token-directional-animation").api`:

```js
const api = game.modules.get("token-directional-animation").api;

api.octantFromDelta(dx, dy);      // -> "SE" (canvas coords, +y = South)
await api.getProfile(token.document); // -> {entries: {N: {src}, ...}, idle}
await api.face(token, "NW");      // force a facing
await api.idle(token);            // apply configured idle behavior
await api.reset(token);           // restore the document texture
await api.preload(token.document);
```

## Compatibility notes

* **v13/v14**: full per-segment waypoint support via the movement API
  (`TokenDocument#movement`, `movementAnimationName`, `stopToken` /
  `pauseToken` / `preMoveToken` hooks).
* **v12**: positional `Token#animate` calls are treated as movement (v12 has no
  waypoint chain), so direction still updates per move.
* **libWrapper** is used automatically when active; it is not required.
* System subclasses of `Token` are covered (the wrapper targets
  `CONFIG.Token.objectClass` at `setup`).

## File structure

```
token-directional-animation/
├── module.json
├── LICENSE
├── README.md
├── scripts/
│   ├── main.mjs                 # bootstrap, settings, public API
│   ├── movement-handler.mjs     # Token#animate wrapper, per-segment scheduling
│   ├── directional-manager.mjs  # source resolution, caching, mesh texture swaps
│   ├── token-config.mjs         # Token Config "Directions" tab
│   └── utils.mjs                # octant math, path helpers, constants
├── languages/
│   ├── en.json
│   └── ru.json
└── styles/
    └── token-directional-animation.css
```

## Author & Support

- **Author:** Happytreedice
- **GitHub:** [https://github.com/Happytreedice](https://github.com/Happytreedice)
- **Support & Donations:** [https://boosty.to/happytreedice](https://boosty.to/happytreedice)

## License

This project is licensed under the **MIT License** — free to use, modify, and distribute with attribution.
See [LICENSE](file:///mnt/win-data/Backups/FoundryData/foundrydata/Data/modules/token-directional-animation/LICENSE) for full details.

