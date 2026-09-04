/**
 * Directional texture management.
 *
 * Resolves a token's "directional profile" (a map of compass direction to
 * texture path plus an optional idle texture) from any of the supported
 * source formats, caches and preloads the textures, and applies them to the
 * token's PrimarySpriteMesh without touching the TokenDocument.
 *
 * Supported sources:
 *  - index.json (dnd-icewind-dale-pack style: {dirs: {S: {webm: "..."}, ...}, idle/token: "..."})
 *  - A {dir} path template, e.g. "tokens/goblin/{dir}.webm"
 *  - A directory containing N.webm / NE.webm / ... (or another index.json)
 *  - Auto-detection from the token's texture path (index.json next to the
 *    texture, or the texture living in a directional/anim directory)
 */

import {
  MODULE_ID, DIRECTIONS, FLAGS, SETTINGS, IDLE_BEHAVIOR, TEXTURE_EXTENSIONS,
  octantFromDelta, resolveDirection, cleanPath, dirname, basenameNoExt, extname,
  isTemplate, expandTemplate, entryToPath, debug, warn
} from "./utils.mjs";

/* -------------------------------------------- */
/*  Foundry version shims                       */
/* -------------------------------------------- */

/** Load a texture through Foundry's texture loader (v14 namespace or v12 global). */
function loadTex(src) {
  const fn = foundry.canvas?.loadTexture ?? globalThis.loadTexture;
  return fn(src);
}

/** Synchronously fetch a texture from Foundry's texture cache. */
function getTex(src) {
  const fn = foundry.canvas?.getTexture ?? globalThis.getTexture;
  return fn(src);
}

/* -------------------------------------------- */
/*  Caches and per-token state                  */
/* -------------------------------------------- */

/**
 * Profile cache: source key -> Promise<Profile|null>.
 * A Profile is {key, entries: {[dir]: {src}}, idle: string|null}.
 * @type {Map<string, Promise<object|null>>}
 */
const profileCache = new Map();

/** HEAD-probe cache: url -> true (exists) | false (missing) | null (unknown). */
const probeCache = new Map();

/**
 * Per-token runtime state, keyed by token id:
 * {direction, mirrored, src, active} — `active` means the mesh currently shows
 * a module-controlled texture instead of the document texture.
 * @type {Map<string, object>}
 */
const tokenStates = new Map();

/** Drop all per-token state (scene teardown). */
export function clearAllStates() {
  tokenStates.clear();
}

/** Drop the state for a single token (deletion). */
export function clearState(tokenId) {
  tokenStates.delete(tokenId);
}

/**
 * Invalidate cached profiles for a token whose source or texture changed.
 * The per-token display state is deliberately kept so an active directional
 * texture can still be restored afterwards.
 */
export function invalidate(tokenDoc) {
  for ( const key of sourceKeysFor(tokenDoc) ) profileCache.delete(key);
}

/* -------------------------------------------- */
/*  Effective configuration                     */
/* -------------------------------------------- */

/**
 * Merge per-token flags with world defaults into an effective configuration.
 * @param {TokenDocument} doc
 * @returns {{enabled: boolean, source: string, idleBehavior: string,
 *            idleSource: string, mirror: boolean, autoDetect: boolean}}
 */
export function getEffectiveConfig(doc) {
  const flags = doc.flags?.[MODULE_ID] ?? {};
  const worldEnabled = game.settings.get(MODULE_ID, SETTINGS.ENABLED);
  const autoDetect = game.settings.get(MODULE_ID, SETTINGS.AUTO_DETECT);
  const mirrorFlag = flags[FLAGS.MIRROR];
  return {
    enabled: worldEnabled && (flags[FLAGS.ENABLED] === true || autoDetect),
    explicit: flags[FLAGS.ENABLED] === true,
    source: (flags[FLAGS.SOURCE] ?? "").trim(),
    idleBehavior: flags[FLAGS.IDLE_BEHAVIOR] || game.settings.get(MODULE_ID, SETTINGS.DEFAULT_IDLE_BEHAVIOR),
    idleSource: (flags[FLAGS.IDLE_SOURCE] ?? "").trim(),
    mirror: mirrorFlag === "yes" ? true
      : mirrorFlag === "no" ? false
      : game.settings.get(MODULE_ID, SETTINGS.DEFAULT_MIRROR),
    autoDetect
  };
}

/**
 * Cheap synchronous check used on the hot path: could this token possibly use
 * directional animation? (Final say belongs to profile resolution.)
 * @param {TokenDocument} doc
 * @returns {boolean}
 */
export function isCandidate(doc) {
  if ( !doc ) return false;
  const cfg = getEffectiveConfig(doc);
  return cfg.enabled && (cfg.explicit || !!cfg.source || cfg.autoDetect);
}

/* -------------------------------------------- */
/*  Existence probing                           */
/* -------------------------------------------- */

/**
 * Probe whether a file exists via a HEAD request. Results are cached.
 * Returns null when the answer is unknown (network error, HEAD not allowed) —
 * callers should then optimistically assume existence and let loadTexture decide.
 * @param {string} url
 * @returns {Promise<boolean|null>}
 */
async function probeExists(url) {
  if ( probeCache.has(url) ) return probeCache.get(url);
  let result;
  try {
    const response = await fetch(url, { method: "HEAD" });
    result = response.ok ? true : (response.status === 404 ? false : null);
  } catch {
    result = null;
  }
  probeCache.set(url, result);
  return result;
}

/** Fetch and parse a JSON file, returning null on any failure. */
async function fetchJson(path) {
  try {
    if ( foundry.utils.fetchJsonWithTimeout ) return await foundry.utils.fetchJsonWithTimeout(path);
    const response = await fetch(path);
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------- */
/*  Profile resolution                          */
/* -------------------------------------------- */

/**
 * The cache keys a token's profile may live under, in resolution order.
 * @param {TokenDocument} doc
 * @returns {string[]}
 */
function sourceKeysFor(doc) {
  const cfg = getEffectiveConfig(doc);
  const keys = [];
  if ( cfg.source ) keys.push(`src:${cfg.source}`);
  const texture = cleanPath(doc.texture?.src ?? "");
  if ( texture ) keys.push(`auto:${texture}`);
  return keys;
}

/**
 * Resolve (and cache) the directional profile for a token.
 * @param {TokenDocument} doc
 * @returns {Promise<object|null>}
 */
export async function getProfile(doc) {
  const cfg = getEffectiveConfig(doc);
  if ( !cfg.enabled ) return null;

  if ( cfg.source ) {
    const key = `src:${cfg.source}`;
    if ( !profileCache.has(key) ) profileCache.set(key, resolveSource(cfg.source, key));
    const profile = await profileCache.get(key);
    if ( profile ) return profile;
    if ( cfg.explicit ) return null; // an explicit source that fails should not silently auto-detect
  }

  if ( !cfg.autoDetect && !cfg.explicit ) return null;
  const texture = cleanPath(doc.texture?.src ?? "");
  if ( !texture ) return null;
  const key = `auto:${texture}`;
  if ( !profileCache.has(key) ) profileCache.set(key, autoDetect(texture, key));
  return profileCache.get(key);
}

/**
 * Resolve an explicitly configured source string.
 * @param {string} source  index.json path, {dir} template, or directory.
 * @param {string} key     Cache key (becomes the profile key).
 * @returns {Promise<object|null>}
 */
async function resolveSource(source, key) {
  source = cleanPath(source).replace(/\/+$/, "");
  let profile = null;
  if ( source.toLowerCase().endsWith(".json") ) profile = await profileFromIndex(source, key);
  else if ( isTemplate(source) ) profile = await profileFromTemplate(source, key);
  else if ( extname(source) ) {
    // A direct file path: treat its directory as the source, preferring its extension.
    profile = await profileFromDirectory(dirname(source), key, [extname(source)]);
  }
  else profile = await profileFromDirectory(source, key);
  if ( !profile ) debug(`Could not resolve directional source "${source}".`);
  return profile;
}

/**
 * Auto-detect a profile from a token texture path:
 *  1. index.json in the texture's directory,
 *  2. the texture itself being a directional file (e.g. ".../S.webm"),
 *  3. the texture living in an "anim" directory.
 * @param {string} texture
 * @param {string} key
 * @returns {Promise<object|null>}
 */
async function autoDetect(texture, key) {
  const dir = dirname(texture);
  if ( !dir ) return null;

  const index = await profileFromIndex(`${dir}/index.json`, key, { silent: true });
  if ( index ) return index;

  const base = basenameNoExt(texture).toUpperCase();
  const looksDirectional = DIRECTIONS.includes(base);
  const inAnimDir = /(^|\/)anim$/i.test(dir);
  if ( !looksDirectional && !inAnimDir ) return null;

  const preferred = [extname(texture), ...TEXTURE_EXTENSIONS].filter(Boolean);
  return profileFromDirectory(dir, key, [...new Set(preferred)]);
}

/**
 * Build a profile from an index.json file.
 * @param {string} path
 * @param {string} key
 * @param {object} [options]
 * @param {boolean} [options.silent]  Suppress the parse warning (used by auto-detect probing).
 * @returns {Promise<object|null>}
 */
async function profileFromIndex(path, key, { silent=true }={}) {
  if ( await probeExists(path) === false ) return null;
  const data = await fetchJson(path);
  if ( !data || typeof data !== "object" ) {
    return null;
  }
  const indexDir = dirname(path);
  const dirs = (data.dirs && typeof data.dirs === "object") ? data.dirs : data;
  const entries = {};
  for ( const [rawDir, rawEntry] of Object.entries(dirs) ) {
    const direction = rawDir.toUpperCase();
    if ( !DIRECTIONS.includes(direction) ) continue;
    const rawPath = entryToPath(rawEntry);
    if ( !rawPath ) continue;
    const src = await resolveIndexPath(rawPath, indexDir);
    if ( src ) entries[direction] = { src };
  }
  if ( foundry.utils.isEmpty(entries) ) return null;
  const rawIdle = entryToPath(data.idle ?? data.token ?? null);
  const idle = rawIdle ? await resolveIndexPath(rawIdle, indexDir) : null;
  debug(`Resolved index.json profile "${path}"`, entries);
  return { key, entries, idle };
}

/**
 * Resolve a path referenced inside an index.json. Prioritizes the exact raw path
 * if it exists or points to a module asset, falling back to directory-relative paths.
 * @param {string} raw       Path as written in the index.
 * @param {string} indexDir  Directory containing the index.json.
 * @returns {Promise<string|null>}
 */
async function resolveIndexPath(raw, indexDir) {
  raw = cleanPath(raw);
  const filename = raw.slice(raw.lastIndexOf("/") + 1);
  const candidates = [...new Set([raw, `${indexDir}/${raw}`, `${indexDir}/${filename}`])];
  for ( const candidate of candidates ) {
    const exists = await probeExists(candidate);
    if ( exists === true ) return candidate;
  }
  // If existence probe was inconclusive, prefer the raw path if it is a module asset
  if ( raw.startsWith("modules/") ) return raw;
  return null;
}

/**
 * Build a profile from a {dir} template by probing all eight directions.
 * @param {string} template
 * @param {string} key
 * @returns {Promise<object|null>}
 */
async function profileFromTemplate(template, key) {
  const entries = {};
  await Promise.all(DIRECTIONS.map(async direction => {
    const src = expandTemplate(template, direction);
    if ( await probeExists(src) !== false ) entries[direction] = { src };
  }));
  if ( foundry.utils.isEmpty(entries) ) return null;
  debug(`Resolved template profile "${template}"`, entries);
  return { key, entries, idle: null };
}

/**
 * Build a profile from a directory holding N.webm / NE.webm / ... files.
 * Also honors an index.json inside the directory when present.
 * @param {string} dir
 * @param {string} key
 * @param {string[]} [extensions]  Extension priority order.
 * @returns {Promise<object|null>}
 */
async function profileFromDirectory(dir, key, extensions=TEXTURE_EXTENSIONS) {
  if ( !dir ) return null;
  const index = await profileFromIndex(`${dir}/index.json`, key, { silent: true });
  if ( index ) return index;
  for ( const ext of extensions ) {
    const profile = await profileFromTemplate(`${dir}/{dir}.${ext}`, key);
    if ( profile ) return profile;
  }
  return null;
}

/* -------------------------------------------- */
/*  Preloading                                  */
/* -------------------------------------------- */

/**
 * Preload every texture referenced by a profile into Foundry's texture cache.
 * @param {object} profile
 * @returns {Promise<void>}
 */
export async function preloadProfile(profile) {
  if ( !profile ) return;
  const sources = new Set(Object.values(profile.entries).map(e => e.src));
  if ( profile.idle ) sources.add(profile.idle);
  await Promise.allSettled([...sources].map(src => loadTex(src)));
  debug(`Preloaded ${sources.size} textures for profile "${profile.key}"`);
}

/** Resolve and preload the profile of a single token. Fire-and-forget safe. */
export async function preloadFor(doc) {
  try {
    const profile = await getProfile(doc);
    if ( profile ) await preloadProfile(profile);
  } catch(err) {
    warn(`Preload failed for token "${doc?.name}":`, err);
  }
}

/** Preload profiles for every candidate token of the active scene. */
export async function preloadScene() {
  if ( !canvas.scene || !game.settings.get(MODULE_ID, SETTINGS.PRELOAD_ALL) ) return;
  const candidates = canvas.scene.tokens.filter(isCandidate);
  await Promise.allSettled(candidates.map(preloadFor));
}

/* -------------------------------------------- */
/*  Applying textures to the token mesh         */
/* -------------------------------------------- */

/**
 * Swap the texture shown by the token's PrimarySpriteMesh, preserving the
 * mesh instance itself (and therefore the dynamic ring binding, elevation
 * handling and any filters attached to it). The TokenDocument is never
 * modified. Sizing is re-fit through the token's own render flags so the new
 * texture's aspect ratio is respected exactly like a core texture change.
 *
 * @param {Token} token
 * @param {string} src        Texture path.
 * @param {boolean} mirrored  Render horizontally flipped.
 * @returns {Promise<boolean>}
 */
async function setMeshTexture(token, src, mirrored, { play=true }={}) {
  if ( !token?.mesh || token.destroyed ) return false;
  let texture = getTex(src);
  if ( !texture ) texture = await loadTex(src);
  if ( !texture?.valid || !token.mesh || token.destroyed ) return false;

  // Manage webm/video playback state
  try {
    const video = game.video.getVideoSource(texture);
    if ( video ) {
      video.loop = true;
      video.muted = true;
      if ( play ) {
        if ( video.ended || (Number.isFinite(video.duration) && video.currentTime >= video.duration) ) {
          video.currentTime = 0;
        }
        if ( texture.baseTexture?.resource ) {
          texture.baseTexture.resource.autoUpdate = true;
        }
        // Direct playback call to ensure browser media engine starts
        try {
          const p = video.play();
          if ( p?.catch ) p.catch(() => {});
        } catch (err) {
          debug("Direct video.play failed:", err);
        }
        // Register with Foundry's VideoHelper
        try {
          game.video.play(video, {
            playing: true,
            loop: true,
            volume: 0,
            offset: video.currentTime || 0
          });
        } catch (err) {
          debug("game.video.play failed:", err);
        }
      } else {
        video.pause();
        video.currentTime = 0;
        texture.baseTexture?.resource?.update?.();
        texture.baseTexture?.update();
      }
    }
  } catch(err) {
    debug("Video playback setup failed:", err);
  }

  token.texture = texture;
  token.mesh.texture = texture;
  token.renderFlags.set({ refreshMesh: true, refreshSize: true });
  applyMirror(token, mirrored);
  return true;
}

/**
 * Enforce the mirrored (or unmirrored) horizontal orientation of the mesh,
 * relative to whatever flip the document's texture.scaleX already encodes.
 * Called after each texture swap and re-asserted on every refreshToken so
 * core refresh handlers cannot silently undo the flip.
 * @param {Token} token
 * @param {boolean} [mirrored]  Override; defaults to the token's stored state.
 */
export function applyMirror(token, mirrored) {
  const state = tokenStates.get(token.id);
  if ( mirrored === undefined ) mirrored = state?.mirrored ?? false;
  if ( !token.mesh || !state?.active ) return;
  const docSign = Math.sign(token.document.texture.scaleX || 1);
  const desired = mirrored ? -docSign : docSign;
  if ( Math.sign(token.mesh.scale.x || 1) !== desired ) {
    token.mesh.scale.x = Math.abs(token.mesh.scale.x) * desired;
  }
}

/**
 * Apply the texture for a movement direction to a token.
 * @param {Token} token
 * @param {string} direction  One of DIRECTIONS.
 * @returns {Promise<void>}
 */
export async function applyDirection(token, direction) {
  const doc = token?.document;
  if ( !doc || !isCandidate(doc) ) return;
  const profile = await getProfile(doc);
  if ( !profile ) return;

  const cfg = getEffectiveConfig(doc);
  const resolved = resolveDirection(direction, profile.entries, cfg.mirror);
  if ( !resolved ) return;
  const src = profile.entries[resolved.direction].src;

  let state = tokenStates.get(token.id);
  if ( !state ) tokenStates.set(token.id, state = {});
  if ( state.src === src && state.mirrored === resolved.mirrored && state.active ) {
    state.direction = direction;
    // Resume video playback if it was paused
    const video = game.video.getVideoSource(token.mesh?.texture);
    if ( video && video.paused ) {
      video.loop = true;
      video.muted = true;
      const p = video.play();
      if ( p?.catch ) p.catch(() => {});
    }
    return; // already showing this texture
  }

  Object.assign(state, {
    direction,
    mirrored: resolved.mirrored,
    src,
    active: true
  });
  debug(`Token "${doc.name}" -> ${direction} (using ${resolved.direction}${resolved.mirrored ? ", mirrored" : ""})`);
  await setMeshTexture(token, src, resolved.mirrored, { play: true });
}

/**
 * Apply the configured idle behavior once movement has finished.
 * @param {Token} token
 * @returns {Promise<void>}
 */
export async function applyIdle(token) {
  const doc = token?.document;
  if ( !doc ) return;
  const state = tokenStates.get(token.id);
  if ( !state?.active ) return;
  const cfg = getEffectiveConfig(doc);

  if ( cfg.idleBehavior === IDLE_BEHAVIOR.CUSTOM && cfg.idleSource ) {
    const src = cfg.idleSource;
    Object.assign(state, { src, mirrored: false, active: true });
    debug(`Token "${doc.name}" -> custom idle texture "${src}"`);
    await setMeshTexture(token, src, false, { play: true });
    return;
  }

  // Animation must continue playing in the facing direction upon movement completion
  if ( token.mesh?.texture ) {
    const video = game.video.getVideoSource(token.mesh.texture);
    if ( video ) {
      video.loop = true;
      video.muted = true;
      const p = video.play();
      if ( p?.catch ) p.catch(() => {});
    }
  }
}

/**
 * Restore the token's own document texture and release module control.
 * @param {Token} token
 * @returns {Promise<void>}
 */
export async function restoreDefault(token) {
  const doc = token?.document;
  const state = tokenStates.get(token.id);
  if ( !doc || !state?.active ) return;
  Object.assign(state, { src: null, mirrored: false, active: false, direction: null });
  debug(`Token "${doc.name}" -> restored document texture`);
  await setMeshTexture(token, doc.texture.src, false, { play: false });
}

/**
 * Re-apply the module-controlled texture after a full token redraw
 * (core _draw reloads the document texture, discarding our swap).
 * @param {Token} token
 */
export function handleDraw(token) {
  const state = tokenStates.get(token.id);
  if ( !state?.active || !state.src ) return;
  setMeshTexture(token, state.src, state.mirrored, { play: false }).catch(err => warn("Redraw re-apply failed:", err));
}

/**
 * Re-assert the mirror flip after core refresh handlers ran,
 * and update video texture frames on every render tick during movement.
 * @param {Token} token
 */
export function handleRefresh(token) {
  applyMirror(token);
  const state = tokenStates.get(token.id);
  if ( state?.active && token.mesh?.texture ) {
    const video = game.video.getVideoSource(token.mesh.texture);
    if ( video && !video.paused ) {
      token.mesh.texture.baseTexture?.resource?.update?.();
      token.mesh.texture.baseTexture?.update();
    }
  }
}
