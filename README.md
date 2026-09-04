# Token Directional Animation

[![Foundry v12+](https://img.shields.io/badge/Foundry-v12%20--%20v14-orange)](https://foundryvtt.com/)
[![Release](https://img.shields.io/badge/Release-v0.1.5-blue)](https://github.com/Happytreedice/token-directional-animation/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Support on Boosty](https://img.shields.io/badge/Support-Boosty-orange.svg)](https://boosty.to/happytreedice)

A Foundry VTT module (verified for **v14**, minimum **v12**) that changes a token's texture based on its movement direction across **8 octants** (N, NE, E, SE, S, SW, W, NW). Multi-waypoint paths update the facing **per segment**, textures are preloaded and cached to avoid flicker, and the dynamic token ring, elevation handling, and mesh filters are preserved (the `TokenDocument` is never modified — all swaps happen on the canvas mesh only).

---

## Installation

In Foundry VTT, navigate to **Configuration and Setup** → **Add-on Modules** → **Install Module**, and paste the Manifest URL:

```text
https://github.com/Happytreedice/token-directional-animation/releases/latest/download/module.json
```

---

## How It Works

Movement direction is computed from each path segment's displacement using `atan2(dy, dx)` (canvas coordinates, positive Y = South), bucketed into eight 45° sectors centered on each compass direction:

```text
        N
   NW       NE
 W             E
   SW       SE
        S
```

In Foundry v13/v14, a multi-waypoint move is animated as a chain of `Token#animate` calls, one per segment. The module wraps `Token#animate` (cooperatively via [libWrapper](https://foundryvtt.com/packages/lib-wrapper) when active, or with a safe direct wrapper otherwise) and:

1. Computes each queued segment's octant at call time (the first segment uses `TokenDocument#movement.origin`, later ones use the previously queued target);
2. Swaps the mesh texture exactly when that segment starts animating;
3. Applies the configured **idle behavior** when the whole chain finishes or stops (`stopToken`), while a *paused* movement maintains its current facing.

The wrapper acts as a pure observer: it never alters the arguments or return value of `Token#animate`, and every code path is guarded so failures cannot break core token animation.

---

## Animation Sources

A token's directional textures can come from any of these sources (configured per token, or auto-detected):

### 1. `index.json` (Icewind Dale pack style)

```json
{
  "dirs": {
    "S":  { "webm": "modules/my-pack/assets/goblin/anim/S.webm", "frames": 8 },
    "SW": { "webm": "modules/my-pack/assets/goblin/anim/SW.webm" },
    "W":  "modules/my-pack/assets/goblin/anim/W.webm",
    "N":  { "src": "modules/my-pack/assets/goblin/anim/N.webm" }
  },
  "idle": "modules/my-pack/assets/goblin/token.webp"
}
```

- Each `dirs` entry may be a **string** or an **object** with a `webm`, `webp`, `img`, `src`, or `path` key. Extra keys (`frames`, `size`, etc.) are safely ignored.
- An optional top-level `idle` or `token` entry provides the idle texture.
- A flat top-level map (`{"S": "...", "N": "..."}`) without `dirs` is also supported.
- **Broken inner paths are healed**: if a path written in the index does not exist (some packs ship mismatched layouts), the module falls back to resolving it relative to the `index.json` location, and finally to just the file name next to the index.

### 2. Path Template

```text
modules/my-pack/assets/goblin/{dir}.webm
```

`{dir}` is dynamically replaced with each direction name (`N`, `NE`, `E`, `SE`, `S`, `SW`, `W`, `NW`). Directions whose files do not exist are simply skipped.

### 3. Directory

```text
modules/my-pack/assets/goblin/anim
```

The directory is checked for an `index.json` first, then probed for `N.webm`, `NE.webm`, ... (falling back through `webp`, `png`, `jpg`, `jpeg`, `gif`, `svg`, `avif`).

### 4. Auto-Detection

With no source explicitly configured, the module can automatically detect one from the token's texture path (globally toggleable in settings):

- An `index.json` sitting next to the texture;
- The texture itself being a directional file (e.g. `.../anim/S.webm`);
- The texture residing in a directory named `anim`.

Detection results (both positive and negative) are cached per path for the duration of the session.

---

## Partial Direction Sets

- **5-direction sources** (e.g. only `N`, `NE`, `E`, `SE`, `S`): when **mirroring** is enabled, the missing horizontal side is covered by rendering the opposite texture horizontally flipped (`W` ← `E`, `NW` ← `NE`, `SW` ← `SE`). The flip is applied directly on the mesh and composes correctly with tokens whose `texture.scaleX` is already negative.
- **Sparser sources** (e.g. 4-directional): octants resolve via nearest-direction fallback (ties resolve clockwise).

---

## Idle Behavior

When a token finishes moving, its idle texture is determined by the configured behavior:

| Behavior | Result |
| :--- | :--- |
| **Revert to default** | Shows the `index.json` idle entry if one exists; otherwise reverts to the token's own document texture. |
| **Keep last direction** | Stays facing the direction of the last movement segment. |
| **Custom idle texture** | Shows the per-token custom idle texture (falling back to the index idle entry, then the document texture). |

The world setting provides the default behavior, which can be overridden on any individual token.

---

## Configuration

### Token Configuration → “Directions” Tab

Injected into both the Token and Prototype Token configuration sheets:

- **Enable Directional Animation**: Force directional animations on/off for this token.
- **Animation Source**: Path to `index.json`, `{dir}` template, or directory (leave empty to auto-detect from token texture).
- **Mirror Missing Directions**: Yes / No / Use world default.
- **Idle Behavior**: Override the world default idle behavior for this token.
- **Idle Texture**: Custom texture path used when Idle Behavior is set to "Custom".

All token settings are stored under `flags.token-directional-animation.*` and persist with prototype tokens.

### World & Client Settings

- **Enable Directional Animation** *(World)*: Master switch for directional animations.
- **Auto-Detect Animation Sources** *(World)*: Attempt auto-detection for tokens without explicit configuration.
- **Default Idle Behavior** *(World)*: Default state when movement completes.
- **Mirror Missing Directions** *(World)*: Global default for 5-direction flipping.
- **Preload Directional Textures** *(Client)*: Preload candidate textures on scene load to prevent first-move flicker (recommended).
- **Debug Logging** *(Client)*: Enable diagnostic logging in the developer console.

---

## Texture Handling Details

- Textures load through Foundry's `loadTexture` / `TextureLoader` (`PIXI.Assets` cache) and are preloaded when movement initiates (`preMoveToken`), ensuring the first segment starts immediately without I/O lag.
- Swaps assign the cached `PIXI.Texture` directly to the token's `PrimarySpriteMesh` and re-fit it via the token's own render flags (`refreshMesh` + `refreshSize`), ensuring texture fit, anchor, dynamic ring scale, elevation, and attached filters function identically to core changes.
- `.webm` video sources loop seamlessly and stay muted via Foundry's `VideoHelper`.
- Full token redraws (which reload the document texture) are intercepted via the `drawToken` hook to restore the active directional texture.

---

## API

Available after the `ready` hook as `game.modules.get("token-directional-animation").api`:

```javascript
const api = game.modules.get("token-directional-animation").api;

api.octantFromDelta(dx, dy);           // -> "SE" (canvas coords, +Y = South)
await api.getProfile(token.document);  // -> { entries: { N: {src}, ... }, idle }
await api.face(token, "NW");           // Force a specific facing
await api.idle(token);                 // Apply configured idle behavior
await api.reset(token);                // Restore base document texture
await api.preload(token.document);      // Preload directional textures for token
```

---

## Compatibility Notes

- **Foundry v13 / v14**: Full per-segment waypoint support via the movement API (`TokenDocument#movement`, `movementAnimationName`, and `stopToken` / `pauseToken` / `preMoveToken` hooks).
- **Foundry v12**: Positional `Token#animate` calls are treated as movements (v12 has no waypoint movement chain), updating direction per move.
- **libWrapper**: Automatically used when active; safe native fallback when not installed.
- **Custom Token classes**: Fully compatible with game system subclasses (the wrapper targets `CONFIG.Token.objectClass` during `setup`).

---

## File Structure

```text
token-directional-animation/
├── module.json
├── LICENSE
├── README.md
├── scripts/
│   ├── main.mjs                 # Bootstrap, settings, public API
│   ├── movement-handler.mjs     # Token#animate wrapper, per-segment scheduling
│   ├── directional-manager.mjs  # Source resolution, caching, mesh texture swaps
│   ├── token-config.mjs         # Token Config "Directions" tab
│   └── utils.mjs                # Octant math, path helpers, constants
├── languages/
│   ├── en.json
│   └── ru.json
└── styles/
    └── token-directional-animation.css
```

---

## Author & Support

- **Author:** Happytreedice
- **GitHub:** [https://github.com/Happytreedice](https://github.com/Happytreedice)
- **Support & Donations:** [https://boosty.to/happytreedice](https://boosty.to/happytreedice)

---

## License

This project is licensed under the **MIT License** — free to use, modify, and distribute with attribution.  
See [LICENSE](LICENSE) for full details.
