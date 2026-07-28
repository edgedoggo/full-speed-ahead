// vehicle-combat.js: Send vehicle crew members to combat instead of the vehicle.

const MODULE_ID = "full-speed-ahead";
const CREW_COMBATANT_FLAG = "crewCombatant";
const VEHICLE_COMBAT_OWNERSHIP_FLAG = "vehicleCombatOwnership";
const DEFAULT_SHIP_BADGE = "icons/svg/wing.svg";
const DEFAULT_SILHOUETTE = "icons/svg/mystery-man.svg";
const SHIELD_FILTER_ID = "fullSpeedAheadVehicleShield";
const VEHICLE_COMBAT_DISPLAY_MODES = {
    FULL: "full",
    SIMPLE: "simple"
};
const SHIELD_COLORS = {
    A: { val1: 0xe60000, val2: 0xff5050 },
    B: { val1: 0x5099dd, val2: 0x90eeff },
    C: { val1: 0x00cc66, val2: 0x99ff33 },
    D: { val1: 0xffff00, val2: 0xffff99 },
    PRISMATIC: { val1: 0x9999ff, val2: 0xff00ff }
};
const VEHICLE_CREW_PATHS = [
    "system.cargo.crew",
    "system.details.crew",
    "system.traits.crew"
];
const processingCombatants = new Set();

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
        hint: "Use Shield Generator equipment HP to turn vehicle shield visuals on or off. Requires TokenMagic FX for the glow.",
        type: Boolean,
        default: false,
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
Hooks.on("canvasReady", () => syncVehicleShields());
Hooks.on("createCombatant", combatant => replaceVehicleCombatantWithCrew(combatant));
Hooks.on("renderCombatTracker", (app, html) => renderVehicleCrewTracker(app, html));
Hooks.on("deleteCombat", combat => restoreVehicleCombatOwnership(combat));
Hooks.on("drawToken", token => syncVehicleShieldForToken(token));
Hooks.on("updateToken", tokenDocument => {
    const token = canvas.tokens?.get(tokenDocument.id);
    if (token) syncVehicleShieldForToken(token);
});
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
    return game.user?.isGM && canvas?.ready && isVehicleShieldAutomationEnabled();
}

async function syncVehicleShields() {
    if (!game.user?.isGM || !canvas?.ready || !canvas.tokens) return;

    if (!isVehicleShieldAutomationEnabled()) {
        await Promise.all((canvas.tokens.placeables ?? []).map(token => removeVehicleShieldFilter(token)));
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
        await removeVehicleShieldFilter(token);
        return;
    }

    const shield = getVehicleShieldStatus(token.actor);
    if (!shield.online) {
        await removeVehicleShieldFilter(token);
        return;
    }

    await applyVehicleShieldFilter(token, shield.type);
}

function getVehicleShieldStatus(actor) {
    const shieldModule = findVehicleShieldGenerator(actor);
    if (!shieldModule) return { online: false, reason: "missing" };

    const type = getBracketedModuleType(shieldModule.name);
    const hp = getItemHp(shieldModule);
    if (!type || !SHIELD_COLORS[type]) return { online: false, reason: "invalid-type", hp, type };
    return { online: hp > 0, hp, type };
}

function findVehicleShieldGenerator(actor) {
    return Array.from(actor?.items ?? []).find(item => isVehicleShieldRelevantItem(item) && /shield generator/i.test(item.name ?? ""));
}

function isVehicleShieldRelevantItem(item) {
    return item?.type === "equipment" && /shield generator/i.test(item.name ?? "");
}

function getBracketedModuleType(name) {
    const match = String(name ?? "").match(/\[([^\]]+)\]/);
    return match?.[1]?.trim().toLocaleUpperCase() ?? null;
}

function getItemHp(item) {
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
            if (Number.isFinite(nested)) return nested;
            continue;
        }

        const numeric = Number(value);
        if (Number.isFinite(numeric)) return numeric;
    }

    return 0;
}

async function applyVehicleShieldFilter(token, shieldType) {
    if (!isTokenMagicAvailable()) {
        debugVehicleCombat("TokenMagic FX not available for vehicle shield automation.");
        return;
    }

    const colors = SHIELD_COLORS[shieldType];
    const params = [{
        filterType: "glow",
        filterId: SHIELD_FILTER_ID,
        outerStrength: 6,
        innerStrength: 0,
        color: colors.val1,
        quality: 0.5,
        padding: 10,
        animated: {
            color: {
                active: true,
                loopDuration: 3000,
                animType: "colorOscillation",
                val1: colors.val1,
                val2: colors.val2
            }
        }
    }];

    try {
        if (globalThis.TokenMagic.hasFilterId?.(token, SHIELD_FILTER_ID)) {
            await globalThis.TokenMagic.addUpdateFilters(token, params);
            return;
        }

        await globalThis.TokenMagic.addUpdateFilters(token, params);
    } catch (error) {
        console.warn(`${MODULE_ID} vehicle combat | Could not apply vehicle shield filter.`, error);
    }
}

async function removeVehicleShieldFilter(token) {
    if (!token || !isTokenMagicAvailable()) return;
    try {
        if (!globalThis.TokenMagic.hasFilterId?.(token, SHIELD_FILTER_ID)) return;
        await globalThis.TokenMagic.deleteFilters(token, SHIELD_FILTER_ID);
    } catch (error) {
        console.warn(`${MODULE_ID} vehicle combat | Could not remove vehicle shield filter.`, error);
    }
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
