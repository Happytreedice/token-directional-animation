/**
 * Shared constants and pure helpers for Token Directional Animation.
 * Everything in this file is side-effect free and independent of canvas state.
 */

export const MODULE_ID = "token-directional-animation";

/** The eight compass directions, in clockwise order starting from North. */
export const DIRECTIONS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

/**
 * Horizontal mirror pairs used for the 5-direction fallback.
 * A source that only ships one horizontal side (typically E / NE / SE plus N and S)
 * can cover the opposite side by flipping the sprite.
 */
export const MIRROR_PAIRS = Object.freeze({
  E: "W", W: "E",
  NE: "NW", NW: "NE",
  SE: "SW", SW: "SE"
});

/** Idle behavior identifiers. */
export const IDLE_BEHAVIOR = Object.freeze({
  DEFAULT: "default",   // revert to the token's original texture
  KEEP: "keepLast",     // keep the last movement direction
  CUSTOM: "custom"      // use a dedicated idle texture / anim entry
});

/** Per-token flag keys (stored under flags[MODULE_ID]). */
export const FLAGS = Object.freeze({
  ENABLED: "enabled",
  SOURCE: "source",
  IDLE_BEHAVIOR: "idleBehavior",
  IDLE_SOURCE: "idleSource",
  MIRROR: "mirror"
});

/** World setting keys. */
export const SETTINGS = Object.freeze({
  ENABLED: "enabled",
  AUTO_DETECT: "autoDetect",
  DEFAULT_IDLE_BEHAVIOR: "defaultIdleBehavior",
  DEFAULT_MIRROR: "defaultMirror",
  PRELOAD_ALL: "preloadAll",
  DEBUG: "debugLogging"
});

/** File extensions considered when probing a directory for directional textures. */
export const TEXTURE_EXTENSIONS = ["webm", "webp", "png", "jpg", "jpeg", "gif", "svg", "avif"];

/* -------------------------------------------- */
/*  Direction math                              */
/* -------------------------------------------- */

/**
 * Compute the 8-direction octant for a movement delta, in canvas coordinates
 * (positive Y points DOWN on the Foundry canvas, so a positive dy means "South").
 *
 * The full circle is divided into eight 45° octants centered on each compass
 * direction: East covers [-22.5°, 22.5°), South-East covers [22.5°, 67.5°), etc.
 *
 * @param {number} dx  Horizontal displacement (canvas pixels or grid units).
 * @param {number} dy  Vertical displacement (positive = downward = South).
 * @returns {string|null}  One of DIRECTIONS, or null when the displacement is zero.
 */
export function octantFromDelta(dx, dy) {
  if ( !dx && !dy ) return null;
  const angle = Math.atan2(dy, dx); // radians, 0 = East, positive = clockwise on screen
  // Bucket the angle into eight 45° sectors centered on each direction
  // (Math.round provides the ±22.5° centering); & 7 wraps negatives into 0..7.
  const sector = Math.round(angle / (Math.PI / 4)) & 7;
  const CLOCKWISE_FROM_EAST = ["E", "SE", "S", "SW", "W", "NW", "N", "NE"];
  return CLOCKWISE_FROM_EAST[sector];
}

/**
 * Reduce an 8-direction map to the direction actually available, applying the
 * horizontal-mirror fallback and finally a nearest-neighbor search so that
 * sparse sources (e.g. 4-directional) still resolve every octant.
 *
 * @param {string} direction               Requested direction (one of DIRECTIONS).
 * @param {Record<string, object>} entries Available entries keyed by direction.
 * @param {boolean} mirror                 Whether horizontal mirroring is allowed.
 * @returns {{direction: string, mirrored: boolean}|null}
 */
export function resolveDirection(direction, entries, mirror) {
  if ( entries[direction] ) return { direction, mirrored: false };
  if ( mirror ) {
    const twin = MIRROR_PAIRS[direction];
    if ( twin && entries[twin] ) return { direction: twin, mirrored: true };
  }
  // Nearest available direction by angular distance (ties resolve clockwise).
  const idx = DIRECTIONS.indexOf(direction);
  if ( idx < 0 ) return null;
  for ( let step = 1; step <= 4; step++ ) {
    for ( const candidate of [DIRECTIONS[(idx + step) & 7], DIRECTIONS[(idx - step + 8) & 7]] ) {
      if ( entries[candidate] ) return { direction: candidate, mirrored: false };
    }
  }
  return null;
}

/* -------------------------------------------- */
/*  Path helpers                                */
/* -------------------------------------------- */

/**
 * Strip any URL query string or hash from a path.
 * @param {string} path
 * @returns {string}
 */
export function cleanPath(path) {
  return path?.split(/[?#]/)[0] ?? "";
}

/**
 * Return the directory portion of a file path (no trailing slash), or "" when
 * the path has no directory component.
 * @param {string} path
 * @returns {string}
 */
export function dirname(path) {
  const p = cleanPath(path);
  const idx = p.lastIndexOf("/");
  return idx >= 0 ? p.slice(0, idx) : "";
}

/**
 * Return the file name without extension.
 * @param {string} path
 * @returns {string}
 */
export function basenameNoExt(path) {
  const p = cleanPath(path);
  const name = p.slice(p.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * Return the lowercase extension of a path (without the dot), or "".
 * @param {string} path
 * @returns {string}
 */
export function extname(path) {
  const p = cleanPath(path);
  const name = p.slice(p.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * Whether a source string is a {dir} template (e.g. "tokens/goblin/{dir}.webm").
 * @param {string} source
 * @returns {boolean}
 */
export function isTemplate(source) {
  return typeof source === "string" && source.includes("{dir}");
}

/**
 * Expand a {dir} template for a given direction.
 * @param {string} template
 * @param {string} direction
 * @returns {string}
 */
export function expandTemplate(template, direction) {
  return template.replaceAll("{dir}", direction);
}

/**
 * Normalize a raw index.json "dirs" entry (or idle entry) to a texture path.
 * Accepts either a plain string or an object with a webm/webp/img/src/path key.
 * @param {string|object} entry
 * @returns {string|null}
 */
export function entryToPath(entry) {
  if ( typeof entry === "string" ) return entry || null;
  if ( entry && typeof entry === "object" ) {
    return entry.webm ?? entry.webp ?? entry.img ?? entry.src ?? entry.path ?? null;
  }
  return null;
}

/* -------------------------------------------- */
/*  Logging                                     */
/* -------------------------------------------- */

let _debugEnabled = false;

/** Toggle verbose logging (bound to the world setting). */
export function setDebug(enabled) {
  _debugEnabled = !!enabled;
}

/** Log a debug message when debug logging is enabled. */
export function debug(...args) {
  if ( _debugEnabled ) console.debug(`${MODULE_ID} |`, ...args);
}

/** Log a warning unconditionally. */
export function warn(...args) {
  console.warn(`${MODULE_ID} |`, ...args);
}
