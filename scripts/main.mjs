/**
 * Token Directional Animation — module entry point.
 *
 * Wires up world settings, the Token Configuration UI, the Token#animate
 * wrapper and all lifecycle hooks, and exposes a small public API on the
 * module object for macros and other modules.
 */

import { MODULE_ID, SETTINGS, IDLE_BEHAVIOR, octantFromDelta, setDebug, debug } from "./utils.mjs";
import { registerTokenConfigHooks } from "./token-config.mjs";
import { patchTokenAnimate, registerMovementHooks } from "./movement-handler.mjs";
import * as manager from "./directional-manager.mjs";

/* -------------------------------------------- */
/*  Settings                                    */
/* -------------------------------------------- */

function registerSettings() {
  game.settings.register(MODULE_ID, SETTINGS.ENABLED, {
    name: "TDA.Settings.Enabled.Name",
    hint: "TDA.Settings.Enabled.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, SETTINGS.AUTO_DETECT, {
    name: "TDA.Settings.AutoDetect.Name",
    hint: "TDA.Settings.AutoDetect.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, SETTINGS.DEFAULT_IDLE_BEHAVIOR, {
    name: "TDA.Settings.DefaultIdleBehavior.Name",
    hint: "TDA.Settings.DefaultIdleBehavior.Hint",
    scope: "world",
    config: true,
    type: String,
    choices: {
      [IDLE_BEHAVIOR.DEFAULT]: "TDA.IdleBehavior.Default",
      [IDLE_BEHAVIOR.KEEP]: "TDA.IdleBehavior.KeepLast",
      [IDLE_BEHAVIOR.CUSTOM]: "TDA.IdleBehavior.Custom"
    },
    default: IDLE_BEHAVIOR.DEFAULT
  });

  game.settings.register(MODULE_ID, SETTINGS.DEFAULT_MIRROR, {
    name: "TDA.Settings.DefaultMirror.Name",
    hint: "TDA.Settings.DefaultMirror.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, SETTINGS.PRELOAD_ALL, {
    name: "TDA.Settings.PreloadAll.Name",
    hint: "TDA.Settings.PreloadAll.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, SETTINGS.DEBUG, {
    name: "TDA.Settings.DebugLogging.Name",
    hint: "TDA.Settings.DebugLogging.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
    onChange: setDebug
  });
}

/* -------------------------------------------- */
/*  Bootstrap                                   */
/* -------------------------------------------- */

Hooks.once("init", () => {
  registerSettings();
  registerTokenConfigHooks();
  registerMovementHooks();
  console.log(`${MODULE_ID} | Initialized`);
});

// Patch at setup so the system's CONFIG.Token.objectClass override (if any)
// is already in place and gets wrapped too.
Hooks.once("setup", () => {
  patchTokenAnimate();
  setDebug(game.settings.get(MODULE_ID, SETTINGS.DEBUG));
});

Hooks.once("ready", () => {
  // Public API for macros and other modules.
  const module = game.modules.get(MODULE_ID);
  module.api = {
    /** Compute the octant (N/NE/E/SE/S/SW/W/NW) of a movement delta. */
    octantFromDelta,
    /** Resolve the directional profile of a TokenDocument. */
    getProfile: manager.getProfile,
    /** Force a token to face a direction, e.g. api.face(token, "NE"). */
    face: manager.applyDirection,
    /** Apply the token's configured idle behavior. */
    idle: manager.applyIdle,
    /** Restore the token's document texture and release control. */
    reset: manager.restoreDefault,
    /** Preload directional textures for a TokenDocument. */
    preload: manager.preloadFor
  };
  debug("Ready");
});
