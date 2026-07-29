// vehicle-combat.js: Send vehicle crew members to combat instead of the vehicle.

const MODULE_ID = "full-speed-ahead";
const CREW_COMBATANT_FLAG = "crewCombatant";
const VEHICLE_COMBAT_OWNERSHIP_FLAG = "vehicleCombatOwnership";
const DEFAULT_SHIP_BADGE = "icons/svg/wing.svg";
const DEFAULT_SILHOUETTE = "icons/svg/mystery-man.svg";
const SHIELD_FILTER_ID = "fullSpeedAheadVehicleShield";
const MORPHOGENETIC_FILTER_ID = "fullSpeedAheadMorphogeneticField";
const VEHICLE_COMBAT_DISPLAY_MODES = {
    FULL: "full",
    SIMPLE: "simple"
};
const VEHICLE_PROTECTION_VISUAL_MODES = {
    BUILT_IN: "built-in",
    TOKEN_MAGIC: "token-magic",
    BOTH: "both"
};
const SHIELD_COLORS = {
    A: { primary: 0xe60000, secondary: 0xff5050 },
    B: { primary: 0x5099dd, secondary: 0x90eeff },
    C: { primary: 0x00cc66, secondary: 0x99ff33 },
    D: { primary: 0xffff00, secondary: 0xffff99 },
    PRISMATIC: { primary: 0x9999ff, secondary: 0xff00ff }
};
const MORPHOGENETIC_COLORS = { primary: 0xffffff, secondary: 0x99ddff };
const VEHICLE_CREW_PATHS = [
    "system.cargo.crew",
    "system.details.crew",
    "system.traits.crew"
];
const processingCombatants = new Set();
const activeProtectionEffects = new Map();
let protectionTicker = null;

class FullSpeedAheadVehicleCombatConfig extends FormApplication {
    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "full-speed-ahead-vehicle-combat-config",
            title: "Full Speed Ahead: Vehicle Combat Settings",
            template: `modules/${MODULE_ID}/templates/vehicle-combat-settings.hbs`,
            width: 560,
            closeOnSubmit: true
        });
    }

    getData() {
        return {
            vehicleCombatCrewMode: game.settings.get(MODULE_ID, "vehicleCombatCrewMode"),
            vehicleCombatDisplayMode: game.settings.get(MODULE_ID, "vehicleCombatDisplayMode"),
            vehicleCombatShipIcon: game.settings.get(MODULE_ID, "vehicleCombatShipIcon"),
            vehicleShieldAutomation: game.settings.get(MODULE_ID, "vehicleShieldAutomation"),
            vehicleProtectionVisualMode: game.settings.get(MODULE_ID, "vehicleProtectionVisualMode"),
            vehicleCombatDebug: game.settings.get(MODULE_ID, "vehicleCombatDebug"),
            displayModes: [
                {
                    value: VEHICLE_COMBAT_DISPLAY_MODES.FULL,
                    label: "Full Combat Order",
                    selected: game.settings.get(MODULE_ID, "vehicleCombatDisplayMode") === VEHICLE_COMBAT_DISPLAY_MODES.FULL
                },
                {
                    value: VEHICLE_COMBAT_DISPLAY_MODES.SIMPLE,
                    label: "Simple Combat Order",
                    selected: game.settings.get(MODULE_ID, "vehicleCombatDisplayMode") === VEHICLE_COMBAT_DISPLAY_MODES.SIMPLE
                }
            ],
            protectionVisualModes: [
                {
                    value: VEHICLE_PROTECTION_VISUAL_MODES.BUILT_IN,
                    label: "Built-In FSA Glow",
                    selected: game.settings.get(MODULE_ID, "vehicleProtectionVisualMode") === VEHICLE_PROTECTION_VISUAL_MODES.BUILT_IN
                },
                {
                    value: VEHICLE_PROTECTION_VISUAL_MODES.TOKEN_MAGIC,
                    label: "TokenMagic FX",
                    selected: game.settings.get(MODULE_ID, "vehicleProtectionVisualMode") === VEHICLE_PROTECTION_VISUAL_MODES.TOKEN_MAGIC
                },
                {
                    value: VEHICLE_PROTECTION_VISUAL_MODES.BOTH,
                    label: "Built-In + TokenMagic",
                    selected: game.settings.get(MODULE_ID, "vehicleProtectionVisualMode") === VEHICLE_PROTECTION_VISUAL_MODES.BOTH
                }
            ]
        };
    }

    activateListeners(html) {
        super.activateListeners(html);

        html.find('[data-action="browse-ship-icon"]').on("click", event => {
            event.preventDefault();
            const input = html.find('[name="vehicleCombatShipIcon"]');
            new FilePicker({
                type: "image",
                current: input.val() || "",
                callback: path => input.val(path).trigger("input")
            }).render(true);
        });
    }

    async _updateObject(event, formData) {
        await game.settings.set(MODULE_ID, "vehicleCombatCrewMode", Boolean(formData.vehicleCombatCrewMode));
        await game.settings.set(MODULE_ID, "vehicleCombatDisplayMode", String(formData.vehicleCombatDisplayMode || VEHICLE_COMBAT_DISPLAY_MODES.FULL));
        await game.settings.set(MODULE_ID, "vehicleCombatShipIcon", String(formData.vehicleCombatShipIcon || DEFAULT_SHIP_BADGE).trim());
        await game.settings.set(MODULE_ID, "vehicleShieldAutomation", Boolean(formData.vehicleShieldAutomation));
        await game.settings.set(MODULE_ID, "vehicleProtectionVisualMode", getValidProtectionVisualMode(formData.vehicleProtectionVisualMode));
        await game.settings.set(MODULE_ID, "vehicleCombatDebug", Boolean(formData.vehicleCombatDebug));
        ui.combat?.render(true);
        if (game.settings.get(MODULE_ID, "vehicleCombatCrewMode")) syncActiveVehicleCombat();
        syncVehicleShields();
    }
}

Hooks.once("init", () => {
    game.settings.registerMenu(MODULE_ID, "vehicleCombatConfig", {
        name: "Vehicle Combat Settings",
        label: "Open Vehicle Combat Settings",
        hint: "Configure whether vehicle combat sends crew members to the combat tracker instead of the vehicle.",
        icon: "fas fa-users-cog",
        type: FullSpeedAheadVehicleCombatConfig,
        restricted: true
    });

    registerVehicleCombatSetting("vehicleCombatCrewMode", {
        name: "Vehicles Send Crew to Combat rather than the Vehicle",
        hint: "When a vehicle token is added to combat, replace its combatant with combatants for the matching crew listed on the vehicle sheet.",
        type: Boolean,
        default: false,
        config: false,
        onChange: enabled => {
            ui.combat?.render(true);
            if (enabled) syncActiveVehicleCombat();
        }
    });

    registerVehicleCombatSetting("vehicleCombatDisplayMode", {
        name: "Vehicle Combat Display Mode",
        hint: "Full shows vessel and character portraits plus Vessel / Character names. Simple shows a ship badge on the crew portrait.",
        type: String,
        choices: {
            [VEHICLE_COMBAT_DISPLAY_MODES.FULL]: "Full Combat Order",
            [VEHICLE_COMBAT_DISPLAY_MODES.SIMPLE]: "Simple Combat Order"
        },
        default: VEHICLE_COMBAT_DISPLAY_MODES.FULL,
        config: false,
        onChange: () => ui.combat?.render(true)
    });

    registerVehicleCombatSetting("vehicleCombatShipIcon", {
        name: "Vehicle Combat Ship Badge Icon",
        hint: "Image used as the ship badge on crew portraits.",
        type: String,
        default: DEFAULT_SHIP_BADGE,
        config: false,
        onChange: () => ui.combat?.render(true)
    });

    registerVehicleCombatSetting("vehicleShieldAutomation", {
        name: "Automatically Manage Vehicle Shields",
        hint: "Use Shield Generator equipment HP and Morphogenetic Field equipment to turn vehicle protection visuals on or off.",
        type: Boolean,
        default: false,
        config: false,
        onChange: syncVehicleShields
    });

    registerVehicleCombatSetting("vehicleProtectionVisualMode", {
        name: "Vehicle Protection Visual Mode",
        hint: "Choose Full Speed Ahead's built-in glow, TokenMagic FX support, or both for shield and Morphogenetic Field visuals.",
        type: String,
        choices: {
            [VEHICLE_PROTECTION_VISUAL_MODES.BUILT_IN]: "Built-In FSA Glow",
            [VEHICLE_PROTECTION_VISUAL_MODES.TOKEN_MAGIC]: "TokenMagic FX",
            [VEHICLE_PROTECTION_VISUAL_MODES.BOTH]: "Built-In + TokenMagic"
        },
        default: VEHICLE_PROTECTION_VISUAL_MODES.BUILT_IN,
        config: false,
        onChange: syncVehicleShields
    });

    registerVehicleCombatSetting("vehicleCombatDebug", {
        name: "Vehicle Combat Debug Logging",
        hint: "Write vehicle combat diagnostic messages to the browser console.",
        type: Boolean,
        default: false,
        config: false
    });
});

Hooks.once("ready", () => {
    syncActiveVehicleCombat();
    syncVehicleShields();
});
Hooks.on("canvasReady", () => {
    stopAllProtectionEffects();
    syncVehicleShields();
});
Hooks.on("createCombatant", combatant => replaceVehicleCombatantWithCrew(combatant));
Hooks.on("renderCombatTracker", (app, html) => renderVehicleCrewTracker(app, html));
Hooks.on("deleteCombat", combat => restoreVehicleCombatOwnership(combat));
Hooks.on("drawToken", token => syncVehicleShieldForToken(token));
Hooks.on("updateToken", tokenDocument => {
    const token = canvas.tokens?.get(tokenDocument.id);
    if (token) syncVehicleShieldForToken(token);
});
Hooks.on("deleteToken", tokenDocument => stopProtectionEffectForToken(tokenDocument.id));
Hooks.on("updateActor", actor => syncVehicleShieldsForActor(actor));
Hooks.on("createItem", item => syncVehicleShieldsForItem(item));
Hooks.on("updateItem", item => syncVehicleShieldsForItem(item));
Hooks.on("deleteItem", item => syncVehicleShieldsForItem(item));

function registerVehicleCombatSetting(key, data) {
    game.settings.register(MODULE_ID, key, {
        scope: "world",
        config: true,
        ...data
    });
}

function isVehicleCombatEnabled() {
    return Boolean(game.settings.get(MODULE_ID, "vehicleCombatCrewMode"));
}

function isVehicleShieldAutomationEnabled() {
    return Boolean(game.settings.get(MODULE_ID, "vehicleShieldAutomation"));
}

function canManageVehicleShields() {
    return canvas?.ready && isVehicleShieldAutomationEnabled();
}

async function syncVehicleShields() {
    if (!canvas?.ready || !canvas.tokens) return;

    if (!isVehicleShieldAutomationEnabled()) {
        await Promise.all((canvas.tokens.placeables ?? []).map(token => removeVehicleProtectionVisuals(token)));
        stopAllProtectionEffects();
        return;
    }

    await Promise.all((canvas.tokens.placeables ?? []).map(token => syncVehicleShieldForToken(token)));
}

async function syncVehicleShieldsForActor(actor) {
    if (!canManageVehicleShields() || !isVehicleActor(actor)) return;
    const tokens = (canvas.tokens?.placeables ?? []).filter(token => token.actor?.id === actor.id);
    await Promise.all(tokens.map(token => syncVehicleShieldForToken(token)));
}

async function syncVehicleShieldsForItem(item) {
    const actor = item?.parent;
    if (isVehicleActor(actor) && isVehicleShieldRelevantItem(item)) await syncVehicleShieldsForActor(actor);
}

async function syncVehicleShieldForToken(token) {
    if (!canManageVehicleShields()) return;
    if (!token?.actor || !isVehicleActor(token.actor) || token.document?.hidden) {
        await removeVehicleProtectionVisuals(token);
        return;
    }

    const protection = getVehicleProtectionStatus(token.actor);
    if (!protection.shield.online && !protection.morphogenetic.online) {
        await removeVehicleProtectionVisuals(token);
        return;
    }

    syncBuiltInProtectionEffect(token, protection);
    await syncTokenMagicProtectionEffects(token, protection);
}

function getVehicleProtectionStatus(actor) {
    return {
        shield: getVehicleShieldStatus(actor),
        morphogenetic: getVehicleMorphogeneticStatus(actor)
    };
}

function getVehicleShieldStatus(actor) {
    const shieldModule = findVehicleShieldGenerator(actor);
    if (!shieldModule) return { online: false, reason: "missing" };

    const type = getBracketedModuleType(shieldModule.name);
    const { hp } = getItemHpInfo(shieldModule);
    if (!type || !SHIELD_COLORS[type]) return { online: false, reason: "invalid-type", hp, type };
    return { online: hp > 0, hp, type };
}

function getVehicleMorphogeneticStatus(actor) {
    const morphogeneticModule = findVehicleMorphogeneticField(actor);
    if (!morphogeneticModule) return { online: false, reason: "missing" };

    const { hp, hasHp } = getItemHpInfo(morphogeneticModule);
    return { online: hasHp ? hp > 0 : true, hp, hasHp };
}

function findVehicleShieldGenerator(actor) {
    return Array.from(actor?.items ?? []).find(item => isVehicleShieldItem(item));
}

function findVehicleMorphogeneticField(actor) {
    return Array.from(actor?.items ?? []).find(item => isVehicleMorphogeneticItem(item));
}

function isVehicleShieldRelevantItem(item) {
    return isVehicleShieldItem(item) || isVehicleMorphogeneticItem(item);
}

function isVehicleShieldItem(item) {
    return item?.type === "equipment" && /shield generator/i.test(item.name ?? "");
}

function isVehicleMorphogeneticItem(item) {
    return item?.type === "equipment" && /morphogenetic field/i.test(item.name ?? "");
}

function getBracketedModuleType(name) {
    const match = String(name ?? "").match(/\[([^\]]+)\]/);
    return match?.[1]?.trim().toLocaleUpperCase() ?? null;
}

function getItemHpInfo(item) {
    const candidates = [
        "system.hp.value",
        "system.hp",
        "data.data.hp.value",
        "data.data.hp"
    ];

    for (const path of candidates) {
        const value = foundry.utils.getProperty(item, path);
        if (typeof value === "object" && value !== null) {
            const nested = Number(value.value ?? value.current ?? value.hp);
            if (Number.isFinite(nested)) return { hp: nested, hasHp: true };
            continue;
        }

        const numeric = Number(value);
        if (Number.isFinite(numeric)) return { hp: numeric, hasHp: true };
    }

    return { hp: 0, hasHp: false };
}

function syncBuiltInProtectionEffect(token, protection) {
    if (!shouldUseBuiltInProtectionVisuals()) {
        stopProtectionEffectForToken(token.id);
        return;
    }

    const state = getOrCreateProtectionEffect(token);
    if (!state) return;

    state.protection = protection;
    drawProtectionEffect(state, performance.now());
    ensureProtectionTicker();
}

function getOrCreateProtectionEffect(token) {
    const existing = activeProtectionEffects.get(token.id);
    if (existing && !existing.graphics.destroyed) {
        existing.token = token;
        return existing;
    }

    const graphics = new PIXI.Graphics();
    graphics.blendMode = PIXI.BLEND_MODES.ADD;
    graphics.eventMode = "none";
    graphics.interactive = false;
    graphics.zIndex = getTokenSortValue(token) + 1;

    const layer = canvas.primary ?? canvas.effects ?? canvas.tokens;
    layer.sortableChildren = true;
    layer.addChild(graphics);

    const state = {
        token,
        graphics,
        protection: null,
        phase: getProtectionEffectPhase(token.id)
    };
    activeProtectionEffects.set(token.id, state);
    return state;
}

function ensureProtectionTicker() {
    if (protectionTicker || !canvas?.app?.ticker) return;
    protectionTicker = () => updateProtectionEffects();
    canvas.app.ticker.add(protectionTicker);
}

function updateProtectionEffects() {
    if (!canvas?.ready || !isVehicleShieldAutomationEnabled() || !shouldUseBuiltInProtectionVisuals()) {
        stopAllProtectionEffects();
        return;
    }

    const now = performance.now();
    for (const [tokenId, state] of activeProtectionEffects) {
        const token = canvas.tokens?.get(tokenId);
        if (!token || token.document?.hidden || !isVehicleActor(token.actor)) {
            stopProtectionEffectForToken(tokenId);
            continue;
        }

        state.token = token;
        drawProtectionEffect(state, now);
    }

    if (!activeProtectionEffects.size) stopProtectionTicker();
}

function drawProtectionEffect(state, now) {
    const { token, graphics, protection } = state;
    if (!token || !graphics || graphics.destroyed || !protection) return;

    const shieldOnline = protection.shield.online;
    const morphOnline = protection.morphogenetic.online;
    if (!shieldOnline && !morphOnline) {
        stopProtectionEffectForToken(token.id);
        return;
    }

    const pulse = (Math.sin((now / 900) + state.phase) + 1) / 2;
    const centerX = token.x + token.w / 2;
    const centerY = token.y + token.h / 2;
    const radiusX = Math.max(token.w, canvas.grid?.size ?? 100) * (0.54 + pulse * 0.025);
    const radiusY = Math.max(token.h, canvas.grid?.size ?? 100) * (0.54 + pulse * 0.025);

    graphics.clear();
    graphics.zIndex = getTokenSortValue(token) + 1;

    if (shieldOnline) {
        const colors = SHIELD_COLORS[protection.shield.type] ?? SHIELD_COLORS.B;
        drawGlowEllipse(graphics, centerX, centerY, radiusX, radiusY, colors.primary, colors.secondary, 0.34 + pulse * 0.18);
    }

    if (morphOnline) {
        const morphPulse = (Math.sin((now / 520) + state.phase * 1.7) + 1) / 2;
        drawGlowEllipse(graphics, centerX, centerY, radiusX * 1.08, radiusY * 1.08, MORPHOGENETIC_COLORS.primary, MORPHOGENETIC_COLORS.secondary, 0.22 + morphPulse * 0.14, true);
    }
}

function drawGlowEllipse(graphics, centerX, centerY, radiusX, radiusY, primary, secondary, alpha, broken = false) {
    graphics.lineStyle(12, secondary, alpha * 0.18);
    graphics.drawEllipse(centerX, centerY, radiusX, radiusY);
    graphics.lineStyle(6, primary, alpha * 0.36);
    graphics.drawEllipse(centerX, centerY, radiusX * 0.99, radiusY * 0.99);
    graphics.lineStyle(2, secondary, Math.min(0.9, alpha + 0.18));

    if (!broken) {
        graphics.drawEllipse(centerX, centerY, radiusX * 0.985, radiusY * 0.985);
        return;
    }

    const segments = 16;
    for (let index = 0; index < segments; index += 2) {
        const start = (index / segments) * Math.PI * 2;
        const end = ((index + 1.15) / segments) * Math.PI * 2;
        drawEllipseArc(graphics, centerX, centerY, radiusX * 0.985, radiusY * 0.985, start, end);
    }
}

function drawEllipseArc(graphics, centerX, centerY, radiusX, radiusY, start, end) {
    const steps = 8;
    for (let step = 0; step <= steps; step++) {
        const angle = start + (end - start) * (step / steps);
        const x = centerX + Math.cos(angle) * radiusX;
        const y = centerY + Math.sin(angle) * radiusY;
        if (step === 0) graphics.moveTo(x, y);
        else graphics.lineTo(x, y);
    }
}

function stopProtectionEffectForToken(tokenId) {
    const state = activeProtectionEffects.get(tokenId);
    if (!state) return;
    state.graphics.destroy({ children: true });
    activeProtectionEffects.delete(tokenId);
    if (!activeProtectionEffects.size) stopProtectionTicker();
}

function stopAllProtectionEffects() {
    for (const tokenId of Array.from(activeProtectionEffects.keys())) {
        stopProtectionEffectForToken(tokenId);
    }
    stopProtectionTicker();
}

function stopProtectionTicker() {
    if (!protectionTicker || !canvas?.app?.ticker) return;
    canvas.app.ticker.remove(protectionTicker);
    protectionTicker = null;
}

function getProtectionEffectPhase(tokenId) {
    const seed = String(tokenId ?? "").split("").reduce((total, character) => total + character.charCodeAt(0), 0);
    return (seed % 628) / 100;
}

async function syncTokenMagicProtectionEffects(token, protection) {
    if (!shouldUseTokenMagicProtectionVisuals()) {
        await removeVehicleProtectionVisuals(token, { tokenMagicOnly: true });
        return;
    }

    await syncTokenMagicShieldFilter(token, protection.shield);
    await syncTokenMagicMorphogeneticFilter(token, protection.morphogenetic);
}

async function syncTokenMagicShieldFilter(token, shield) {
    if (!shield.online) {
        await removeTokenMagicFilter(token, SHIELD_FILTER_ID);
        return;
    }

    const colors = SHIELD_COLORS[shield.type];
    const params = [{
        filterType: "glow",
        filterId: SHIELD_FILTER_ID,
        outerStrength: 6,
        innerStrength: 0,
        color: colors.primary,
        quality: 0.5,
        padding: 10,
        animated: {
            color: {
                active: true,
                loopDuration: 3000,
                animType: "colorOscillation",
                val1: colors.primary,
                val2: colors.secondary
            }
        }
    }];

    await applyTokenMagicFilters(token, params, "shield");
}

async function syncTokenMagicMorphogeneticFilter(token, morphogenetic) {
    if (!morphogenetic.online) {
        await removeTokenMagicFilter(token, MORPHOGENETIC_FILTER_ID);
        return;
    }

    const params = [{
        filterType: "electric",
        filterId: MORPHOGENETIC_FILTER_ID,
        color: 0xffffff,
        time: 0,
        blend: 1,
        intensity: 5,
        animated: {
            time: {
                active: true,
                speed: 0.0002,
                animType: "move"
            }
        }
    }];

    await applyTokenMagicFilters(token, params, "Morphogenetic Field");
}

async function applyTokenMagicFilters(token, params, label) {
    if (!game.user?.isGM || !isTokenMagicAvailable()) {
        debugVehicleCombat(`TokenMagic FX not available for ${label} vehicle protection automation.`);
        return;
    }

    try {
        await globalThis.TokenMagic.addUpdateFilters(token, params);
    } catch (error) {
        console.warn(`${MODULE_ID} vehicle combat | Could not apply ${label} TokenMagic filter.`, error);
    }
}

async function removeVehicleProtectionVisuals(token, options = {}) {
    if (!options.tokenMagicOnly) stopProtectionEffectForToken(token?.id);
    await removeTokenMagicFilter(token, SHIELD_FILTER_ID);
    await removeTokenMagicFilter(token, MORPHOGENETIC_FILTER_ID);
}

async function removeTokenMagicFilter(token, filterId) {
    if (!token || !isTokenMagicAvailable()) return;
    if (!game.user?.isGM) return;
    try {
        if (!globalThis.TokenMagic.hasFilterId?.(token, filterId)) return;
        await globalThis.TokenMagic.deleteFilters(token, filterId);
    } catch (error) {
        console.warn(`${MODULE_ID} vehicle combat | Could not remove vehicle protection filter.`, error);
    }
}

function shouldUseBuiltInProtectionVisuals() {
    const mode = getProtectionVisualMode();
    return mode === VEHICLE_PROTECTION_VISUAL_MODES.BUILT_IN || mode === VEHICLE_PROTECTION_VISUAL_MODES.BOTH;
}

function shouldUseTokenMagicProtectionVisuals() {
    const mode = getProtectionVisualMode();
    return mode === VEHICLE_PROTECTION_VISUAL_MODES.TOKEN_MAGIC || mode === VEHICLE_PROTECTION_VISUAL_MODES.BOTH;
}

function getProtectionVisualMode() {
    return getValidProtectionVisualMode(game.settings.get(MODULE_ID, "vehicleProtectionVisualMode"));
}

function getValidProtectionVisualMode(value) {
    const mode = String(value ?? VEHICLE_PROTECTION_VISUAL_MODES.BUILT_IN);
    return Object.values(VEHICLE_PROTECTION_VISUAL_MODES).includes(mode) ? mode : VEHICLE_PROTECTION_VISUAL_MODES.BUILT_IN;
}

function isTokenMagicAvailable() {
    return Boolean(
        globalThis.TokenMagic?.addUpdateFilters &&
        globalThis.TokenMagic?.deleteFilters &&
        globalThis.TokenMagic?.hasFilterId
    );
}

async function syncActiveVehicleCombat() {
    if (!game.user.isGM || !isVehicleCombatEnabled()) return;
    const combat = game.combat;
    if (!combat) return;
    for (const combatant of combat.combatants) await replaceVehicleCombatantWithCrew(combatant);
}

async function replaceVehicleCombatantWithCrew(combatant) {
    if (!game.user.isGM || !isVehicleCombatEnabled()) return;
    if (!combatant || combatant.getFlag(MODULE_ID, CREW_COMBATANT_FLAG)) return;
    if (processingCombatants.has(combatant.uuid)) return;

    const vehicle = combatant.actor;
    if (!isVehicleActor(vehicle)) return;

    const rows = getVehicleCrewRows(vehicle);
    if (!rows.length) return;
    processingCombatants.add(combatant.uuid);

    try {
        const roster = [];
        const warnings = [];
        for (const row of rows) {
            const result = matchCrewActor(row, game.actors);
            roster.push({ row, actor: result.actor });
            if (!result.actor) {
                warnings.push(`${row.name} (${result.ambiguous ? "multiple Actors have this name" : "Actor not found"})`);
            }
        }

        const token = combatant.token;
        const createData = roster.map(({ row, actor }) => ({
            actorId: actor?.id ?? null,
            tokenId: null,
            hidden: combatant.hidden,
            initiative: null,
            name: actor?.name ?? row.name,
            img: actor?.img ?? DEFAULT_SILHOUETTE,
            flags: {
                [MODULE_ID]: {
                    [CREW_COMBATANT_FLAG]: {
                        ...getCrewCombatantFlag(vehicle, token, row),
                        artificial: !actor
                    }
                }
            }
        }));

        await grantCrewVehicleOwnership(combatant.combat, vehicle, roster.filter(({ actor }) => actor));
        const created = await combatant.combat.createEmbeddedDocuments("Combatant", createData, { fullSpeedAheadCrew: true });
        await combatant.delete({ fullSpeedAheadReplacedVehicle: true });
        if (warnings.length) {
            ui.notifications.info(`Full Speed Ahead created silhouette combatants for unmatched crew of ${vehicle.name}: ${warnings.join(", ")}.`);
        }
        debugVehicleCombat("Replaced vehicle combatant", vehicle.name, { createData, created });
    } finally {
        processingCombatants.delete(combatant.uuid);
    }
}

function getCrewCombatantFlag(vehicle, token, row) {
    return {
        vehicleActorUuid: vehicle.uuid,
        vehicleActorId: vehicle.id,
        vehicleTokenUuid: token?.uuid ?? null,
        vehicleTokenId: token?.id ?? null,
        vehicleName: vehicle.name,
        vehicleImg: token?.texture?.src ?? vehicle.img,
        ability: row.ability,
        role: row.role,
        rosterIndex: row.index,
        rosterSourcePath: row.sourcePath
    };
}

async function grantCrewVehicleOwnership(combat, vehicle, matched) {
    const ownershipFlags = foundry.utils.deepClone(combat.getFlag(MODULE_ID, VEHICLE_COMBAT_OWNERSHIP_FLAG) ?? {});
    if (!ownershipFlags[vehicle.uuid]) {
        ownershipFlags[vehicle.uuid] = foundry.utils.deepClone(vehicle.ownership);
    }

    const ownership = foundry.utils.deepClone(vehicle.ownership);
    for (const { actor } of matched) {
        for (const [userId, level] of Object.entries(actor.ownership ?? {})) {
            if (userId !== "default" && Number(level) >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER) {
                ownership[userId] = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
            }
        }
    }

    await combat.setFlag(MODULE_ID, VEHICLE_COMBAT_OWNERSHIP_FLAG, ownershipFlags);
    await vehicle.update({ ownership }, { fullSpeedAheadTemporaryOwnership: true });
}

async function restoreVehicleCombatOwnership(combat) {
    if (!game.user.isGM || !combat) return;
    const originals = combat.getFlag(MODULE_ID, VEHICLE_COMBAT_OWNERSHIP_FLAG) ?? {};
    for (const [uuid, ownership] of Object.entries(originals)) {
        const vehicle = await fromUuid(uuid);
        if (vehicle) await vehicle.update({ ownership }, { fullSpeedAheadRestoreOwnership: true });
    }
    if (Object.keys(originals).length && game.combats?.has(combat.id)) {
        await combat.unsetFlag(MODULE_ID, VEHICLE_COMBAT_OWNERSHIP_FLAG);
    }
}

function renderVehicleCrewTracker(app, html) {
    if (!isVehicleCombatEnabled()) return;

    const combat = app.viewed ?? game.combat;
    if (!combat) return;

    const mode = game.settings.get(MODULE_ID, "vehicleCombatDisplayMode");
    const badgeIcon = game.settings.get(MODULE_ID, "vehicleCombatShipIcon") || DEFAULT_SHIP_BADGE;

    for (const combatant of combat.combatants) {
        const data = combatant.getFlag(MODULE_ID, CREW_COMBATANT_FLAG);
        if (!data) continue;

        const row = html.find(`[data-combatant-id="${combatant.id}"]`);
        if (!row.length) continue;

        row.addClass(`full-speed-ahead-crew-combatant full-speed-ahead-crew-${mode}`).attr({
            "data-full-speed-ahead-vehicle-token-id": data.vehicleTokenId ?? "",
            title: `${data.role} (${data.ability}) - ${data.vehicleName}`
        });
        if (data.artificial) row.addClass("full-speed-ahead-crew-artificial");

        const portrait = row.find(".token-image").first();
        if (portrait.length && !portrait.parent().hasClass("full-speed-ahead-crew-portrait")) {
            portrait.wrap('<div class="full-speed-ahead-crew-portrait"></div>');
            const wrapper = portrait.parent();
            wrapper.append(`<img class="full-speed-ahead-ship-badge" src="${escapeHtml(badgeIcon)}" alt="">`);
            if (mode === VEHICLE_COMBAT_DISPLAY_MODES.FULL) {
                wrapper.prepend(`<img class="full-speed-ahead-vessel-image" src="${escapeHtml(data.vehicleImg)}" alt="${escapeHtml(data.vehicleName)}">`);
            }
        }

        if (mode === VEHICLE_COMBAT_DISPLAY_MODES.FULL) {
            const name = row.find(".token-name h4, .token-name").first();
            const existing = name.text().trim();
            if (existing && !existing.startsWith(`${data.vehicleName} / `)) {
                name.text(`${data.vehicleName} / ${existing}`);
            }
        }

        row.off("dblclick.fullSpeedAheadVehicleCombat").on("dblclick.fullSpeedAheadVehicleCombat", () => {
            const token = canvas.tokens?.get(data.vehicleTokenId);
            if (!token) return;
            canvas.animatePan({ x: token.center.x, y: token.center.y });
            token.control({ releaseOthers: true });
        });
    }
}

function isVehicleActor(actor) {
    return actor?.type === "vehicle";
}

function getTokenSortValue(token) {
    return Number.isFinite(token?.mesh?.zIndex) ? token.mesh.zIndex : Number.isFinite(token?.zIndex) ? token.zIndex : 0;
}

function getVehicleCrewRows(actor) {
    for (const path of VEHICLE_CREW_PATHS) {
        const value = foundry.utils.getProperty(actor, path);
        if (!Array.isArray(value)) continue;
        return value.flatMap((row, index) => {
            const label = typeof row === "string" ? row : row?.name ?? row?.label ?? "";
            const parsed = parseCrewLabel(label);
            if (!parsed) return [];
            return [{
                ...parsed,
                index,
                quantity: Math.max(1, Number(row?.quantity ?? 1) || 1),
                sourcePath: path
            }];
        });
    }
    return [];
}

function parseCrewLabel(label) {
    const raw = String(label ?? "").trim();
    const match = raw.match(/^\s*\(([^)]+)\)\s*([^:]+?)\s*:\s*(.+?)\s*$/u);
    if (!match) return null;

    const [, ability, role, rawName] = match;
    const bracketed = /^\[[\s\S]*\]$/.test(rawName.trim());
    const name = bracketed ? rawName.trim().slice(1, -1).trim() : rawName.trim();
    if (!ability.trim() || !role.trim() || !name) return null;

    return {
        ability: ability.trim(),
        role: role.trim(),
        name,
        rawName: rawName.trim(),
        bracketed,
        source: raw
    };
}

function matchCrewActor(entry, actors) {
    if (!entry) return { actor: null, ambiguous: false, candidates: [] };

    const candidates = Array.from(actors ?? []).filter(actor => normalizeCrewName(actor.name) === normalizeCrewName(entry.name));
    const exact = candidates.filter(actor => actor.name === entry.name);
    const ranked = exact.length ? exact : candidates;
    return {
        actor: ranked.length === 1 ? ranked[0] : null,
        ambiguous: ranked.length > 1,
        candidates: ranked
    };
}

function normalizeCrewName(value) {
    return String(value ?? "")
        .normalize("NFKC")
        .trim()
        .replace(/^\[([\s\S]*)\]$/, "$1")
        .replace(/\s+/g, " ")
        .toLocaleLowerCase();
}

function debugVehicleCombat(...args) {
    if (game.settings.get(MODULE_ID, "vehicleCombatDebug")) {
        console.debug(`${MODULE_ID} vehicle combat |`, ...args);
    }
}

function escapeHtml(value) {
    if (globalThis.foundry?.utils?.escapeHTML) return foundry.utils.escapeHTML(String(value ?? ""));
    return String(value ?? "").replace(/[&<>"']/g, character => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#39;"
    }[character]));
}
