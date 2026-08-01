// vehicle-combat.js: Send vehicle crew members to combat instead of the vehicle.

const MODULE_ID = "full-speed-ahead";
const CREW_COMBATANT_FLAG = "crewCombatant";
const VEHICLE_COMBAT_OWNERSHIP_FLAG = "vehicleCombatOwnership";
const DEFAULT_SILHOUETTE = "icons/svg/mystery-man.svg";
const SHIELD_FILTER_ID = "fullSpeedAheadVehicleShield";
const MORPHOGENETIC_FILTER_ID = "fullSpeedAheadMorphogeneticField";
const VEHICLE_COMBAT_DISPLAY_MODES = {
    FULL: "full",
    SIMPLE: "simple"
};
const VEHICLE_CREW_MATCH_MODES = {
    PLACEHOLDERS: "placeholders",
    MATCH_ONLY: "match-only"
};
const VEHICLE_COMBAT_MOVEMENT_FLAG = "vehicleCombatMovement";
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
const MORPHOGENETIC_COLORS = { primary: 0x9b4dff, secondary: 0xe2b7ff };
const PROTECTION_OUTLINE_FRAGMENT = `
precision highp float;

varying vec2 vTextureCoord;
uniform sampler2D uSampler;
uniform vec4 outlineColor;
uniform vec2 texelSize;
uniform float thickness;
uniform float alpha;
uniform float time;

float sampleAlpha(vec2 coord) {
    if (coord.x < 0.0 || coord.x > 1.0 || coord.y < 0.0 || coord.y > 1.0) return 0.0;
    return texture2D(uSampler, coord).a;
}

float alphaAtRadius(float radius) {
    vec2 offset = texelSize * radius;
    vec2 diag = offset * 0.70710678;
    vec2 halfDiag = offset * 0.38268343;
    float a = 0.0;

    a += sampleAlpha(vTextureCoord + vec2(offset.x, 0.0));
    a += sampleAlpha(vTextureCoord + vec2(-offset.x, 0.0));
    a += sampleAlpha(vTextureCoord + vec2(0.0, offset.y));
    a += sampleAlpha(vTextureCoord + vec2(0.0, -offset.y));
    a += sampleAlpha(vTextureCoord + diag);
    a += sampleAlpha(vTextureCoord - diag);
    a += sampleAlpha(vTextureCoord + vec2(diag.x, -diag.y));
    a += sampleAlpha(vTextureCoord + vec2(-diag.x, diag.y));
    a += sampleAlpha(vTextureCoord + vec2(offset.x, halfDiag.y)) * 0.82;
    a += sampleAlpha(vTextureCoord + vec2(offset.x, -halfDiag.y)) * 0.82;
    a += sampleAlpha(vTextureCoord + vec2(-offset.x, halfDiag.y)) * 0.82;
    a += sampleAlpha(vTextureCoord + vec2(-offset.x, -halfDiag.y)) * 0.82;
    a += sampleAlpha(vTextureCoord + vec2(halfDiag.x, offset.y)) * 0.82;
    a += sampleAlpha(vTextureCoord + vec2(-halfDiag.x, offset.y)) * 0.82;
    a += sampleAlpha(vTextureCoord + vec2(halfDiag.x, -offset.y)) * 0.82;
    a += sampleAlpha(vTextureCoord + vec2(-halfDiag.x, -offset.y)) * 0.82;

    return a / 14.56;
}

void main(void) {
    vec4 base = texture2D(uSampler, vTextureCoord);
    float innerAlpha = 0.0;
    float outerAlpha = 0.0;
    float innerWeight = 0.0;
    float outerWeight = 0.0;
    float innerThickness = max(thickness, 1.0);
    float outerThickness = innerThickness * 2.85;

    for (int ring = 1; ring <= 28; ring++) {
        float radius = float(ring);
        if (radius <= outerThickness) {
            float sampled = alphaAtRadius(radius);
            if (radius <= innerThickness) {
                float innerFalloff = pow(1.0 - ((radius - 1.0) / innerThickness), 1.35);
                innerAlpha += sampled * innerFalloff;
                innerWeight += innerFalloff;
            }
            float outerFalloff = pow(1.0 - ((radius - 1.0) / outerThickness), 2.15);
            outerAlpha += sampled * outerFalloff;
            outerWeight += outerFalloff;
        }
    }

    innerAlpha = innerWeight > 0.0 ? innerAlpha / innerWeight : 0.0;
    outerAlpha = outerWeight > 0.0 ? outerAlpha / outerWeight : 0.0;

    float outside = 1.0 - base.a;
    float rim = smoothstep(0.06, 0.32, max(innerAlpha - (base.a * 0.35), 0.0)) * outside;
    float aura = smoothstep(0.035, 0.38, max(outerAlpha - (base.a * 0.12), 0.0)) * outside;
    float pulse = 0.92 + 0.08 * sin(time * 2.1);

    vec3 hotColor = mix(outlineColor.rgb, vec3(1.0), rim * 0.18);
    float glowMix = clamp((rim * 0.38) + (aura * 0.12), 0.0, 1.0);
    vec3 color = mix(base.rgb, hotColor, glowMix);
    float glowAlpha = outlineColor.a * alpha * pulse * ((rim * 0.46) + (aura * 0.42));
    gl_FragColor = vec4(color, max(base.a, glowAlpha));
}
`;
const VEHICLE_CREW_PATHS = [
    "system.cargo.crew",
    "system.details.crew",
    "system.traits.crew"
];
const CREW_ABILITY_KEYS = {
    str: "str",
    strength: "str",
    dex: "dex",
    dexterity: "dex",
    con: "con",
    constitution: "con",
    int: "int",
    intelligence: "int",
    wis: "wis",
    wisdom: "wis",
    cha: "cha",
    charisma: "cha",
    tec: "tec",
    tech: "tec",
    technology: "tec"
};
const processingCombatants = new Set();
const activeProtectionEffects = new Map();
const pendingVehicleCombatMovementOrigins = new Map();
const pendingVehicleCombatMovementSpends = new Map();
let protectionTicker = null;
let lastCombatMovementWarningAt = 0;
let activeVehicleCombatContextMenu = null;

class FullSpeedAheadVehicleCombatConfig extends FormApplication {
    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "full-speed-ahead-vehicle-combat-config",
            title: "Full Speed Ahead: Vehicle Combat Encounters",
            template: `modules/${MODULE_ID}/templates/vehicle-combat-settings.hbs`,
            width: 560,
            closeOnSubmit: true
        });
    }

    getData() {
        return {
            vehicleCombatCrewMode: game.settings.get(MODULE_ID, "vehicleCombatCrewMode"),
            vehicleCrewMatchMode: game.settings.get(MODULE_ID, "vehicleCrewMatchMode"),
            vehicleCombatDisplayMode: game.settings.get(MODULE_ID, "vehicleCombatDisplayMode"),
            vehicleCombatHideUnmatchedCrewPhotos: safeGetModuleSetting("vehicleCombatHideUnmatchedCrewPhotos", true),
            vehicleCombatSpeedManaged: safeGetModuleSetting("vehicleCombatSpeedManaged", true),
            vehicleCombatSharedMovement: game.settings.get(MODULE_ID, "vehicleCombatSharedMovement"),
            vehicleCombatDebug: game.settings.get(MODULE_ID, "vehicleCombatDebug"),
            vehicleOpsEnabled: safeGetModuleSetting("vehicleOpsEnabled", true),
            vehicleOpsShowFloatingMenuGM: safeGetModuleSetting("vehicleOpsShowFloatingMenuGM", true),
            vehicleOpsShowFloatingMenuPlayers: safeGetModuleSetting("vehicleOpsShowFloatingMenuPlayers", false),
            vehicleOpsRepairCostPerHp: safeGetModuleSetting("vehicleOpsRepairCostPerHp", 100),
            vehicleOpsRepairCostPerShieldPoint: safeGetModuleSetting("vehicleOpsRepairCostPerShieldPoint", 100),
            vehicleOpsShipUpkeepPercent: getSharedEconomyPercent(["shipUpkeepPercent"], "vehicleOpsShipUpkeepPercent", 0.2, ["getShipUpkeepPercent"]),
            vehicleOpsGlaxonPremiumPercent: getSharedEconomyPercent(
                ["glaxonInsurancePremiumPercent", "shipInsurancePremiumPercent", "insurancePremiumPercent"],
                "vehicleOpsGlaxonPremiumPercent",
                5,
                ["getGlaxonInsurancePremiumPercent", "getShipInsurancePremiumPercent", "getInsurancePremiumPercent"]
            ),
            vehicleOpsInsuranceCompanyName: safeGetModuleSetting("vehicleOpsInsuranceCompanyName", "Glaxxon Insurance"),
            vehicleOpsInsuranceCodeRequired: safeGetModuleSetting("vehicleOpsInsuranceCodeRequired", true),
            vehicleOpsInsuranceConfirmationCode: safeGetModuleSetting("vehicleOpsInsuranceConfirmationCode", ""),
            vehicleOpsTokenMagicDamage: safeGetModuleSetting("vehicleOpsTokenMagicDamage", true),
            vehicleOpsItemPilesJettison: safeGetModuleSetting("vehicleOpsItemPilesJettison", true),
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
            crewMatchModes: [
                {
                    value: VEHICLE_CREW_MATCH_MODES.PLACEHOLDERS,
                    label: "Match + Generate Actors",
                    selected: game.settings.get(MODULE_ID, "vehicleCrewMatchMode") === VEHICLE_CREW_MATCH_MODES.PLACEHOLDERS
                },
                {
                    value: VEHICLE_CREW_MATCH_MODES.MATCH_ONLY,
                    label: "Match Actors Only",
                    selected: game.settings.get(MODULE_ID, "vehicleCrewMatchMode") === VEHICLE_CREW_MATCH_MODES.MATCH_ONLY
                }
            ],
            protectionVisualModes: []
        };
    }

    async _updateObject(event, formData) {
        await game.settings.set(MODULE_ID, "vehicleCombatCrewMode", Boolean(formData.vehicleCombatCrewMode));
        await game.settings.set(MODULE_ID, "vehicleCrewMatchMode", getValidCrewMatchMode(formData.vehicleCrewMatchMode));
        await game.settings.set(MODULE_ID, "vehicleCombatDisplayMode", String(formData.vehicleCombatDisplayMode || VEHICLE_COMBAT_DISPLAY_MODES.FULL));
        await game.settings.set(MODULE_ID, "vehicleCombatHideUnmatchedCrewPhotos", Boolean(formData.vehicleCombatHideUnmatchedCrewPhotos));
        await game.settings.set(MODULE_ID, "vehicleCombatSpeedManaged", Boolean(formData.vehicleCombatSpeedManaged));
        await game.settings.set(MODULE_ID, "vehicleCombatSharedMovement", Boolean(formData.vehicleCombatSharedMovement));
        await game.settings.set(MODULE_ID, "vehicleCombatDebug", Boolean(formData.vehicleCombatDebug));
        await safeSetModuleSetting("vehicleOpsEnabled", Boolean(formData.vehicleOpsEnabled));
        await safeSetModuleSetting("vehicleOpsShowFloatingMenuGM", Boolean(formData.vehicleOpsShowFloatingMenuGM));
        await safeSetModuleSetting("vehicleOpsShowFloatingMenuPlayers", Boolean(formData.vehicleOpsShowFloatingMenuPlayers));
        await safeSetModuleSetting("vehicleOpsRepairCostPerHp", Math.max(0, Number(formData.vehicleOpsRepairCostPerHp || 0)));
        await safeSetModuleSetting("vehicleOpsRepairCostPerShieldPoint", Math.max(0, Number(formData.vehicleOpsRepairCostPerShieldPoint || 0)));
        await setSharedEconomyPercent(["shipUpkeepPercent"], "vehicleOpsShipUpkeepPercent", formData.vehicleOpsShipUpkeepPercent, 0.2);
        await setSharedEconomyPercent(
            ["glaxonInsurancePremiumPercent", "shipInsurancePremiumPercent", "insurancePremiumPercent"],
            "vehicleOpsGlaxonPremiumPercent",
            formData.vehicleOpsGlaxonPremiumPercent,
            5
        );
        await safeSetModuleSetting("vehicleOpsInsuranceCompanyName", String(formData.vehicleOpsInsuranceCompanyName || "Glaxxon Insurance").trim() || "Glaxxon Insurance");
        await safeSetModuleSetting("vehicleOpsInsuranceCodeRequired", Boolean(formData.vehicleOpsInsuranceCodeRequired));
        await safeSetModuleSetting("vehicleOpsInsuranceConfirmationCode", String(formData.vehicleOpsInsuranceConfirmationCode || "").trim());
        await safeSetModuleSetting("vehicleOpsTokenMagicDamage", Boolean(formData.vehicleOpsTokenMagicDamage));
        await safeSetModuleSetting("vehicleOpsItemPilesJettison", Boolean(formData.vehicleOpsItemPilesJettison));
        ui.combat?.render(true);
        if (game.settings.get(MODULE_ID, "vehicleCombatCrewMode")) syncActiveVehicleCombat();
        syncVehicleShields();
    }
}

Hooks.once("init", () => {
    game.settings.registerMenu(MODULE_ID, "vehicleCombatConfig", {
        name: "Vehicle Combat Encounters",
        label: "Configure",
        hint: "Configure whether vehicle combat sends crew members to initiative instead of the vehicle.",
        icon: "fas fa-users-cog",
        type: FullSpeedAheadVehicleCombatConfig,
        restricted: true
    });
    game.fullSpeedAhead = game.fullSpeedAhead || {};
    game.fullSpeedAhead.openVehicleCombatSettings = () => new FullSpeedAheadVehicleCombatConfig().render(true);

    registerVehicleCombatSetting("vehicleCombatCrewMode", {
        name: "Send Crew to Combat Initiative, not Vehicle",
        hint: "When selected, adding a vehicle to combat initiative searches its Cargo/Crew and attempts to add them to combat initiative instead of the ship.",
        type: Boolean,
        default: true,
        config: false,
        onChange: enabled => {
            ui.combat?.render(true);
            if (enabled) syncActiveVehicleCombat();
        }
    });

    registerVehicleCombatSetting("vehicleCrewMatchMode", {
        name: "Crew Initiative Matching",
        hint: "Choose whether unmatched Cargo/Crew names create placeholder combatants or are skipped.",
        type: String,
        choices: {
            [VEHICLE_CREW_MATCH_MODES.PLACEHOLDERS]: "Match + Generate Actors",
            [VEHICLE_CREW_MATCH_MODES.MATCH_ONLY]: "Match Actors Only"
        },
        default: VEHICLE_CREW_MATCH_MODES.PLACEHOLDERS,
        config: false
    });

    registerVehicleCombatSetting("vehicleCombatDisplayMode", {
        name: "Vehicle Combat Display Mode",
        hint: "Full shows vessel and character portraits plus Vessel / Character names. Simple uses a tighter crew display.",
        type: String,
        choices: {
            [VEHICLE_COMBAT_DISPLAY_MODES.FULL]: "Full Combat Order",
            [VEHICLE_COMBAT_DISPLAY_MODES.SIMPLE]: "Simple Combat Order"
        },
        default: VEHICLE_COMBAT_DISPLAY_MODES.FULL,
        config: false,
        onChange: () => ui.combat?.render(true)
    });

    registerVehicleCombatSetting("vehicleCombatHideUnmatchedCrewPhotos", {
        name: "Do not show photos for non matched crew",
        hint: "Generated placeholder crew remain in combat by name, but their mystery portrait is hidden.",
        type: Boolean,
        default: true,
        config: false,
        onChange: () => ui.combat?.render(true)
    });

    registerVehicleCombatSetting("vehicleCombatSpeedManaged", {
        name: "FSA Manages Combat Speed",
        hint: "Track and enforce vehicle combat movement during started combats.",
        type: Boolean,
        default: true,
        config: false,
        onChange: () => ui.combat?.render(true)
    });

    registerVehicleCombatSetting("vehicleCombatSharedMovement", {
        name: "Shared Movement",
        hint: "At the start of each round, each vehicle gains movement equal to its Speed. Any crew member may spend from that vehicle's shared remaining movement.",
        type: Boolean,
        default: true,
        config: false,
        onChange: () => ui.combat?.render(true)
    });

    registerVehicleCombatSetting("vehicleShieldAutomation", {
        name: "Automatically Manage Vehicle Shields",
        hint: "Ships that have Shield Generators, or Morphogenetic Fields, will automatically have shields drawn so long as they are equipped and contain HP, once the HP runs to 0, the shield will be removed. Shields will also be restored upon healing and repair.",
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
    game.fullSpeedAheadVehicleCombat = {
        syncVehicleShields,
        getRemainingMovement: getRemainingCombatMovement,
        getMovementState: getCombatMovementStateForTokenOrActor
    };
    game.socket?.on?.(`module.${MODULE_ID}`, handleVehicleCombatSocket);
    registerDragRulerCombatSpeedProvider();
    syncActiveVehicleCombat();
    syncVehicleShields();
});
Hooks.once("dragRuler.ready", registerDragRulerCombatSpeedProvider);
Hooks.on("canvasReady", () => {
    stopAllProtectionEffects();
    syncVehicleShields();
});
Hooks.on("createCombatant", combatant => {
    replaceVehicleCombatantWithCrew(combatant);
    queueVehicleCrewDuplicateCleanup(combatant?.combat);
});
Hooks.on("renderCombatTracker", (app, html) => renderVehicleCrewTracker(app, html));
Hooks.on("deleteCombat", combat => restoreVehicleCombatOwnership(combat));
Hooks.on("updateCombat", (combat, changes) => {
    const changed = changes ?? {};
    const movementChanged = Boolean(foundry.utils.getProperty(changed, `flags.${MODULE_ID}.${VEHICLE_COMBAT_MOVEMENT_FLAG}`));
    if (Object.prototype.hasOwnProperty.call(changed, "round") || movementChanged) {
        clearPendingVehicleCombatMovementForCombat(combat);
        ui.combat?.render(true);
    }
});
Hooks.on("preUpdateToken", (tokenDocument, changes, options) => guardVehicleCombatMovement(tokenDocument, changes, options));
Hooks.on("updateToken", (tokenDocument, changes, options, userId) => recordVehicleCombatMovement(tokenDocument, changes, options, userId));
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

function safeGetModuleSetting(key, fallback) {
    try {
        return game.settings.get(MODULE_ID, key);
    } catch (_error) {
        return fallback;
    }
}

async function safeSetModuleSetting(key, value) {
    try {
        await game.settings.set(MODULE_ID, key, value);
    } catch (_error) {
        // Vehicle Operations may not have registered yet during unusual module load ordering.
    }
}

function tradeHubSettingExists(key) {
    return Boolean(game.modules?.get("tradehub-markets")?.active && game.settings?.settings?.has?.(`tradehub-markets.${key}`));
}

function getSharedEconomyPercent(tradeHubKeys, fsaKey, fallback, tradeHubGetters = []) {
    const getterName = tradeHubGetters.find(name => typeof game.tradehub?.[name] === "function");
    if (getterName) return Math.max(0, Number(game.tradehub[getterName]() ?? fallback));
    const tradeHubKey = tradeHubKeys.find(tradeHubSettingExists);
    if (tradeHubKey) {
        try {
            return Math.max(0, Number(game.settings.get("tradehub-markets", tradeHubKey) ?? fallback));
        } catch (_error) {
            return fallback;
        }
    }
    return Math.max(0, Number(safeGetModuleSetting(fsaKey, fallback) ?? fallback));
}

async function setSharedEconomyPercent(tradeHubKeys, fsaKey, rawValue, fallback) {
    const value = Math.max(0, Number(rawValue ?? fallback));
    await safeSetModuleSetting(fsaKey, value);
    const tradeHubKey = tradeHubKeys.find(tradeHubSettingExists);
    if (!tradeHubKey) return;
    try {
        await game.settings.set("tradehub-markets", tradeHubKey, value);
    } catch (_error) {
        // If TradeHub does not allow writes, FSA's fallback remains available.
    }
}

function isVehicleCombatEnabled() {
    return Boolean(game.settings.get(MODULE_ID, "vehicleCombatCrewMode"));
}

function isVehicleCombatSpeedManaged() {
    return Boolean(safeGetModuleSetting("vehicleCombatSpeedManaged", true));
}

function isVehicleCombatSharedMovementEnabled() {
    return Boolean(safeGetModuleSetting("vehicleCombatSharedMovement", true));
}

function getStartedCombatForScene(scene, combatOverride = null) {
    const combat = getCombatForScene(scene, combatOverride);
    if (!combat) return null;
    const started = Boolean(combat.started) || Number(combat.round) > 0;
    if (!started) return null;
    return combat;
}

function getCombatForScene(scene, combatOverride = null) {
    const sceneId = scene?.id ?? canvas?.scene?.id ?? null;
    const candidates = [combatOverride, game.combat, ...(game.combats?.contents ?? [])]
        .filter(combat => combat && (!sceneId || !combat.scene?.id || combat.scene.id === sceneId));
    if (!candidates.length) return null;

    const unique = Array.from(new Map(candidates.map(combat => [combat.id, combat])).values());
    return unique.find(combat => combat.active)
        ?? unique.find(combat => Boolean(combat.started) || Number(combat.round) > 0)
        ?? unique[0]
        ?? null;
}

function guardVehicleCombatMovement(tokenDocument, changes, options = {}) {
    const gate = getVehicleCombatMovementGate(tokenDocument, changes, options);
    if (!gate.allowed) {
        if (gate.reason === "wrong-turn-vehicle") warnVehicleCombatWrongTurnVehicle(gate);
        return gate.block ? false : undefined;
    }
    const state = getCombatMovementStateForTokenOrActor(tokenDocument, gate.combat);
    if (!state) return;

    const distance = measureTokenDocumentMovement(tokenDocument, changes);
    if (distance <= 0) return;
    if (distance <= state.remaining + 0.01) {
        const origin = { x: tokenDocument.x, y: tokenDocument.y };
        options.fullSpeedAheadCombatOrigin = origin;
        pendingVehicleCombatMovementOrigins.set(getTokenMovementOriginKey(tokenDocument), origin);
        return;
    }

    warnVehicleCombatMovementExceeded(state);
    return false;
}

async function recordVehicleCombatMovement(tokenDocument, changes, options = {}, userId = null) {
    if (userId && userId !== game.user.id) return;
    const gate = getVehicleCombatMovementGate(tokenDocument, changes, options);
    if (!gate.allowed) return;
    const state = getCombatMovementStateForTokenOrActor(tokenDocument, gate.combat);
    if (!state) return;

    const originKey = getTokenMovementOriginKey(tokenDocument);
    const origin = options?.fullSpeedAheadCombatOrigin ?? pendingVehicleCombatMovementOrigins.get(originKey);
    pendingVehicleCombatMovementOrigins.delete(originKey);
    const measuredDistance = origin
        ? measureTokenDocumentMovementBetween(tokenDocument, origin, { x: tokenDocument.x, y: tokenDocument.y })
        : measureTokenDocumentMovement(tokenDocument, changes);
    if (measuredDistance <= 0) return;

    if (!game.user.isGM) {
        addPendingVehicleCombatMovementSpend(state, measuredDistance);
        game.socket?.emit?.(`module.${MODULE_ID}`, {
            type: "vehicleCombatMovementSpend",
            tokenUuid: tokenDocument.uuid,
            combatId: state.combat.id,
            distance: measuredDistance
        });
        return;
    }

    try {
        await persistVehicleCombatMovementSpend(state, measuredDistance, tokenDocument);
    } catch (error) {
        debugVehicleCombat("Could not persist vehicle combat movement.", error);
        game.socket?.emit?.(`module.${MODULE_ID}`, {
            type: "vehicleCombatMovementSpend",
            tokenUuid: tokenDocument.uuid,
            combatId: state.combat.id,
            distance: measuredDistance
        });
    }
}

async function handleVehicleCombatSocket(message) {
    if (!game.user.isGM) return;
    if (message?.type !== "vehicleCombatMovementSpend") return;
    const combat = game.combats?.get(message.combatId);
    if (!combat) return;
    const tokenDocument = await fromUuid(message.tokenUuid);
    const state = getCombatMovementStateForTokenOrActor(tokenDocument, combat);
    const distance = Math.max(0, Number(message.distance) || 0);
    if (!state || distance <= 0) return;
    await persistVehicleCombatMovementSpend(state, distance, tokenDocument);
}

async function persistVehicleCombatMovementSpend(state, distance, tokenDocument = null) {
    const nextSpent = Math.min(state.speed, state.spent + distance);
    const ledger = getCombatMovementLedger(state.combat);
    ledger.vehicles[state.vehicleKey] = {
        speed: state.speed,
        spent: nextSpent,
        updatedRound: state.round,
        vehicleName: state.vehicleName
    };
    await state.combat.setFlag(MODULE_ID, VEHICLE_COMBAT_MOVEMENT_FLAG, ledger);
    refreshCombatMovementDisplays();
    debugVehicleCombat(`Spent ${distance} ${getSceneDistanceUnit(tokenDocument?.parent)} of ${state.vehicleName} movement`, ledger.vehicles[state.vehicleKey]);
}

function shouldManageVehicleCombatMovement(tokenDocument, changes, options = {}) {
    return getVehicleCombatMovementGate(tokenDocument, changes, options).allowed;
}

function getVehicleCombatMovementGate(tokenDocument, changes, options = {}) {
    if (options?.fullSpeedAheadRotationOnly || options?.fullSpeedAheadCrew || options?.fullSpeedAheadVehicleOperation) return { allowed: false, reason: "ignored-operation" };
    if (!isVehicleCombatSpeedManaged() || !isVehicleCombatSharedMovementEnabled()) return { allowed: false, reason: "disabled" };
    if (!tokenDocument?.actor || !isVehicleActor(tokenDocument.actor)) return { allowed: false, reason: "not-vehicle" };
    if (!Object.prototype.hasOwnProperty.call(changes ?? {}, "x") && !Object.prototype.hasOwnProperty.call(changes ?? {}, "y")) return { allowed: false, reason: "not-movement" };
    const combat = getCombatForScene(tokenDocument.parent);
    if (!combat) return { allowed: false, reason: "no-combat" };
    const identity = getVehicleCombatMovementIdentity(tokenDocument.actor, tokenDocument, combat);
    if (!identity) return { allowed: false, reason: "not-in-combat" };
    const started = Boolean(combat.started) || Number(combat.round) > 0;
    if (!started) return { allowed: false, reason: "not-started" };
    const activeIdentity = getActiveCombatVehicleMovementIdentity(combat);
    if (activeIdentity && activeIdentity.key !== identity.key) {
        return { allowed: false, reason: "wrong-turn-vehicle", block: true, combat, identity, activeIdentity };
    }
    return { allowed: true, reason: "started", combat };
}

function getRemainingCombatMovement(tokenOrActor) {
    return getCombatMovementStateForTokenOrActor(tokenOrActor)?.remaining ?? null;
}

function getCombatMovementStateForTokenOrActor(tokenOrActor, combatOverride = null) {
    if (!isVehicleCombatSpeedManaged() || !isVehicleCombatSharedMovementEnabled()) return null;
    const tokenDocument = tokenOrActor?.documentName === "Token" ? tokenOrActor : tokenOrActor?.document;
    const actor = tokenDocument?.actor ?? (tokenOrActor?.documentName === "Actor" ? tokenOrActor : tokenOrActor?.actor);
    if (!isVehicleActor(actor)) return null;

    const scene = tokenDocument?.parent ?? canvas?.scene ?? null;
    const combat = getStartedCombatForScene(scene, combatOverride);
    if (!combat) return null;

    const identity = getVehicleCombatMovementIdentity(actor, tokenDocument, combat);
    if (!identity) return null;

    const speed = getVehicleCombatSpeed(actor);
    if (speed <= 0) return null;

    const ledger = getCombatMovementLedger(combat);
    const existing = ledger.vehicles[identity.key] ?? {};
    const pendingSpent = game.user?.isGM ? 0 : getPendingVehicleCombatMovementSpend(combat, identity.key);
    const spent = clampVehicleCombatNumber((Number(existing.spent) || 0) + pendingSpent, 0, speed, 0);
    return {
        combat,
        round: Number(combat.round) || 0,
        vehicleKey: identity.key,
        vehicleName: identity.name,
        speed,
        spent,
        remaining: Math.max(0, speed - spent),
        unit: getSceneDistanceUnit(scene)
    };
}

function getTokenMovementOriginKey(tokenDocument) {
    return tokenDocument?.uuid ?? `${tokenDocument?.parent?.id ?? canvas?.scene?.id ?? "scene"}:${tokenDocument?.id ?? ""}`;
}

function getPendingVehicleCombatMovementKey(combat, vehicleKey) {
    return `${combat?.id ?? "combat"}:${vehicleKey}`;
}

function getPendingVehicleCombatMovementSpend(combat, vehicleKey) {
    return Number(pendingVehicleCombatMovementSpends.get(getPendingVehicleCombatMovementKey(combat, vehicleKey)) || 0);
}

function addPendingVehicleCombatMovementSpend(state, distance) {
    const key = getPendingVehicleCombatMovementKey(state.combat, state.vehicleKey);
    const current = Number(pendingVehicleCombatMovementSpends.get(key) || 0);
    pendingVehicleCombatMovementSpends.set(key, Math.max(0, current + Math.max(0, Number(distance) || 0)));
    refreshCombatMovementDisplays();
}

function clearPendingVehicleCombatMovementForCombat(combat) {
    const prefix = `${combat?.id ?? ""}:`;
    for (const key of Array.from(pendingVehicleCombatMovementSpends.keys())) {
        if (key.startsWith(prefix)) pendingVehicleCombatMovementSpends.delete(key);
    }
}

function getVehicleCombatMovementIdentity(actor, tokenDocument, combat) {
    const actorUuid = actor?.uuid ?? "";
    for (const combatant of combat.combatants ?? []) {
        const data = combatant.getFlag(MODULE_ID, CREW_COMBATANT_FLAG);
        if (data && crewDataMatchesVehicleTokenOrActor(data, actor, tokenDocument)) {
            return getVehicleCombatMovementIdentityFromCrewData(data, actor);
        }

        if (!data && combatant.actor?.uuid === actorUuid) {
            const combatantTokenUuid = combatant.token?.uuid ?? null;
            const combatantTokenId = combatant.token?.id ?? combatant.tokenId ?? null;
            const movedTokenMatches = !tokenDocument || !combatantTokenId || combatantTokenId === tokenDocument.id;
            if (movedTokenMatches) {
                return {
                    key: combatantTokenUuid || tokenDocument?.uuid || actorUuid || actor.id,
                    name: actor.name,
                    vehicleTokenId: combatantTokenId || tokenDocument?.id || null
                };
            }
        }
    }
    return null;
}

function getActiveCombatVehicleMovementIdentity(combat) {
    const combatant = combat?.combatant ?? combat?.turns?.[combat?.turn] ?? null;
    if (!combatant) return null;

    const data = combatant.getFlag(MODULE_ID, CREW_COMBATANT_FLAG);
    if (data) return getVehicleCombatMovementIdentityFromCrewData(data, combatant.actor);

    const actor = combatant.actor;
    if (!isVehicleActor(actor)) return null;
    return {
        key: combatant.token?.uuid || actor.uuid || actor.id,
        name: actor.name,
        vehicleTokenId: combatant.token?.id ?? combatant.tokenId ?? null
    };
}

function getVehicleCombatMovementIdentityFromCrewData(data, fallbackActor = null) {
    return {
        key: data.vehicleTokenUuid || data.vehicleTokenId || data.vehicleActorUuid || data.vehicleActorId || fallbackActor?.uuid || fallbackActor?.id,
        name: data.vehicleName || fallbackActor?.name || "Vehicle",
        vehicleTokenId: data.vehicleTokenId ?? null
    };
}

function crewDataMatchesVehicleTokenOrActor(data, actor, tokenDocument = null) {
    if (!data || !actor) return false;
    if (tokenDocument) {
        if (data.vehicleTokenUuid && data.vehicleTokenUuid === tokenDocument.uuid) return true;
        if (data.vehicleTokenId && data.vehicleTokenId === tokenDocument.id) return true;
    }
    return data.vehicleActorUuid === actor.uuid || data.vehicleActorId === actor.id;
}

function getCombatMovementLedger(combat) {
    const round = Number(combat?.round) || 0;
    const stored = foundry.utils.deepClone(combat?.getFlag(MODULE_ID, VEHICLE_COMBAT_MOVEMENT_FLAG) ?? {});
    if (Number(stored.round) === round && stored.vehicles && typeof stored.vehicles === "object") return stored;
    return { round, vehicles: {} };
}

function getVehicleCombatSpeed(actor) {
    const movement = foundry.utils.getProperty(actor, "system.attributes.movement") ?? {};
    const values = ["fly", "walk", "burrow", "climb", "swim", "hover"].map(key => parseMovementNumber(movement[key]));
    const legacySpeed = parseMovementNumber(foundry.utils.getProperty(actor, "system.details.speed"));
    const speed = Math.max(0, legacySpeed, ...values);
    return Number.isFinite(speed) ? speed : 0;
}

function parseMovementNumber(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    const parsed = Number.parseFloat(String(value ?? "").replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : 0;
}

function measureTokenDocumentMovement(tokenDocument, changes = {}) {
    const origin = { x: tokenDocument.x, y: tokenDocument.y };
    const destination = {
        x: Number.isFinite(Number(changes.x)) ? Number(changes.x) : tokenDocument.x,
        y: Number.isFinite(Number(changes.y)) ? Number(changes.y) : tokenDocument.y
    };
    return measureTokenDocumentMovementBetween(tokenDocument, origin, destination);
}

function measureTokenDocumentMovementBetween(tokenDocument, originPosition, destinationPosition) {
    const scene = tokenDocument?.parent ?? canvas?.scene;
    const gridSize = Number(scene?.grid?.size || canvas?.grid?.size || 100) || 100;
    const gridDistance = Number(scene?.grid?.distance || canvas?.scene?.grid?.distance || 5) || 5;
    const origin = getTokenDocumentCenter(tokenDocument, originPosition.x, originPosition.y, gridSize);
    const destination = getTokenDocumentCenter(tokenDocument, destinationPosition.x, destinationPosition.y, gridSize);
    if (origin.x === destination.x && origin.y === destination.y) return 0;

    try {
        const measured = canvas?.grid?.measureDistances?.([{ ray: new Ray(origin, destination) }], { gridSpaces: true })?.[0];
        if (Number.isFinite(Number(measured))) return Math.max(0, Number(measured));
    } catch (_error) {
        // Fall through to Euclidean scene-unit measurement.
    }

    const pixelDistance = Math.hypot(destination.x - origin.x, destination.y - origin.y);
    return pixelDistance / gridSize * gridDistance;
}

function getTokenDocumentCenter(tokenDocument, x, y, gridSize) {
    return {
        x: Number(x || 0) + (Number(tokenDocument?.width || 1) * gridSize) / 2,
        y: Number(y || 0) + (Number(tokenDocument?.height || 1) * gridSize) / 2
    };
}

function getSceneDistanceUnit(scene) {
    return String(scene?.grid?.units || canvas?.scene?.grid?.units || "ft");
}

function warnVehicleCombatMovementExceeded(state) {
    const now = Date.now();
    if (now - lastCombatMovementWarningAt < 1500) return;
    lastCombatMovementWarningAt = now;
    ui.notifications.warn(`${state.vehicleName} has ${Math.round(state.remaining * 100) / 100} ${state.unit} of shared combat movement remaining this round.`);
}

function warnVehicleCombatWrongTurnVehicle(gate) {
    const now = Date.now();
    if (now - lastCombatMovementWarningAt < 1500) return;
    lastCombatMovementWarningAt = now;
    ui.notifications.warn(`It is ${gate.activeIdentity?.name || "another vehicle"}'s combat movement turn. ${gate.identity?.name || "That vehicle"} cannot spend movement right now.`);
}

function registerDragRulerCombatSpeedProvider(ReadySpeedProvider = null) {
    const dragRuler = globalThis.dragRuler;
    if (!dragRuler || dragRuler.__fullSpeedAheadCombatSpeedProvider) return;
    const BaseProvider = ReadySpeedProvider ?? dragRuler.SpeedProvider;
    const register = typeof dragRuler.registerModule === "function"
        ? dragRuler.registerModule
        : typeof dragRuler.registerSystem === "function"
            ? dragRuler.registerSystem
            : null;
    if (!BaseProvider || !register) return;

    class FullSpeedAheadCombatSpeedProvider extends BaseProvider {
        get colors() {
            return [
                { id: "fsa-combat-remaining", default: 0x2ec27e, name: "FSA Combat Movement Remaining" },
                { id: "fsa-combat-spent", default: 0xd93636, name: "FSA Combat Movement Spent" }
            ];
        }

        getRanges(token) {
            const state = getCombatMovementStateForTokenOrActor(token);
            if (!state) return typeof super.getRanges === "function" ? super.getRanges(token) : null;
            return [
                { range: state.remaining, color: "fsa-combat-remaining" },
                { range: Infinity, color: "fsa-combat-spent" }
            ];
        }
    }

    try {
        register.call(dragRuler, MODULE_ID, FullSpeedAheadCombatSpeedProvider);
        dragRuler.__fullSpeedAheadCombatSpeedProvider = true;
        debugVehicleCombat("Registered Drag Ruler combat speed provider.");
    } catch (error) {
        debugVehicleCombat("Could not register Drag Ruler combat speed provider.", error);
    }
}

function refreshCombatMovementDisplays() {
    ui.combat?.render(true);
    canvas?.tokens?.controlled?.forEach?.(token => token.renderFlags?.set?.({ refresh: true }));
    canvas?.app?.renderer?.render?.(canvas.stage);
}

function getActorProtectionSettings(actor, tokenDocument = null) {
    return game.fullSpeedAhead?.getProtectionSettingsForTokenDocument?.(tokenDocument) ?? game.fullSpeedAhead?.getProtectionSettingsForActor?.(actor) ?? {
        enabled: Boolean(game.settings.get(MODULE_ID, "vehicleShieldAutomation")),
        visualMode: getValidProtectionVisualMode(game.settings.get(MODULE_ID, "vehicleProtectionVisualMode"))
    };
}

function isVehicleShieldAutomationEnabled(actor = null, tokenDocument = null) {
    return Boolean(getActorProtectionSettings(actor, tokenDocument).enabled);
}

function canManageVehicleShields(actor = null, tokenDocument = null) {
    return canvas?.ready && (!actor || isVehicleShieldAutomationEnabled(actor, tokenDocument));
}

async function syncVehicleShields() {
    if (!canvas?.ready || !canvas.tokens) return;

    await Promise.all((canvas.tokens.placeables ?? []).map(token => syncVehicleShieldForToken(token)));
}

async function syncVehicleShieldsForActor(actor) {
    if (!canvas?.ready || !isVehicleActor(actor)) return;
    const tokens = (canvas.tokens?.placeables ?? []).filter(token => token.actor?.id === actor.id);
    await Promise.all(tokens.map(token => syncVehicleShieldForToken(token)));
}

async function syncVehicleShieldsForItem(item) {
    const actor = item?.parent;
    if (isVehicleActor(actor) && isVehicleShieldRelevantItem(item)) await syncVehicleShieldsForActor(actor);
}

async function syncVehicleShieldForToken(token) {
    if (!canvas?.ready) return;
    if (!token?.actor || !isVehicleActor(token.actor) || token.document?.hidden) {
        await removeVehicleProtectionVisuals(token);
        return;
    }
    if (!canManageVehicleShields(token.actor, token.document)) {
        await removeVehicleProtectionVisuals(token);
        return;
    }

    const protection = getVehicleProtectionStatus(token.actor, token.document);
    if (!protection.shield.online && !protection.morphogenetic.online) {
        await removeVehicleProtectionVisuals(token);
        return;
    }

    syncBuiltInProtectionEffect(token, protection);
    await syncTokenMagicProtectionEffects(token, protection);
}

function getVehicleProtectionStatus(actor, tokenDocument = null) {
    const settings = getActorProtectionSettings(actor, tokenDocument);
    return {
        visualMode: settings.visualMode,
        shield: getVehicleShieldStatus(actor),
        morphogenetic: getVehicleMorphogeneticStatus(actor)
    };
}

function getVehicleShieldStatus(actor) {
    const shieldModule = findVehicleShieldGenerator(actor);
    if (!shieldModule) return { online: false, reason: "missing" };

    const type = getBracketedModuleType(shieldModule.name);
    const { hp } = getItemHpInfo(shieldModule);
    if (shieldModule.system?.equipped !== true) return { online: false, reason: "unequipped", hp, type };
    if (!type || !SHIELD_COLORS[type]) return { online: false, reason: "invalid-type", hp, type };
    return { online: hp > 0, hp, type };
}

function getVehicleMorphogeneticStatus(actor) {
    const morphogeneticModule = findVehicleMorphogeneticField(actor);
    if (!morphogeneticModule) return { online: false, reason: "missing" };

    const { hp, hasHp } = getItemHpInfo(morphogeneticModule);
    if (morphogeneticModule.system?.equipped !== true) return { online: false, reason: "unequipped", hp, hasHp };
    return { online: hasHp ? hp > 0 : true, hp, hasHp };
}

function findVehicleShieldGenerator(actor) {
    return Array.from(actor?.items ?? [])
        .filter(item => isVehicleShieldItem(item))
        .sort((a, b) => Number(b.system?.equipped === true) - Number(a.system?.equipped === true) || getItemHpInfo(b).hp - getItemHpInfo(a).hp)[0] || null;
}

function findVehicleMorphogeneticField(actor) {
    return Array.from(actor?.items ?? [])
        .filter(item => isVehicleMorphogeneticItem(item))
        .sort((a, b) => Number(b.system?.equipped === true) - Number(a.system?.equipped === true) || getItemHpInfo(b).hp - getItemHpInfo(a).hp)[0] || null;
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
    if (!shouldUseBuiltInProtectionVisuals(protection)) {
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
    if (existing) {
        existing.token = token;
        const object = getProtectionVisualObject(token);
        if (!object || object.destroyed) {
            stopProtectionEffectForToken(token.id);
            return null;
        }
        if (existing.object !== object) {
            removeProtectionFilterFromObject(existing.object, existing.filter);
            existing.object = object;
            addProtectionFilterToObject(object, existing.filter);
        }
        return existing;
    }

    const object = getProtectionVisualObject(token);
    if (!object || object.destroyed) return null;
    const filter = createProtectionOutlineFilter();
    addProtectionFilterToObject(object, filter);

    const state = {
        token,
        object,
        filter,
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
    if (!canvas?.ready) {
        stopAllProtectionEffects();
        return;
    }

    const now = performance.now();
    for (const [tokenId, state] of activeProtectionEffects) {
        const token = canvas.tokens?.get(tokenId);
        if (!token || token.document?.hidden || !isVehicleActor(token.actor) || !isVehicleShieldAutomationEnabled(token.actor, token.document)) {
            stopProtectionEffectForToken(tokenId);
            continue;
        }

        state.token = token;
        drawProtectionEffect(state, now);
    }

    if (!activeProtectionEffects.size) stopProtectionTicker();
}

function drawProtectionEffect(state, now) {
    const { token, protection } = state;
    if (!token || !protection) return;

    const object = getProtectionVisualObject(token);
    if (!object || object.destroyed) {
        stopProtectionEffectForToken(token.id);
        return;
    }
    if (state.object !== object) {
        removeProtectionFilterFromObject(state.object, state.filter);
        state.object = object;
        addProtectionFilterToObject(object, state.filter);
    }

    const shieldOnline = protection.shield.online;
    const morphOnline = protection.morphogenetic.online;
    if (!shieldOnline && !morphOnline) {
        stopProtectionEffectForToken(token.id);
        return;
    }

    const pulse = (Math.sin((now / 900) + state.phase) + 1) / 2;
    const shieldColors = SHIELD_COLORS[protection.shield.type] ?? SHIELD_COLORS.B;
    const morphPulse = (Math.sin((now / 520) + state.phase * 1.7) + 1) / 2;
    const colors = morphOnline ? MORPHOGENETIC_COLORS : shieldColors;
    const activePulse = morphOnline ? morphPulse : pulse;
    const filter = state.filter;
    if (filter?.uniforms) {
        const metrics = getProtectionFilterMetrics(object, token, morphOnline && shieldOnline);
        filter.uniforms.outlineColor = numberToRgba(colors.primary);
        filter.uniforms.texelSize = metrics.texelSize;
        filter.uniforms.thickness = metrics.thickness;
        filter.uniforms.alpha = metrics.alpha + activePulse * 0.12;
        filter.uniforms.time = (now / 1000) + state.phase;
        filter.padding = metrics.padding;
    }
}

function createProtectionOutlineFilter() {
    const filter = new PIXI.Filter(undefined, PROTECTION_OUTLINE_FRAGMENT, {
        outlineColor: [1, 1, 1, 1],
        texelSize: [0.01, 0.01],
        thickness: 5.8,
        alpha: 0.68,
        time: 0
    });
    filter.padding = 42;
    filter.__fullSpeedAheadProtection = true;
    return filter;
}

function getProtectionVisualObject(token) {
    return token?.mesh ?? token?.icon ?? token?.children?.find(child => child?.texture) ?? null;
}

function addProtectionFilterToObject(object, filter) {
    if (!object || !filter) return;
    const filters = Array.isArray(object.filters) ? object.filters.filter(existing => !existing?.__fullSpeedAheadProtection) : [];
    filters.push(filter);
    object.filters = filters;
}

function removeProtectionFilterFromObject(object, filter) {
    if (!object) return;
    const filters = Array.isArray(object.filters) ? object.filters.filter(existing => existing !== filter && !existing?.__fullSpeedAheadProtection) : [];
    object.filters = filters.length ? filters : null;
}

function getProtectionFilterMetrics(object, token, dualProtection = false) {
    const width = Math.max(1, Number(object?.width) || Number(token?.w) || 1);
    const height = Math.max(1, Number(object?.height) || Number(token?.h) || 1);
    const shortestSide = Math.min(width, height);
    const sizeScale = clampVehicleCombatNumber(Math.sqrt(shortestSide / 420), 0.42, 1.08, 1);
    const baseThickness = dualProtection ? 6.4 : 5.4;
    const thickness = baseThickness * sizeScale;
    return {
        texelSize: [1 / width, 1 / height],
        thickness,
        alpha: 0.54 + sizeScale * 0.12,
        padding: Math.ceil(thickness * 6.8 + 8)
    };
}

function clampVehicleCombatNumber(value, min, max, fallback) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(max, Math.max(min, numeric));
}

function numberToRgba(color) {
    const numeric = Number(color) || 0xffffff;
    return [
        ((numeric >> 16) & 0xff) / 255,
        ((numeric >> 8) & 0xff) / 255,
        (numeric & 0xff) / 255,
        1
    ];
}

function stopProtectionEffectForToken(tokenId) {
    const state = activeProtectionEffects.get(tokenId);
    if (!state) return;
    removeProtectionFilterFromObject(state.object, state.filter);
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
    if (!shouldUseTokenMagicProtectionVisuals(protection)) {
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
        filterType: "glow",
        filterId: MORPHOGENETIC_FILTER_ID,
        outerStrength: 7,
        innerStrength: 0,
        color: MORPHOGENETIC_COLORS.primary,
        quality: 0.5,
        padding: 12,
        animated: {
            color: {
                active: true,
                loopDuration: 2400,
                animType: "colorOscillation",
                val1: MORPHOGENETIC_COLORS.primary,
                val2: MORPHOGENETIC_COLORS.secondary
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

function shouldUseBuiltInProtectionVisuals(protection = null) {
    const mode = getProtectionVisualMode(protection);
    return mode === VEHICLE_PROTECTION_VISUAL_MODES.BUILT_IN || mode === VEHICLE_PROTECTION_VISUAL_MODES.BOTH;
}

function shouldUseTokenMagicProtectionVisuals(protection = null) {
    const mode = getProtectionVisualMode(protection);
    return mode === VEHICLE_PROTECTION_VISUAL_MODES.TOKEN_MAGIC || mode === VEHICLE_PROTECTION_VISUAL_MODES.BOTH;
}

function getProtectionVisualMode(protection = null) {
    return getValidProtectionVisualMode(protection?.visualMode ?? game.settings.get(MODULE_ID, "vehicleProtectionVisualMode"));
}

function getValidProtectionVisualMode(value) {
    const mode = String(value ?? VEHICLE_PROTECTION_VISUAL_MODES.BUILT_IN);
    return Object.values(VEHICLE_PROTECTION_VISUAL_MODES).includes(mode) ? mode : VEHICLE_PROTECTION_VISUAL_MODES.BUILT_IN;
}

function getCrewMatchMode() {
    return getValidCrewMatchMode(game.settings.get(MODULE_ID, "vehicleCrewMatchMode"));
}

function getValidCrewMatchMode(value) {
    const mode = String(value ?? VEHICLE_CREW_MATCH_MODES.PLACEHOLDERS);
    return Object.values(VEHICLE_CREW_MATCH_MODES).includes(mode) ? mode : VEHICLE_CREW_MATCH_MODES.PLACEHOLDERS;
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
    for (const combatant of Array.from(combat.combatants ?? [])) await replaceVehicleCombatantWithCrew(combatant);
    await cleanupDuplicateVehicleCrewCombatants(combat);
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
        const skipped = [];
        const createPlaceholders = getCrewMatchMode() === VEHICLE_CREW_MATCH_MODES.PLACEHOLDERS;
        const rosterActorKeys = new Set();
        for (const row of rows) {
            const result = matchCrewActor(row, game.actors);
            if (result.actor) {
                const actorKey = result.actor.uuid || result.actor.id;
                if (rosterActorKeys.has(actorKey)) {
                    skipped.push(`${row.name} (already represented in crew initiative)`);
                    continue;
                }
                rosterActorKeys.add(actorKey);
            }
            if (result.actor || createPlaceholders) roster.push({ row, actor: result.actor });
            if (!result.actor) {
                const note = `${row.name} (${result.ambiguous ? "multiple Actors have this name" : "Actor not found"})`;
                if (createPlaceholders) warnings.push(note);
                else skipped.push(note);
            }
        }

        if (!roster.length) {
            ui.notifications.warn(`Full Speed Ahead found no matching sidebar actors for the crew of ${vehicle.name}. The vehicle was left in initiative.`);
            return;
        }

        const token = combatant.token;
        await grantCrewVehicleOwnership(combatant.combat, vehicle, roster.filter(({ actor }) => actor));
        await syncVehicleAbilityScoresFromCrew(vehicle, roster);
        const usedExistingCombatantIds = new Set();
        const createData = [];

        for (const { row, actor } of roster) {
            const crewFlag = {
                ...getCrewCombatantFlag(vehicle, token, row),
                artificial: !actor
            };
            const existing = actor ? findExistingActorCombatant(combatant.combat, actor, combatant.id, usedExistingCombatantIds) : null;
            if (existing) {
                usedExistingCombatantIds.add(existing.id);
                await existing.update({
                    [`flags.${MODULE_ID}.${CREW_COMBATANT_FLAG}`]: crewFlag
                }, { fullSpeedAheadCrew: true });
                continue;
            }

            createData.push({
                actorId: actor?.id ?? null,
                tokenId: null,
                hidden: combatant.hidden,
                initiative: null,
                name: actor?.name ?? row.name,
                img: actor?.img ?? DEFAULT_SILHOUETTE,
                flags: {
                    [MODULE_ID]: {
                        [CREW_COMBATANT_FLAG]: crewFlag
                    }
                }
            });
        }

        const created = createData.length
            ? await combatant.combat.createEmbeddedDocuments("Combatant", createData, { fullSpeedAheadCrew: true })
            : [];
        await combatant.delete({ fullSpeedAheadReplacedVehicle: true });
        await cleanupDuplicateVehicleCrewCombatants(combatant.combat);
        if (warnings.length) {
            ui.notifications.info(`Full Speed Ahead created silhouette combatants for unmatched crew of ${vehicle.name}: ${warnings.join(", ")}.`);
        }
        if (skipped.length) {
            ui.notifications.info(`Full Speed Ahead skipped unmatched crew for ${vehicle.name}: ${skipped.join(", ")}.`);
        }
        debugVehicleCombat("Replaced vehicle combatant", vehicle.name, { createData, created });
    } finally {
        processingCombatants.delete(combatant.uuid);
    }
}

function findExistingActorCombatant(combat, actor, replacingCombatantId, usedIds = new Set()) {
    if (!combat || !actor) return null;
    const candidates = getUnflaggedActorCombatants(combat, actor, replacingCombatantId)
        .filter(candidate => !usedIds.has(candidate.id));
    if (!candidates.length) return null;
    if (hasMultipleSceneTokensForActorInCombat(combat, actor, replacingCombatantId)) return null;
    return candidates[0] ?? null;
}

function getUnflaggedActorCombatants(combat, actor, excludedCombatantId = null) {
    if (!combat || !actor) return [];
    return Array.from(combat.combatants ?? []).filter(candidate => {
        if (!candidate || candidate.id === excludedCombatantId) return false;
        if (candidate.getFlag(MODULE_ID, CREW_COMBATANT_FLAG)) return false;
        return candidate.actor?.id === actor.id || candidate.actor?.uuid === actor.uuid;
    });
}

function hasMultipleSceneTokensForActorInCombat(combat, actor, excludedCombatantId = null) {
    const tokenIds = new Set(getUnflaggedActorCombatants(combat, actor, excludedCombatantId)
        .map(combatant => combatant.tokenId)
        .filter(Boolean));
    return tokenIds.size > 1;
}

async function cleanupDuplicateVehicleCrewCombatants(combat) {
    if (!combat) return;
    for (const crewCombatant of Array.from(combat.combatants ?? [])) {
        const data = crewCombatant.getFlag(MODULE_ID, CREW_COMBATANT_FLAG);
        if (!data || !crewCombatant.actor) continue;

        const existing = findExistingActorCombatant(combat, crewCombatant.actor, crewCombatant.id);
        if (!existing) continue;

        await existing.update({
            [`flags.${MODULE_ID}.${CREW_COMBATANT_FLAG}`]: data
        }, { fullSpeedAheadCrew: true });
        await crewCombatant.delete({ fullSpeedAheadRemovedDuplicateCrew: true });
    }
}

function queueVehicleCrewDuplicateCleanup(combat) {
    if (!game.user.isGM || !combat || !isVehicleCombatEnabled()) return;
    setTimeout(() => cleanupDuplicateVehicleCrewCombatants(combat).catch(error => debugVehicleCombat("Could not clean duplicate crew combatants.", error)), 0);
}

async function syncVehicleAbilityScoresFromCrew(vehicle, roster) {
    if (!vehicle || vehicle.type !== "vehicle") return;
    const updates = {};
    const best = new Map();

    for (const { row, actor } of roster) {
        if (!actor) continue;
        const abilityKey = normalizeCrewAbilityKey(row.ability);
        if (!abilityKey) continue;
        const actorScore = getActorAbilityScore(actor, abilityKey);
        if (actorScore === null) continue;

        const existing = best.get(abilityKey);
        if (existing && existing.score >= actorScore) continue;
        best.set(abilityKey, { score: actorScore, actor, row });
    }

    const synced = [];
    for (const [abilityKey, entry] of best) {
        updates[`system.abilities.${abilityKey}.value`] = entry.score;
        synced.push(`${abilityKey.toUpperCase()} ${entry.score} from ${entry.actor.name} (${entry.row.role})`);
    }
    if (!Object.keys(updates).length) return;
    await vehicle.update(updates, { fullSpeedAheadCrewAbilitySync: true });
    debugVehicleCombat(`Synced ${vehicle.name} crew ability scores`, synced);
}

function normalizeCrewAbilityKey(value) {
    return CREW_ABILITY_KEYS[String(value ?? "").trim().toLocaleLowerCase()] ?? null;
}

function getActorAbilityScore(actor, abilityKey) {
    const paths = [
        `system.abilities.${abilityKey}.value`,
        `data.data.abilities.${abilityKey}.value`
    ];
    for (const path of paths) {
        const score = Number(foundry.utils.getProperty(actor, path));
        if (Number.isFinite(score)) return score;
    }
    return null;
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
    const hideUnmatchedCrewPhotos = Boolean(safeGetModuleSetting("vehicleCombatHideUnmatchedCrewPhotos", true));

    for (const combatant of combat.combatants) {
        const data = combatant.getFlag(MODULE_ID, CREW_COMBATANT_FLAG);
        if (!data) continue;

        const row = html.find(`[data-combatant-id="${combatant.id}"]`);
        if (!row.length) continue;

        row.removeClass("full-speed-ahead-crew-full full-speed-ahead-crew-simple")
            .addClass(`full-speed-ahead-crew-combatant full-speed-ahead-crew-${mode}`).attr({
            "data-full-speed-ahead-vehicle-token-id": data.vehicleTokenId ?? "",
            title: `${data.role} (${data.ability}) - ${data.vehicleName}`
        });
        if (data.artificial) row.addClass("full-speed-ahead-crew-artificial");

        const crewName = combatant.name || "Crew";
        row.find(".full-speed-ahead-combat-row").remove();
        const controls = detachCombatantControls(row);
        row.empty().append(buildVehicleCombatantRow({ combatant, data, crewName, controls, hideUnmatchedCrewPhotos }));

        row.off("dblclick.fullSpeedAheadVehicleCombat").on("dblclick.fullSpeedAheadVehicleCombat", () => {
            const token = canvas.tokens?.get(data.vehicleTokenId);
            if (!token) return;
            canvas.animatePan({ x: token.center.x, y: token.center.y });
            token.control({ releaseOthers: true });
        });

        row.find(".full-speed-ahead-combat-ship").off("dblclick.fullSpeedAheadVehicleCombat").on("dblclick.fullSpeedAheadVehicleCombat", async event => {
            event.preventDefault();
            event.stopPropagation();
            await openCrewVehicleSheet(data);
        });

        row.off("contextmenu.fullSpeedAheadVehicleCombat").on("contextmenu.fullSpeedAheadVehicleCombat", event => {
            event.preventDefault();
            event.stopPropagation();
            showVehicleCrewContextMenu(event, combatant, data);
        });

        row.find(".full-speed-ahead-combat-initiative").off("click.fullSpeedAheadVehicleCombat");

    }
}

async function openCrewVehicleSheet(data) {
    const token = resolveCrewVehicleToken(data);
    const vehicle = token?.actor ?? await resolveCrewVehicleActor(data);
    if (!vehicle) return ui.notifications.warn("Full Speed Ahead could not find that vehicle actor.");
    if (!canOpenVehicleSheet(vehicle)) return ui.notifications.warn(`You do not have permission to open ${vehicle.name}.`);
    vehicle.sheet?.render(true);
}

function resolveCrewVehicleToken(data) {
    if (!data?.vehicleTokenId) return null;
    return canvas.tokens?.get(data.vehicleTokenId) ?? null;
}

async function resolveCrewVehicleActor(data) {
    if (!data) return null;
    const token = resolveCrewVehicleToken(data);
    if (token?.actor) return token.actor;
    const actor = data.vehicleActorId ? game.actors?.get(data.vehicleActorId) : null;
    if (actor) return actor;
    if (data.vehicleActorUuid && typeof fromUuid === "function") return fromUuid(data.vehicleActorUuid);
    return null;
}

function canOpenVehicleSheet(actor) {
    if (!actor) return false;
    if (game.user.isGM) return true;
    return actor.testUserPermission?.(game.user, "OWNER") ?? false;
}

function buildVehicleCombatantRow({ combatant, data, crewName, controls, hideUnmatchedCrewPhotos = true }) {
    const crewImg = combatant.img || DEFAULT_SILHOUETTE;
    const hideCrewPhoto = Boolean(data.artificial && hideUnmatchedCrewPhotos);
    const row = $(`<div class="full-speed-ahead-combat-row ${hideCrewPhoto ? "full-speed-ahead-combat-row-no-crew-photo" : ""}"></div>`);
    const movement = getCombatMovementStateForCrewData(data);
    const movementBar = buildVehicleMovementBar(movement);

    const vessel = $(`<div class="full-speed-ahead-combat-vessel">
        <img class="full-speed-ahead-combat-ship" src="${escapeHtml(data.vehicleImg)}" alt="${escapeHtml(data.vehicleName)}">
        ${movementBar}
    </div>`);
    const crewPortrait = $(`<div class="full-speed-ahead-combat-crew-wrap ${hideCrewPhoto ? "full-speed-ahead-combat-crew-empty" : ""}"></div>`);
    if (!hideCrewPhoto) {
        crewPortrait.append(`<img class="full-speed-ahead-combat-crew" src="${escapeHtml(crewImg)}" alt="${escapeHtml(crewName)}">`);
    }

    row.append(vessel);
    if (!hideCrewPhoto) row.append(crewPortrait);
    row.append(`<div class="full-speed-ahead-combat-name">
        <h4>${escapeHtml(crewName)}</h4>
        <div class="full-speed-ahead-combat-role">${escapeHtml(data.vehicleName)} / ${escapeHtml(data.role || "Crew")}</div>
    </div>`);
    row.append(buildVehicleCombatantInitiative(combatant));
    row.append($(`<div class="full-speed-ahead-combat-controls"></div>`).append(controls));
    return row;
}

function buildVehicleCombatantInitiative(combatant) {
    const raw = Number(combatant?.initiative);
    const label = Number.isFinite(raw) ? raw.toFixed(2).replace(/\.?0+$/u, "") : "-";
    const title = game.user.isGM ? "Right-click row for combatant actions." : "Initiative";
    return $(`<div class="full-speed-ahead-combat-initiative" title="${escapeHtml(title)}">${escapeHtml(label)}</div>`);
}

function closeVehicleCrewContextMenu() {
    activeVehicleCombatContextMenu?.remove();
    activeVehicleCombatContextMenu = null;
    $(document).off(".fullSpeedAheadVehicleCombatMenu");
}

function showVehicleCrewContextMenu(event, combatant, data) {
    closeVehicleCrewContextMenu();
    if (!combatant) return;

    const canManage = Boolean(game.user.isGM);
    const menu = $(`<div class="full-speed-ahead-combat-context-menu"></div>`);
    const actions = [
        { icon: "fas fa-edit", label: "Update Combatant", handler: () => openVehicleCrewCombatantConfig(combatant), enabled: canManage },
        { icon: "fas fa-undo", label: "Reset movement history", handler: () => resetVehicleCrewMovementHistory(data), enabled: canManage },
        { icon: "fas fa-dice-d20", label: "Re-roll Initiative", handler: () => rerollVehicleCrewInitiative(combatant), enabled: canManage },
        { icon: "fas fa-trash", label: "Remove Combatant", handler: () => removeVehicleCrewCombatant(combatant), enabled: canManage }
    ];

    for (const action of actions) {
        const button = $(`<button type="button" ${action.enabled ? "" : "disabled"}>
            <i class="${action.icon}"></i>
            <span>${escapeHtml(action.label)}</span>
        </button>`);
        button.on("click", async clickEvent => {
            clickEvent.preventDefault();
            clickEvent.stopPropagation();
            closeVehicleCrewContextMenu();
            if (!action.enabled) return;
            try {
                await action.handler();
            } catch (error) {
                ui.notifications.error(error.message || `Full Speed Ahead could not ${action.label.toLowerCase()}.`);
            }
        });
        menu.append(button);
    }

    $("body").append(menu);
    activeVehicleCombatContextMenu = menu;
    const width = menu.outerWidth() || 260;
    const height = menu.outerHeight() || 190;
    const left = Math.min(event.clientX, window.innerWidth - width - 8);
    const top = Math.min(event.clientY, window.innerHeight - height - 8);
    menu.css({ left: Math.max(8, left), top: Math.max(8, top) });

    setTimeout(() => {
        $(document).on("mousedown.fullSpeedAheadVehicleCombatMenu keydown.fullSpeedAheadVehicleCombatMenu", closeEvent => {
            if (closeEvent.type === "keydown" && closeEvent.key !== "Escape") return;
            if (closeEvent.type === "mousedown" && $(closeEvent.target).closest(".full-speed-ahead-combat-context-menu").length) return;
            closeVehicleCrewContextMenu();
        });
    }, 0);
}

function openVehicleCrewCombatantConfig(combatant) {
    if (!combatant || !game.user.isGM) return;
    if (typeof CombatantConfig === "function") return new CombatantConfig(combatant).render(true);
    combatant.sheet?.render?.(true);
}

async function resetVehicleCrewMovementHistory(data) {
    if (!game.user.isGM) return;
    const state = getCombatMovementStateForCrewData(data);
    if (!state) return ui.notifications.warn("Full Speed Ahead could not find active movement history for that vehicle.");
    const ledger = getCombatMovementLedger(state.combat);
    delete ledger.vehicles[state.vehicleKey];
    await state.combat.setFlag(MODULE_ID, VEHICLE_COMBAT_MOVEMENT_FLAG, ledger);
    refreshCombatMovementDisplays();
}

async function rerollVehicleCrewInitiative(combatant) {
    if (!combatant || !game.user.isGM) return;
    const combat = combatant.combat;
    if (!combat) return;
    if (typeof combat.rollInitiative === "function") {
        await combat.rollInitiative([combatant.id], { updateTurn: true });
    } else {
        await combatant.rollInitiative?.();
    }
    ui.combat?.render(true);
}

async function removeVehicleCrewCombatant(combatant) {
    if (!combatant || !game.user.isGM) return;
    try {
        await combatant.delete();
        ui.combat?.render(true);
    } catch (error) {
        ui.notifications.error(error.message || "Full Speed Ahead could not remove that combatant.");
    }
}

function getCombatMovementStateForCrewData(data) {
    if (!data) return null;
    const tokenDocument = canvas?.scene?.tokens?.get?.(data.vehicleTokenId) ?? canvas?.tokens?.get?.(data.vehicleTokenId)?.document ?? null;
    if (tokenDocument) return getCombatMovementStateForTokenOrActor(tokenDocument);

    const actor = data.vehicleActorId ? game.actors?.get(data.vehicleActorId) : null;
    return actor ? getCombatMovementStateForTokenOrActor(actor) : null;
}

function buildVehicleMovementBar(state) {
    if (!state) return "";
    const percent = state.speed > 0 ? clampVehicleCombatNumber(state.remaining / state.speed, 0, 1, 0) : 0;
    const color = percent <= 0.25 ? "#d93636" : percent <= 0.5 ? "#f0a020" : "#1fb84f";
    const label = `${Math.round(state.remaining * 10) / 10} / ${Math.round(state.speed * 10) / 10} ${state.unit}`;
    return `<div class="full-speed-ahead-movement-bar" title="Shared movement remaining: ${escapeHtml(label)}">
        <div class="full-speed-ahead-movement-fill" style="--fsa-movement-percent: ${percent * 100}%; --fsa-movement-color: ${color};"></div>
    </div>`;
}

function detachCombatantControls(row) {
    const controls = row.find(".token-initiative").detach();
    row.find(".combatant-controls").remove();
    return controls;
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
    if (!raw) return null;

    const abilityRoleMatch = raw.match(/^\s*\(([^)]+)\)\s*([^:]+?)\s*:\s*(.+?)\s*$/u);
    if (abilityRoleMatch) {
        const [, ability, role, rawName] = abilityRoleMatch;
        const name = cleanCrewName(rawName);
        if (!ability.trim() || !role.trim() || !name) return null;
        return {
            ability: ability.trim(),
            role: role.trim(),
            name,
            rawName: rawName.trim(),
            source: raw
        };
    }

    const roleMatch = raw.match(/^\s*([^:]+?)\s*:\s*(.+?)\s*$/u);
    if (roleMatch) {
        const [, role, rawName] = roleMatch;
        const name = cleanCrewName(rawName);
        if (!role.trim() || !name) return null;
        return {
            ability: "",
            role: cleanCrewRole(role),
            name,
            rawName: rawName.trim(),
            source: raw
        };
    }

    const wantedMatch = raw.match(/^\s*\[([^\]]+)\]\s*(.+?)\s*$/u);
    if (wantedMatch) {
        const [, tag, rawName] = wantedMatch;
        const name = cleanCrewName(rawName);
        if (!name) return null;
        return {
            ability: "",
            role: cleanCrewRole(tag),
            name,
            rawName: rawName.trim(),
            source: raw
        };
    }

    const name = cleanCrewName(raw);
    if (!name) return null;

    return {
        ability: "",
        role: "Crew",
        name,
        rawName: raw,
        source: raw
    };
}

function cleanCrewRole(value) {
    return String(value ?? "")
        .normalize("NFKC")
        .trim()
        .replace(/^\[([\s\S]*)\]$/, "$1")
        .replace(/\s+/g, " ");
}

function cleanCrewName(value) {
    return String(value ?? "")
        .normalize("NFKC")
        .trim()
        .replace(/^\[([\s\S]*)\]$/, "$1")
        .replace(/^\[([^\]]+)\]\s*/u, "")
        .split(/\s*,\s*/u)[0]
        .replace(/\s+/g, " ")
        .trim();
}

function matchCrewActor(entry, actors) {
    if (!entry) return { actor: null, ambiguous: false, candidates: [] };

    const entryName = normalizeCrewName(entry.name);
    const candidates = Array.from(actors ?? []).filter(actor => {
        const actorName = normalizeCrewName(actor.name);
        return actorName === entryName || actorName.startsWith(`${entryName} `) || entryName.startsWith(`${actorName} `);
    });
    const exact = candidates.filter(actor => normalizeCrewName(actor.name) === entryName);
    const startsWithBoundary = candidates.filter(actor => normalizeCrewName(actor.name).startsWith(`${entryName} `));
    const ranked = exact.length ? exact : startsWithBoundary.length ? startsWithBoundary : candidates;
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

function escapeRegExp(value) {
    return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
