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
const VEHICLE_CREW_MATCH_MODES = {
    PLACEHOLDERS: "placeholders",
    MATCH_ONLY: "match-only"
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
const MORPHOGENETIC_COLORS = { primary: 0x9b4dff, secondary: 0xe2b7ff };
const PROTECTION_OUTLINE_FRAGMENT = `
precision mediump float;

varying vec2 vTextureCoord;
uniform sampler2D uSampler;
uniform vec4 outlineColor;
uniform vec2 texelSize;
uniform float thickness;
uniform float alpha;

float sampleAlpha(vec2 coord) {
    if (coord.x < 0.0 || coord.x > 1.0 || coord.y < 0.0 || coord.y > 1.0) return 0.0;
    return texture2D(uSampler, coord).a;
}

void main(void) {
    vec4 base = texture2D(uSampler, vTextureCoord);
    float neighborAlpha = 0.0;

    for (int ring = 1; ring <= 18; ring++) {
        float radius = float(ring);
        if (radius <= thickness) {
            vec2 offset = texelSize * radius;
            float falloff = 1.0 - ((radius - 1.0) / max(thickness, 1.0));
            neighborAlpha = max(neighborAlpha, sampleAlpha(vTextureCoord + vec2(offset.x, 0.0)) * falloff);
            neighborAlpha = max(neighborAlpha, sampleAlpha(vTextureCoord + vec2(-offset.x, 0.0)) * falloff);
            neighborAlpha = max(neighborAlpha, sampleAlpha(vTextureCoord + vec2(0.0, offset.y)) * falloff);
            neighborAlpha = max(neighborAlpha, sampleAlpha(vTextureCoord + vec2(0.0, -offset.y)) * falloff);
            neighborAlpha = max(neighborAlpha, sampleAlpha(vTextureCoord + vec2(offset.x, offset.y)) * falloff);
            neighborAlpha = max(neighborAlpha, sampleAlpha(vTextureCoord + vec2(-offset.x, offset.y)) * falloff);
            neighborAlpha = max(neighborAlpha, sampleAlpha(vTextureCoord + vec2(offset.x, -offset.y)) * falloff);
            neighborAlpha = max(neighborAlpha, sampleAlpha(vTextureCoord + vec2(-offset.x, -offset.y)) * falloff);
        }
    }

    float outline = max(neighborAlpha - base.a, 0.0);
    float glow = smoothstep(0.0, 0.7, outline) * (1.0 - base.a);
    vec3 color = mix(base.rgb, outlineColor.rgb, glow);
    gl_FragColor = vec4(color, max(base.a, outlineColor.a * alpha * glow));
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
let protectionTicker = null;

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
            vehicleCombatShipIcon: game.settings.get(MODULE_ID, "vehicleCombatShipIcon"),
            vehicleCombatDebug: game.settings.get(MODULE_ID, "vehicleCombatDebug"),
            vehicleOpsEnabled: safeGetModuleSetting("vehicleOpsEnabled", true),
            vehicleOpsShowFloatingMenuGM: safeGetModuleSetting("vehicleOpsShowFloatingMenuGM", true),
            vehicleOpsShowFloatingMenuPlayers: safeGetModuleSetting("vehicleOpsShowFloatingMenuPlayers", false),
            vehicleOpsScansEnabled: safeGetModuleSetting("vehicleOpsScansEnabled", true),
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
            vehicleOpsInsuranceCodeRequired: safeGetModuleSetting("vehicleOpsInsuranceCodeRequired", false),
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
        await game.settings.set(MODULE_ID, "vehicleCrewMatchMode", getValidCrewMatchMode(formData.vehicleCrewMatchMode));
        await game.settings.set(MODULE_ID, "vehicleCombatDisplayMode", String(formData.vehicleCombatDisplayMode || VEHICLE_COMBAT_DISPLAY_MODES.FULL));
        await game.settings.set(MODULE_ID, "vehicleCombatShipIcon", String(formData.vehicleCombatShipIcon || DEFAULT_SHIP_BADGE).trim());
        await game.settings.set(MODULE_ID, "vehicleCombatDebug", Boolean(formData.vehicleCombatDebug));
        await safeSetModuleSetting("vehicleOpsEnabled", Boolean(formData.vehicleOpsEnabled));
        await safeSetModuleSetting("vehicleOpsShowFloatingMenuGM", Boolean(formData.vehicleOpsShowFloatingMenuGM));
        await safeSetModuleSetting("vehicleOpsShowFloatingMenuPlayers", Boolean(formData.vehicleOpsShowFloatingMenuPlayers));
        await safeSetModuleSetting("vehicleOpsScansEnabled", Boolean(formData.vehicleOpsScansEnabled));
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
        default: false,
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
        syncVehicleShields
    };
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
        filter.uniforms.outlineColor = numberToRgba(colors.primary);
        filter.uniforms.texelSize = getProtectionTexelSize(object, token);
        filter.uniforms.thickness = morphOnline && shieldOnline ? 18 : 14;
        filter.uniforms.alpha = 0.72 + activePulse * 0.18;
        filter.padding = 48;
    }
}

function createProtectionOutlineFilter() {
    const filter = new PIXI.Filter(undefined, PROTECTION_OUTLINE_FRAGMENT, {
        outlineColor: [1, 1, 1, 1],
        texelSize: [0.01, 0.01],
        thickness: 8,
        alpha: 0.5
    });
    filter.padding = 32;
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

function getProtectionTexelSize(object, token) {
    const width = Math.max(1, Number(object?.width) || Number(token?.w) || 1);
    const height = Math.max(1, Number(object?.height) || Number(token?.h) || 1);
    return [1 / width, 1 / height];
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
        const skipped = [];
        const createPlaceholders = getCrewMatchMode() === VEHICLE_CREW_MATCH_MODES.PLACEHOLDERS;
        for (const row of rows) {
            const result = matchCrewActor(row, game.actors);
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
        await syncVehicleAbilityScoresFromCrew(vehicle, roster);
        const created = await combatant.combat.createEmbeddedDocuments("Combatant", createData, { fullSpeedAheadCrew: true });
        await combatant.delete({ fullSpeedAheadReplacedVehicle: true });
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
    const badgeIcon = game.settings.get(MODULE_ID, "vehicleCombatShipIcon") || DEFAULT_SHIP_BADGE;

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
        row.empty().append(buildVehicleCombatantRow({ combatant, data, mode, badgeIcon, crewName, controls }));

        row.off("dblclick.fullSpeedAheadVehicleCombat").on("dblclick.fullSpeedAheadVehicleCombat", () => {
            const token = canvas.tokens?.get(data.vehicleTokenId);
            if (!token) return;
            canvas.animatePan({ x: token.center.x, y: token.center.y });
            token.control({ releaseOthers: true });
        });
    }
}

function buildVehicleCombatantRow({ combatant, data, mode, badgeIcon, crewName, controls }) {
    const full = mode === VEHICLE_COMBAT_DISPLAY_MODES.FULL;
    const row = $(`<div class="full-speed-ahead-combat-row"></div>`);
    const images = $(`<div class="full-speed-ahead-combat-images"></div>`);
    const crewImg = combatant.img || DEFAULT_SILHOUETTE;

    if (full) {
        images.append(`<img class="full-speed-ahead-combat-ship" src="${escapeHtml(data.vehicleImg)}" alt="${escapeHtml(data.vehicleName)}">`);
    }

    const crewPortrait = $(`<div class="full-speed-ahead-combat-crew-wrap">
        <img class="full-speed-ahead-combat-crew" src="${escapeHtml(crewImg)}" alt="${escapeHtml(crewName)}">
    </div>`);
    if (!full) crewPortrait.append(`<img class="full-speed-ahead-ship-badge" src="${escapeHtml(badgeIcon)}" alt="">`);
    images.append(crewPortrait);

    const label = full ? `${data.vehicleName} / ${crewName}` : crewName;
    row.append(images);
    row.append(`<div class="full-speed-ahead-combat-name"><h4>${escapeHtml(label)}</h4></div>`);
    row.append($(`<div class="full-speed-ahead-combat-controls"></div>`).append(controls));
    return row;
}

function detachCombatantControls(row) {
    const controls = [];
    row.find(".token-initiative, .combatant-controls").each((_index, element) => {
        controls.push(element);
    });
    return $(controls).detach();
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
