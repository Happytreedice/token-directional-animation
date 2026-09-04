/**
 * Movement handling.
 *
 * Foundry v13/v14 animates multi-waypoint movement as a chain of Token#animate
 * calls, one per path segment, all sharing the token's movementAnimationName
 * and chained via {chain: true}. There is no per-segment hook, so this module
 * wraps Token.prototype.animate (through libWrapper when available) to:
 *
 *  1. Compute the octant of every queued segment at call time, using the
 *     movement origin (TokenDocument#movement.origin) for the first segment
 *     and the previously queued destination for each subsequent one.
 *  2. Apply the matching directional texture exactly when the segment starts —
 *     i.e. immediately for the first segment, and when the previous segment's
 *     animation promise settles for chained ones. This keeps facing in sync
 *     with per-waypoint movement without polling every frame.
 *  3. Detect the end of the whole chain (the last queued promise settling) and
 *     apply the configured idle behavior.
 *
 * The wrapper is a pure observer: it never alters the arguments or the return
 * value of Token#animate, and all module logic is wrapped in try/catch so a
 * failure can never break core token animation.
 */

import { MODULE_ID, octantFromDelta, debug, warn } from "./utils.mjs";
import * as manager from "./directional-manager.mjs";

/**
 * Per-token movement tracking, keyed by token id:
 * {tail: {x, y}, lastPromise: Promise|null, moving: boolean}
 * @type {Map<string, object>}
 */
const moveStates = new Map();

/* -------------------------------------------- */
/*  Patching Token#animate                      */
/* -------------------------------------------- */

let patched = false;

/**
 * Wrap Token.prototype.animate. Uses CONFIG.Token.objectClass so system
 * subclasses are covered; called at "setup" once the system has configured it.
 */
export function patchTokenAnimate() {
  if ( patched ) return;
  patched = true;
  if ( game.modules.get("lib-wrapper")?.active ) {
    libWrapper.register(MODULE_ID, "CONFIG.Token.objectClass.prototype.animate",
      function(wrapped, to, options={}) {
        return observedAnimate(this, wrapped, to, options);
      }, "WRAPPER");
    debug("Token#animate wrapped via libWrapper");
  }
  else {
    const proto = CONFIG.Token.objectClass.prototype;
    const original = proto.animate;
    proto.animate = function(to, options={}) {
      return observedAnimate(this, (t, o) => original.call(this, t, o), to, options);
    };
    debug("Token#animate wrapped directly");
  }
}

/**
 * The actual wrapper body: observe the segment, invoke core, then schedule
 * the texture change and end-of-movement handling.
 * @param {Token} token
 * @param {Function} invoke     Calls the original animate(to, options).
 * @param {object} to           Animation target data.
 * @param {object} options      Animation options.
 * @returns {Promise<void>}     Core's animation promise, untouched.
 */
function observedAnimate(token, invoke, to, options) {
  let segment = null;
  try {
    segment = beforeSegment(token, to, options);
  } catch(err) {
    warn("Segment analysis failed:", err);
  }
  const promise = invoke(to, options);
  if ( segment ) {
    try {
      afterSegment(token, promise, segment);
    } catch(err) {
      warn("Segment scheduling failed:", err);
    }
  } else {
    // Chained movement animation without position change (e.g. rotation at end of path)
    const movementName = token.movementAnimationName;
    if ( movementName !== undefined && options?.name === movementName ) {
      const state = moveStates.get(token.id);
      if ( state?.moving ) {
        state.lastPromise = promise;
        const settle = () => {
          if ( state.lastPromise !== promise ) return;
          state.moving = false;
          state.lastPromise = null;
          state.tail = null;
          onMovementEnd(token);
        };
        promise.then(settle, settle);
      }
    }
  }
  return promise;
}

/* -------------------------------------------- */

/**
 * Decide whether this animate call is a movement segment we should track and,
 * if so, compute its direction and the gate promise that marks its start.
 * @param {Token} token
 * @param {object} to
 * @param {object} options
 * @returns {{direction: string|null, gate: Promise|null}|null}
 */
function beforeSegment(token, to, options) {
  if ( typeof to?.x !== "number" && typeof to?.y !== "number" ) return null;

  // In v13/v14 movement segments are the animate calls named movementAnimationName;
  // anything else (module effects, rotation-only animations) is ignored. On v12
  // there is no such name, so any positional animation is treated as movement.
  const movementName = token.movementAnimationName;
  if ( movementName !== undefined && options?.name !== movementName ) return null;

  if ( !manager.isCandidate(token.document) ) return null;
  manager.preloadFor(token.document); // async, cached — warm up textures ASAP

  let state = moveStates.get(token.id);
  if ( !state ) moveStates.set(token.id, state = { tail: null, lastPromise: null, moving: false });

  const from = state.moving && state.tail
    ? state.tail
    : segmentOrigin(token);
  const target = { x: to.x ?? from.x, y: to.y ?? from.y };
  const direction = octantFromDelta(target.x - from.x, target.y - from.y);
  const gate = state.moving ? state.lastPromise : null;
  state.tail = target;
  state.moving = true;
  return { direction, gate };
}

/**
 * Best-effort origin of the first segment of a movement chain.
 * Prefers the document's live movement data (v13+), then the on-screen mesh
 * position, then the document position.
 * @param {Token} token
 * @returns {{x: number, y: number}}
 */
function segmentOrigin(token) {
  const origin = token.document.movement?.origin;
  if ( origin && typeof origin.x === "number" ) return { x: origin.x, y: origin.y };
  if ( token.mesh && !token.mesh.destroyed ) {
    return { x: token.mesh.position.x - token.w / 2, y: token.mesh.position.y - token.h / 2 };
  }
  return { x: token.document.x, y: token.document.y };
}

/**
 * Schedule the texture change at segment start and idle handling at chain end.
 * @param {Token} token
 * @param {Promise} promise   Core's promise for this segment (settles at segment end).
 * @param {{direction: string|null, gate: Promise|null}} segment
 */
function afterSegment(token, promise, segment) {
  const state = moveStates.get(token.id);
  if ( !state ) return;
  state.lastPromise = promise;

  if ( segment.direction ) {
    const start = () => {
      // Skip if the movement was stopped/superseded before this segment began.
      if ( state.moving && state.lastPromise ) {
        manager.applyDirection(token, segment.direction).catch(err => warn("applyDirection failed:", err));
      }
    };
    if ( segment.gate ) segment.gate.then(start, () => {});
    else start();
  }

  const settle = () => {
    // Only the promise that is still the tail marks the end of the whole chain.
    if ( state.lastPromise !== promise ) return;
    state.moving = false;
    state.lastPromise = null;
    state.tail = null;
    onMovementEnd(token);
  };
  promise.then(settle, settle);
}

/* -------------------------------------------- */
/*  Lifecycle                                   */
/* -------------------------------------------- */

/**
 * The full movement chain has finished animating: apply idle behavior, unless
 * the document reports more pending movement (a paused multi-step move that
 * will resume keeps its current facing).
 * @param {Token} token
 */
function onMovementEnd(token) {
  if ( token.destroyed ) return;
  const movement = token.document?.movement;
  if ( movement && movement.state === "paused" ) return;
  debug(`Movement ended for "${token.document?.name}"`);
  manager.applyIdle(token).catch(err => warn("applyIdle failed:", err));
}

/** Register all movement-related hooks. Called once at init. */
export function registerMovementHooks() {

  // Movement explicitly stopped: settle to idle immediately.
  Hooks.on("stopToken", tokenDoc => {
    const token = tokenDoc.object;
    if ( !token ) return;
    const state = moveStates.get(token.id);
    if ( state ) {
      state.moving = false;
      state.lastPromise = null;
      state.tail = null;
    }
    manager.applyIdle(token).catch(err => warn("applyIdle failed:", err));
  });

  // Preload directional textures as soon as a movement is initiated, before
  // the first animation frame renders.
  Hooks.on("preMoveToken", tokenDoc => {
    if ( manager.isCandidate(tokenDoc) ) manager.preloadFor(tokenDoc);
  });

  // Re-apply our texture after full redraws, and keep the mirror flip asserted
  // after every core refresh pass.
  Hooks.on("drawToken", token => manager.handleDraw(token));
  Hooks.on("refreshToken", token => manager.handleRefresh(token));

  // Configuration or artwork changes invalidate cached profiles; disabling the
  // module on a token restores its document texture.
  Hooks.on("updateToken", (tokenDoc, changes) => {
    const flagsChanged = foundry.utils.hasProperty(changes, `flags.${MODULE_ID}`);
    const textureChanged = foundry.utils.hasProperty(changes, "texture.src");
    if ( !flagsChanged && !textureChanged ) return;
    manager.invalidate(tokenDoc);
    const token = tokenDoc.object;
    if ( token && !manager.isCandidate(tokenDoc) ) {
      manager.restoreDefault(token).catch(() => {});
    }
    else if ( tokenDoc.rendered && manager.isCandidate(tokenDoc) ) {
      manager.preloadFor(tokenDoc);
    }
  });

  // State cleanup.
  Hooks.on("deleteToken", tokenDoc => {
    moveStates.delete(tokenDoc.id);
    manager.clearState(tokenDoc.id);
  });
  Hooks.on("canvasTearDown", () => {
    moveStates.clear();
    manager.clearAllStates();
  });

  // Preload every candidate token's textures when a scene becomes active.
  Hooks.on("canvasReady", () => {
    manager.preloadScene().catch(err => warn("Scene preload failed:", err));
  });
}
