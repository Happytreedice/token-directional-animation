/**
 * Token Configuration UI integration.
 *
 * Injects a "Directions" tab into the v13/v14 ApplicationV2 Token Configuration
 * sheet (both TokenConfig and PrototypeTokenConfig), with a graceful fallback
 * that appends the fields to the Appearance tab on older AppV1 sheets (v12).
 *
 * All fields are stored as token flags under `flags.token-directional-animation.*`
 * and are picked up automatically by the sheet's normal form submission.
 */

import { MODULE_ID, FLAGS, IDLE_BEHAVIOR } from "./utils.mjs";

/** Register the render hooks for every flavor of token configuration sheet. */
export function registerTokenConfigHooks() {
  for ( const hook of ["renderTokenConfig", "renderPrototypeTokenConfig", "renderTokenConfigPF2e"] ) {
    Hooks.on(hook, onRenderTokenConfig);
  }
}

/* -------------------------------------------- */

/**
 * Handle rendering of a token configuration sheet.
 * @param {Application|ApplicationV2} app
 * @param {HTMLElement|jQuery} html  HTMLElement on AppV2, jQuery on AppV1.
 */
function onRenderTokenConfig(app, html) {
  const root = html instanceof HTMLElement ? html : html[0];
  if ( !root || root.querySelector(".tda-tab, .tda-fields") ) return; // already injected

  const doc = app.token ?? app.document ?? app.object;
  if ( !doc ) return;

  const content = buildFieldsHTML(doc);
  const injectedAsTab = tryInjectTab(root, content);
  if ( !injectedAsTab ) injectIntoAppearance(root, content);
  activateListeners(root);
  if ( app.setPosition instanceof Function ) app.setPosition({ height: "auto" });
}

/* -------------------------------------------- */

/**
 * Inject a dedicated tab into an ApplicationV2 sheet using the "sheet" tab group.
 * @param {HTMLElement} root
 * @param {string} content  Inner HTML for the tab body.
 * @returns {boolean}       Whether tab injection succeeded.
 */
function tryInjectTab(root, content) {
  const nav = root.querySelector('nav.tabs[data-group="sheet"], nav.sheet-tabs[data-group="sheet"]')
    ?? root.querySelector("nav.tabs");
  const anyTab = root.querySelector('section.tab[data-group="sheet"], div.tab[data-group="sheet"]');
  if ( !nav || !anyTab ) return false;
  const group = anyTab.dataset.group ?? "sheet";

  // Navigation entry, matching the markup of the sheet's existing tab buttons.
  const sample = nav.querySelector("[data-tab]");
  const navItem = document.createElement(sample?.tagName.toLowerCase() === "a" ? "a" : "button");
  if ( navItem.tagName === "BUTTON" ) navItem.type = "button";
  navItem.className = sample?.className.replace(/\bactive\b/, "").trim() ?? "";
  navItem.dataset.action = "tab";
  navItem.dataset.group = group;
  navItem.dataset.tab = "tda";
  navItem.innerHTML = `<i class="fa-solid fa-compass"></i> <span>${game.i18n.localize("TDA.TokenConfig.TabLabel")}</span>`;
  nav.appendChild(navItem);

  // Tab body, inserted before the footer so the sheet buttons stay last.
  const section = document.createElement(anyTab.tagName.toLowerCase());
  section.className = "tab tda-tab standard-form scrollable";
  section.dataset.group = group;
  section.dataset.tab = "tda";
  section.innerHTML = content;
  const footer = root.querySelector("footer.form-footer");
  const parent = anyTab.parentElement;
  if ( footer && footer.parentElement === parent ) parent.insertBefore(section, footer);
  else parent.appendChild(section);
  return true;
}

/* -------------------------------------------- */

/**
 * Fallback for AppV1 sheets: append the fields to the Appearance tab.
 * @param {HTMLElement} root
 * @param {string} content
 */
function injectIntoAppearance(root, content) {
  const target = root.querySelector('.tab[data-tab="appearance"]')
    ?? root.querySelector("form .tab")
    ?? root.querySelector("form");
  if ( !target ) return;
  const wrapper = document.createElement("div");
  wrapper.className = "tda-fields tda-tab";
  wrapper.innerHTML = content;
  target.appendChild(wrapper);
}

/* -------------------------------------------- */

/**
 * Build the inner HTML of the configuration fields for a token document.
 * @param {TokenDocument|PrototypeToken} doc
 * @returns {string}
 */
function buildFieldsHTML(doc) {
  const loc = k => game.i18n.localize(k);
  const flags = foundry.utils.getProperty(doc, `flags.${MODULE_ID}`) ?? {};
  const enabled = flags[FLAGS.ENABLED] ?? false;
  const source = flags[FLAGS.SOURCE] ?? "";
  const idleBehavior = flags[FLAGS.IDLE_BEHAVIOR] ?? "";
  const idleSource = flags[FLAGS.IDLE_SOURCE] ?? "";
  const mirror = flags[FLAGS.MIRROR] ?? "";
  const f = key => `flags.${MODULE_ID}.${key}`;

  const idleOptions = [
    ["", loc("TDA.TokenConfig.IdleBehavior.Global")],
    [IDLE_BEHAVIOR.DEFAULT, loc("TDA.IdleBehavior.Default")],
    [IDLE_BEHAVIOR.KEEP, loc("TDA.IdleBehavior.KeepLast")],
    [IDLE_BEHAVIOR.CUSTOM, loc("TDA.IdleBehavior.Custom")]
  ];
  const mirrorOptions = [
    ["", loc("TDA.TokenConfig.Mirror.Global")],
    ["yes", loc("TDA.TokenConfig.Mirror.Yes")],
    ["no", loc("TDA.TokenConfig.Mirror.No")]
  ];
  const options = (list, current) => list.map(([v, l]) =>
    `<option value="${v}" ${v === current ? "selected" : ""}>${l}</option>`).join("");

  return `
  <fieldset>
    <legend>${loc("TDA.TokenConfig.LegendMain")}</legend>
    <div class="form-group">
      <label>${loc("TDA.TokenConfig.Enabled.Label")}</label>
      <div class="form-fields">
        <input type="checkbox" name="${f(FLAGS.ENABLED)}" ${enabled ? "checked" : ""}>
      </div>
      <p class="hint">${loc("TDA.TokenConfig.Enabled.Hint")}</p>
    </div>
    <div class="form-group">
      <label>${loc("TDA.TokenConfig.Source.Label")}</label>
      <div class="form-fields tda-source-row">
        ${filePickerHTML(f(FLAGS.SOURCE), source, "any", loc("TDA.TokenConfig.Source.Placeholder"))}
      </div>
      <p class="hint">${loc("TDA.TokenConfig.Source.Hint")}</p>
    </div>
    <div class="form-group">
      <label>${loc("TDA.TokenConfig.Mirror.Label")}</label>
      <div class="form-fields">
        <select name="${f(FLAGS.MIRROR)}">${options(mirrorOptions, mirror)}</select>
      </div>
      <p class="hint">${loc("TDA.TokenConfig.Mirror.Hint")}</p>
    </div>
  </fieldset>
  <fieldset>
    <legend>${loc("TDA.TokenConfig.LegendIdle")}</legend>
    <div class="form-group">
      <label>${loc("TDA.TokenConfig.IdleBehavior.Label")}</label>
      <div class="form-fields">
        <select name="${f(FLAGS.IDLE_BEHAVIOR)}" class="tda-idle-behavior">${options(idleOptions, idleBehavior)}</select>
      </div>
      <p class="hint">${loc("TDA.TokenConfig.IdleBehavior.Hint")}</p>
    </div>
    <div class="form-group tda-idle-source" ${idleBehavior === IDLE_BEHAVIOR.CUSTOM ? "" : "hidden"}>
      <label>${loc("TDA.TokenConfig.IdleSource.Label")}</label>
      <div class="form-fields tda-source-row">
        ${filePickerHTML(f(FLAGS.IDLE_SOURCE), idleSource, "imagevideo", "")}
      </div>
      <p class="hint">${loc("TDA.TokenConfig.IdleSource.Hint")}</p>
    </div>
  </fieldset>`;
}

/* -------------------------------------------- */

/**
 * Produce a file-picker input. Uses the <file-picker> custom element when the
 * client provides it (v12.331+/v13+), otherwise a plain text input.
 * @param {string} name         Form field name.
 * @param {string} value        Current value.
 * @param {string} type         FilePicker type category.
 * @param {string} placeholder  Placeholder text.
 * @returns {string}
 */
function filePickerHTML(name, value, type, placeholder) {
  const esc = foundry.utils.escapeHTML ?? (s => s);
  const v = esc(value ?? "");
  const p = esc(placeholder ?? "");
  if ( customElements.get("file-picker") ) {
    return `<file-picker name="${name}" value="${v}" type="${type}" placeholder="${p}"></file-picker>`;
  }
  return `<input type="text" name="${name}" value="${v}" placeholder="${p}">`;
}

/* -------------------------------------------- */

/**
 * Wire up dynamic behavior: reveal the idle texture picker only when the idle
 * behavior is set to "custom".
 * @param {HTMLElement} root
 */
function activateListeners(root) {
  const behavior = root.querySelector(".tda-idle-behavior");
  const idleGroup = root.querySelector(".tda-idle-source");
  if ( !behavior || !idleGroup ) return;
  behavior.addEventListener("change", () => {
    idleGroup.hidden = behavior.value !== IDLE_BEHAVIOR.CUSTOM;
  });
}
