// main.js: Full Speed Ahead Module

const MODULE_ID = "full-speed-ahead";
const INTERNAL_MOVE = "fullSpeedAheadInternalMove";
const LOG_PREFIX = "[Full Speed Ahead]";
const THRUSTER_COLOR_FLAG = "thrusterColor";
const SHIP_PROFILE_FLAG = "shipProfileName";
const SHIP_PROFILES_SETTING = "shipProfiles";
const SCENE_THRUSTER_PROFILES_SETTING = "sceneThrusterProfiles";
const DISABLED_VEHICLE_DRAG_SCENES_SETTING = "disabledVehicleDragScenes";
const DISABLED_TARGETING_CARD_ACTORS_SETTING = "disabledTargetingCardActors";
const DISABLED_TARGETING_CARD_USERS_SETTING = "disabledTargetingCardUsers";
const DISABLED_CHARACTER_CARD_USERS_SETTING = "disabledCharacterTargetingCardUsers";
const DISABLED_VEHICLE_CARD_USERS_SETTING = "disabledVehicleTargetingCardUsers";
const STANDALONE_QUICKTARGET_MODULE_IDS = ["quicktarget", "quick-target", "vehicle-quicktarget", "vehicle-quick-target"];
const DEFAULT_MOVEMENT_SOUND_PATH = "modules/full-speed-ahead/sounds/lockon.ogg";
const DEFAULT_THRUSTER_COLOR = "#40c7ff";
const VEHICLE_HOVER_LOOP_MS = 5000;
const VEHICLE_HOVER_MAX_START_OFFSET_MS = 3000;
const VEHICLE_BOW_OFFSETS = {
    north: 0,
    east: -90,
    south: 180,
    west: 90
};
const VEHICLE_PROTECTION_VISUAL_MODES = {
    BUILT_IN: "built-in",
    TOKEN_MAGIC: "token-magic",
    BOTH: "both"
};
const lastTokenPositions = new Map();
const activeMotionEffects = new Map();
const activeVehicleHovers = new Map();
let activeThrusterPreview = null;
let vehicleHoverTicker = null;
let lastVehicleDragLockWarningAt = 0;

class FullSpeedAheadEffectsConfig extends FormApplication {
    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "full-speed-ahead-effects-config",
            title: "Full Speed Ahead: Movement Effects",
            template: `modules/${MODULE_ID}/templates/effects-settings.hbs`,
            width: 520,
            closeOnSubmit: true,
            tabs: [{ navSelector: ".tabs", contentSelector: ".fsa-effects-body", initial: "general" }]
        });
    }

    get tokenDocument() {
        return this.object?.documentName === "Token" ? this.object : null;
    }

    getData() {
        const tokenDocument = this.tokenDocument;
        const shipNames = collectVehicleShipNames();
        const focusedShipName = tokenDocument ? getShipProfileName(tokenDocument) : shipNames[0] ?? "";
        const focusedProfile = getShipProfile(focusedShipName);
        const fallbackColor = game.settings.get(MODULE_ID, "thrusterColor") || DEFAULT_THRUSTER_COLOR;
        const movementSound = getMovementSoundOptions(tokenDocument, focusedProfile);
        const dimensions = getThrusterDimensionsForProfile(canvas.scene?.id, focusedShipName);
        const rotationSettings = getProfileRotationSettings(focusedProfile);
        const hoverSettings = getProfileHoverSettings(focusedProfile);
        const protectionSettings = getProfileProtectionSettings(focusedProfile);
        const bowFacing = rotationSettings.vehicleBowFacing;

        return {
            enableMovementSound: movementSound.enabled,
            movementSoundPath: movementSound.src,
            movementSoundVolume: movementSound.volume,
            enableThrusterEffect: getProfileBoolean(focusedProfile, "enableThrusterEffect", "enableThrusterEffect"),
            enableShipRotation: rotationSettings.enableShipRotation,
            rotateBeforeMove: rotationSettings.rotateBeforeMove,
            rotationDelayMs: rotationSettings.rotationDelayMs,
            rotationFinishSquares: rotationSettings.rotationFinishSquares,
            rotationOffset: rotationSettings.rotationOffset,
            enableVehicleHoverEffect: hoverSettings.enabled,
            hoverOffsetX: hoverSettings.offsetX,
            hoverOffsetY: hoverSettings.offsetY,
            hoverSpeed: hoverSettings.speed,
            vehicleShieldAutomation: protectionSettings.enabled,
            vehicleProtectionVisualMode: protectionSettings.visualMode,
            protectionVisualModes: [
                {
                    value: VEHICLE_PROTECTION_VISUAL_MODES.BUILT_IN,
                    label: "Built-In FSA Glow",
                    selected: protectionSettings.visualMode === VEHICLE_PROTECTION_VISUAL_MODES.BUILT_IN
                },
                {
                    value: VEHICLE_PROTECTION_VISUAL_MODES.TOKEN_MAGIC,
                    label: "TokenMagic FX",
                    selected: protectionSettings.visualMode === VEHICLE_PROTECTION_VISUAL_MODES.TOKEN_MAGIC
                },
                {
                    value: VEHICLE_PROTECTION_VISUAL_MODES.BOTH,
                    label: "Built-In + TokenMagic",
                    selected: protectionSettings.visualMode === VEHICLE_PROTECTION_VISUAL_MODES.BOTH
                }
            ],
            bowOptions: ["north", "east", "south", "west"].map(value => ({
                value,
                label: value.charAt(0).toUpperCase() + value.slice(1),
                selected: value === bowFacing
            })),
            thrusterScale: dimensions.scale,
            thrusterPosition: dimensions.position,
            thrusterLength: dimensions.length,
            thrusterWidth: dimensions.width,
            thrusterInverted: dimensions.cones[0]?.inverted,
            coneCount: dimensions.coneCount,
            coneSpacing: dimensions.coneSpacing,
            extraCones: dimensions.cones.slice(1).map((cone, index) => ({ ...cone, letter: index === 0 ? "A" : "B", index: index + 1 })),
            shipName: focusedShipName,
            tokenName: tokenDocument ? getDefaultShipProfileName(tokenDocument) : "",
            profileAssigned: tokenDocument ? getAssignedShipProfileName(tokenDocument) === focusedShipName : false,
            shipOptions: shipNames.map(name => ({ name, selected: name === focusedShipName })),
            hasShipProfiles: shipNames.length > 0 || Boolean(focusedShipName),
            isTokenConfig: Boolean(tokenDocument),
            shipThrusterColor: focusedProfile?.thrusterColor ?? fallbackColor
        };
    }

    activateListeners(html) {
        super.activateListeners(html);

        html.find(".tabs .item").on("click", () => this.fitWindowToContent(html));

        html.find('[data-action="browse-sound"]').on("click", event => {
            event.preventDefault();
            const input = html.find('[name="movementSoundPath"]');
            new FilePicker({
                type: "audio",
                current: input.val() || "",
                callback: path => input.val(path).trigger("input")
            }).render(true);
        });

        html.find("[data-sync-range]").on("input", event => {
            const key = event.currentTarget.dataset.syncRange;
            html.find(`[data-sync-number="${key}"]`).val(event.currentTarget.value);
            this.previewFromForm(html);
        });

        html.find("[data-sync-number]").on("input change", event => {
            const key = event.currentTarget.dataset.syncNumber;
            html.find(`[data-sync-range="${key}"]`).val(event.currentTarget.value);
            this.previewFromForm(html);
        });

        html.find('[data-color-picker]').on("input", event => {
            const target = event.currentTarget.dataset.colorPicker;
            html.find(`[data-color-text="${target}"]`).val(event.currentTarget.value);
            this.previewFromForm(html);
        });

        html.find('[data-color-text]').on("input change", event => {
            const value = event.currentTarget.value.trim();
            if (!/^#[0-9a-f]{6}$/i.test(value)) return;

            const target = event.currentTarget.dataset.colorText;
            html.find(`[data-color-picker="${target}"]`).val(value);
            this.previewFromForm(html);
        });

        html.find('[name="coneCount"]').on("input change", () => {
            this.updateConeVisibility(html);
            this.previewFromForm(html);
            this.fitWindowToContent(html);
        });
        html.find('[name="enableThrusterEffect"]').on("change", () => {
            this.updateThrusterControlsVisibility(html);
            this.previewFromForm(html);
            this.fitWindowToContent(html);
        });
        html.find('[name="thrusterInverted"], [name^="extraCone"][name$="Inverted"]').on("change", () => this.previewFromForm(html));

        html.find('[name="shipProfileName"]').on("change", event => {
            const profileName = event.currentTarget.value;
            const profile = getShipProfile(profileName);
            const fallbackColor = game.settings.get(MODULE_ID, "thrusterColor") || DEFAULT_THRUSTER_COLOR;
            const movementSound = getMovementSoundOptions(null, profile);
            const dimensions = getThrusterDimensionsForProfile(canvas.scene?.id, profileName);
            const rotationSettings = getProfileRotationSettings(profile);
            const hoverSettings = getProfileHoverSettings(profile);
            const protectionSettings = getProfileProtectionSettings(profile);
            const color = profile?.thrusterColor ?? fallbackColor;
            html.find('[name="enableMovementSound"]').prop("checked", Boolean(movementSound.enabled));
            html.find('[name="movementSoundPath"]').val(movementSound.src);
            html.find('[name="movementSoundVolume"]').val(movementSound.volume);
            html.find('[data-sync-number="movementSoundVolume"]').val(movementSound.volume);
            html.find('[name="enableThrusterEffect"]').prop("checked", getProfileBoolean(profile, "enableThrusterEffect", "enableThrusterEffect"));
            html.find('[name="thrusterScale"]').val(dimensions.scale);
            html.find('[data-sync-number="thrusterScale"]').val(dimensions.scale);
            html.find('[name="thrusterPosition"]').val(dimensions.position);
            html.find('[data-sync-number="thrusterPosition"]').val(dimensions.position);
            html.find('[name="thrusterLength"]').val(dimensions.length);
            html.find('[data-sync-number="thrusterLength"]').val(dimensions.length);
            html.find('[name="thrusterWidth"]').val(dimensions.width);
            html.find('[data-sync-number="thrusterWidth"]').val(dimensions.width);
            html.find('[name="thrusterInverted"]').prop("checked", Boolean(dimensions.cones[0]?.inverted));
            html.find('[name="coneCount"]').val(dimensions.coneCount);
            html.find('[data-sync-number="coneCount"]').val(dimensions.coneCount);
            html.find('[name="coneSpacing"]').val(dimensions.coneSpacing);
            html.find('[data-sync-number="coneSpacing"]').val(dimensions.coneSpacing);
            dimensions.cones.slice(1).forEach((cone, index) => {
                const number = index + 1;
                html.find(`[name="extraCone${number}Color"]`).val(cone.color);
                html.find(`[data-color-text="extraCone${number}Color"]`).val(cone.color);
                html.find(`[name="extraCone${number}Length"]`).val(cone.length);
                html.find(`[data-sync-number="extraCone${number}Length"]`).val(cone.length);
                html.find(`[name="extraCone${number}Width"]`).val(cone.width);
                html.find(`[data-sync-number="extraCone${number}Width"]`).val(cone.width);
                html.find(`[name="extraCone${number}Inverted"]`).prop("checked", Boolean(cone.inverted));
            });
            html.find('[name="shipThrusterColor"]').val(color);
            html.find('[data-color-text="shipThrusterColor"]').val(color);
            html.find('[name="vehicleBowFacing"]').val(rotationSettings.vehicleBowFacing);
            html.find('[name="enableShipRotation"]').prop("checked", Boolean(rotationSettings.enableShipRotation));
            html.find('[name="rotateBeforeMove"]').prop("checked", Boolean(rotationSettings.rotateBeforeMove));
            html.find('[name="rotationDelayMs"]').val(rotationSettings.rotationDelayMs);
            html.find('[data-sync-number="rotationDelayMs"]').val(rotationSettings.rotationDelayMs);
            html.find('[name="rotationFinishSquares"]').val(rotationSettings.rotationFinishSquares);
            html.find('[data-sync-number="rotationFinishSquares"]').val(rotationSettings.rotationFinishSquares);
            html.find('[name="rotationOffset"]').val(rotationSettings.rotationOffset);
            html.find('[data-sync-number="rotationOffset"]').val(rotationSettings.rotationOffset);
            html.find('[name="enableVehicleHoverEffect"]').prop("checked", Boolean(hoverSettings.enabled));
            html.find('[name="hoverOffsetX"]').val(hoverSettings.offsetX);
            html.find('[data-sync-number="hoverOffsetX"]').val(hoverSettings.offsetX);
            html.find('[name="hoverOffsetY"]').val(hoverSettings.offsetY);
            html.find('[data-sync-number="hoverOffsetY"]').val(hoverSettings.offsetY);
            html.find('[name="hoverSpeed"]').val(hoverSettings.speed);
            html.find('[data-sync-number="hoverSpeed"]').val(hoverSettings.speed);
            html.find('[name="vehicleShieldAutomation"]').prop("checked", Boolean(protectionSettings.enabled));
            html.find('[name="vehicleProtectionVisualMode"]').val(protectionSettings.visualMode);
            this.updateConeVisibility(html);
            this.updateThrusterControlsVisibility(html);
            this.previewFromForm(html);
            this.fitWindowToContent(html);
        });

        this.updateConeVisibility(html);
        this.updateThrusterControlsVisibility(html);
        this.previewFromForm(html);
        this.fitWindowToContent(html);
    }

    fitWindowToContent(html) {
        const app = html.closest(".app");
        if (!app.length) return;

        window.requestAnimationFrame(() => {
            const element = app[0];
            const header = element.querySelector(".window-header");
            const content = element.querySelector(".window-content");
            if (!content) return;

            const maxHeight = Math.max(360, window.innerHeight - 80);
            const desiredHeight = Math.min(maxHeight, content.scrollHeight + (header?.offsetHeight ?? 0) + 18);
            const currentHeight = element.getBoundingClientRect().height;
            if (Math.abs(currentHeight - desiredHeight) < 4) return;

            this.setPosition({ height: desiredHeight });
            content.style.overflowY = desiredHeight >= maxHeight ? "auto" : "visible";
        });
    }

    syncLiveInputs(html) {
        html.find("[data-sync-number]").each((index, element) => {
            const key = element.dataset.syncNumber;
            html.find(`[data-sync-range="${key}"]`).val(element.value);
        });

        html.find("[data-color-text]").each((index, element) => {
            const value = String(element.value ?? "").trim();
            if (!/^#[0-9a-f]{6}$/i.test(value)) return;

            const key = element.dataset.colorText;
            html.find(`[data-color-picker="${key}"]`).val(value);
        });
    }

    updateThrusterControlsVisibility(html) {
        html.find("[data-thruster-controls]").toggle(html.find('[name="enableThrusterEffect"]').is(":checked"));
    }

    updateConeVisibility(html) {
        const coneCount = Math.round(clampNumber(Number(html.find("[name='coneCount']").val()), 1, 3, 1));
        html.find("[data-extra-thrust-index]").each((index, element) => {
            const extraIndex = Number(element.dataset.extraThrustIndex);
            $(element).toggle(extraIndex < coneCount);
        });
    }

    getThrusterConfigFromForm(html) {
        this.syncLiveInputs(html);

        const fallbackColor = getThrusterColorForTokenDocument(this.tokenDocument);
        const profileName = String(html.find("[name='shipProfileName']").val() ?? (this.tokenDocument ? getShipProfileName(this.tokenDocument) : "")).trim();
        const existingDimensions = getThrusterDimensionsForProfile(canvas.scene?.id, profileName);
        const scale = clampNumber(Number(html.find("[name='thrusterScale']").val()), -10, 10, 0);
        const position = clampNumber(Number(html.find("[name='thrusterPosition']").val()), -6, 6, 0);
        const baseLength = clampNumber(Number(html.find("[name='thrusterLength']").val()), 0.25, 12, getSettingNumber("thrusterLength", 1.25));
        const baseWidth = clampNumber(Number(html.find("[name='thrusterWidth']").val()), 0.1, 6, getSettingNumber("thrusterWidth", 0.55));
        const baseColor = normalizeHexColor(html.find("[name='shipThrusterColor']").val(), fallbackColor);
        const coneCount = Math.round(clampNumber(Number(html.find("[name='coneCount']").val()), 1, 3, 1));
        const coneSpacing = clampNumber(Number(html.find("[name='coneSpacing']").val()), 0, 6, 0.45);
        const cones = [{
            color: baseColor,
            length: baseLength,
            width: baseWidth,
            inverted: html.find("[name='thrusterInverted']").is(":checked")
        }];

        for (let index = 0; index < 2; index++) {
            const number = index + 1;
            const existingCone = existingDimensions.cones[number] ?? existingDimensions.cones[0];
            cones.push({
                color: normalizeHexColor(html.find(`[name='extraCone${number}Color']`).val(), existingCone.color ?? baseColor),
                length: clampNumber(Number(html.find(`[name='extraCone${number}Length']`).val()), 0.25, 12, existingCone.length ?? baseLength),
                width: clampNumber(Number(html.find(`[name='extraCone${number}Width']`).val()), 0.1, 6, existingCone.width ?? baseWidth),
                inverted: html.find(`[name='extraCone${number}Inverted']`).length ? html.find(`[name='extraCone${number}Inverted']`).is(":checked") : Boolean(existingCone.inverted)
            });
        }

        return { scale, position, length: baseLength, width: baseWidth, color: baseColor, coneCount, coneSpacing, cones };
    }

    previewFromForm(html) {
        if (!html.find('[name="enableThrusterEffect"]').is(":checked")) {
            clearThrusterPreview();
            return;
        }

        const tokenDocument = this.tokenDocument;
        const token = canvas.tokens?.get(tokenDocument?.id);
        if (!token) return;

        const rotation = normalizeDegrees(tokenDocument.rotation ?? token.rotation ?? 0);
        showThrusterPreview(token, { ...this.getThrusterConfigFromForm(html), rotation });
    }

    async _updateObject(event, formData) {
        const form = $(event.currentTarget);
        this.syncLiveInputs(form);
        if (globalThis.FormDataExtended) formData = new FormDataExtended(event.currentTarget).object;

        const tokenDocument = this.tokenDocument;
        const profileName = String(formData.shipProfileName ?? (tokenDocument ? getShipProfileName(tokenDocument) : "")).trim();
        if (!profileName) {
            await game.settings.set(MODULE_ID, "enableMovementSound", Boolean(formData.enableMovementSound));
            await game.settings.set(MODULE_ID, "movementSoundPath", String(formData.movementSoundPath ?? "").trim());
            await game.settings.set(MODULE_ID, "movementSoundVolume", clampNumber(Number(formData.movementSoundVolume), 0, 1, game.settings.get(MODULE_ID, "movementSoundVolume")));
            await game.settings.set(MODULE_ID, "enableThrusterEffect", Boolean(formData.enableThrusterEffect));
            await game.settings.set(MODULE_ID, "vehicleBowFacing", getValidVehicleBowFacing(formData.vehicleBowFacing));
            await game.settings.set(MODULE_ID, "enableShipRotation", Boolean(formData.enableShipRotation));
            await game.settings.set(MODULE_ID, "rotateBeforeMove", Boolean(formData.rotateBeforeMove));
            await game.settings.set(MODULE_ID, "rotationDelayMs", clampNumber(Number(formData.rotationDelayMs), 25, 500, 75));
            await game.settings.set(MODULE_ID, "rotationFinishSquares", clampNumber(Number(formData.rotationFinishSquares), 0.25, 10, 2));
            await game.settings.set(MODULE_ID, "rotationOffset", clampNumber(Number(formData.rotationOffset), -180, 180, 0));
            await game.settings.set(MODULE_ID, "thrusterScale", clampNumber(Number(formData.thrusterScale), -10, 10, 0));
            await game.settings.set(MODULE_ID, "thrusterLength", Number(formData.thrusterLength));
            await game.settings.set(MODULE_ID, "thrusterWidth", Number(formData.thrusterWidth));
            await game.settings.set(MODULE_ID, "enableVehicleHoverEffect", Boolean(formData.enableVehicleHoverEffect));
            await game.settings.set(MODULE_ID, "vehicleHoverOffsetX", clampNumber(Number(formData.hoverOffsetX), 0, 50, 2));
            await game.settings.set(MODULE_ID, "vehicleHoverOffsetY", clampNumber(Number(formData.hoverOffsetY), 0, 50, 3));
            await game.settings.set(MODULE_ID, "vehicleHoverSpeed", clampNumber(Number(formData.hoverSpeed), 0.1, 5, 1));
            await game.settings.set(MODULE_ID, "vehicleShieldAutomation", Boolean(formData.vehicleShieldAutomation));
            await game.settings.set(MODULE_ID, "vehicleProtectionVisualMode", getValidProtectionVisualMode(formData.vehicleProtectionVisualMode));
            clearThrusterPreview();
            refreshVehicleHoverEffects();
            game.fullSpeedAheadVehicleCombat?.syncVehicleShields?.();
            return;
        }

        const profiles = getShipProfiles();
        const profileKey = normalizeShipProfileName(profileName);
        const profile = {
            ...(profiles[profileKey] ?? {}),
            name: profileName,
            enableMovementSound: Boolean(formData.enableMovementSound),
            enableThrusterEffect: Boolean(formData.enableThrusterEffect),
            movementSoundPath: String(formData.movementSoundPath ?? "").trim(),
            movementSoundVolume: clampNumber(Number(formData.movementSoundVolume), 0, 1, game.settings.get(MODULE_ID, "movementSoundVolume")),
            rotationSettings: {
                vehicleBowFacing: getValidVehicleBowFacing(formData.vehicleBowFacing),
                enableShipRotation: Boolean(formData.enableShipRotation),
                rotateBeforeMove: Boolean(formData.rotateBeforeMove),
                rotationDelayMs: clampNumber(Number(formData.rotationDelayMs), 25, 500, 75),
                rotationFinishSquares: clampNumber(Number(formData.rotationFinishSquares), 0.25, 10, 2),
                rotationOffset: clampNumber(Number(formData.rotationOffset), -180, 180, 0)
            },
            hoverSettings: {
                enabled: Boolean(formData.enableVehicleHoverEffect),
                offsetX: clampNumber(Number(formData.hoverOffsetX), 0, 50, 2),
                offsetY: clampNumber(Number(formData.hoverOffsetY), 0, 50, 3),
                speed: clampNumber(Number(formData.hoverSpeed), 0.1, 5, 1)
            },
            protectionSettings: {
                enabled: Boolean(formData.vehicleShieldAutomation),
                visualMode: getValidProtectionVisualMode(formData.vehicleProtectionVisualMode)
            }
        };
        const fallbackColor = game.settings.get(MODULE_ID, "thrusterColor") || DEFAULT_THRUSTER_COLOR;
        const shipColor = String(formData.shipThrusterColor ?? fallbackColor).trim();
        profile.thrusterColor = /^#[0-9a-f]{6}$/i.test(shipColor) ? shipColor : fallbackColor;

        const thrusterConfig = this.getThrusterConfigFromForm(form);
        profile.thrusterDimensions = {
            ...thrusterConfig
        };
        profiles[profileKey] = profile;
        await game.settings.set(MODULE_ID, SHIP_PROFILES_SETTING, profiles);
        await setAssignedShipProfileName(tokenDocument, profileName);
        await setSceneThrusterScaleForProfile(canvas.scene?.id, profileName, thrusterConfig.scale);
        clearThrusterPreview();
        refreshVehicleHoverEffects();
        game.fullSpeedAheadVehicleCombat?.syncVehicleShields?.();
    }

    async close(options) {
        clearThrusterPreview();
        return super.close(options);
    }
}

class FullSpeedAheadCosmeticsConfig extends FormApplication {
    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "full-speed-ahead-cosmetics-config",
            title: "Full Speed Ahead: Vehicle Sheet Cosmetics",
            template: `modules/${MODULE_ID}/templates/cosmetics-settings.hbs`,
            width: 520,
            closeOnSubmit: true
        });
    }

    getData() {
        return {
            renameCreatureCapacity: game.settings.get(MODULE_ID, "renameCreatureCapacity"),
            renameFeaturesToShipFunctions: game.settings.get(MODULE_ID, "renameFeaturesToShipFunctions")
        };
    }

    async _updateObject(event, formData) {
        await game.settings.set(MODULE_ID, "renameCreatureCapacity", Boolean(formData.renameCreatureCapacity));
        await game.settings.set(MODULE_ID, "renameFeaturesToShipFunctions", Boolean(formData.renameFeaturesToShipFunctions));
    }
}

class FullSpeedAheadSceneDragConfig extends FormApplication {
    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "full-speed-ahead-scene-drag-config",
            title: "Full Speed Ahead: Scene Movement Locks",
            template: `modules/${MODULE_ID}/templates/scene-drag-settings.hbs`,
            width: 560,
            closeOnSubmit: true
        });
    }

    getData() {
        const disabledScenes = getDisabledVehicleDragScenes();
        const scenes = Array.from(game.scenes ?? [])
            .map(scene => ({
                id: scene.id,
                name: scene.name || "Unnamed Scene",
                navigation: Boolean(scene.navigation),
                disabled: Boolean(disabledScenes[scene.id])
            }))
            .sort((a, b) => Number(b.navigation) - Number(a.navigation) || a.name.localeCompare(b.name));

        return {
            scenes,
            hasScenes: scenes.length > 0
        };
    }

    async _updateObject(event, formData) {
        const disabledScenes = {};
        for (const scene of game.scenes ?? []) {
            if (Boolean(formData[`disableVehicleDragScene_${scene.id}`])) disabledScenes[scene.id] = true;
        }
        await game.settings.set(MODULE_ID, DISABLED_VEHICLE_DRAG_SCENES_SETTING, disabledScenes);
    }
}

class FullSpeedAheadHoverConfig extends FormApplication {
    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "full-speed-ahead-hover-config",
            title: "Full Speed Ahead: Vehicle Hover Effect",
            template: `modules/${MODULE_ID}/templates/hover-settings.hbs`,
            width: 520,
            closeOnSubmit: true
        });
    }

    getData() {
        return {
            enableVehicleHoverEffect: game.settings.get(MODULE_ID, "enableVehicleHoverEffect"),
            hoverOffsetX: game.settings.get(MODULE_ID, "vehicleHoverOffsetX"),
            hoverOffsetY: game.settings.get(MODULE_ID, "vehicleHoverOffsetY"),
            hoverSpeed: game.settings.get(MODULE_ID, "vehicleHoverSpeed")
        };
    }

    activateListeners(html) {
        super.activateListeners(html);

        html.find("[data-sync-range]").on("input", event => {
            const key = event.currentTarget.dataset.syncRange;
            html.find(`[data-sync-number="${key}"]`).val(event.currentTarget.value);
        });

        html.find("[data-sync-number]").on("input change", event => {
            const key = event.currentTarget.dataset.syncNumber;
            html.find(`[data-sync-range="${key}"]`).val(event.currentTarget.value);
        });
    }

    async _updateObject(event, formData) {
        await game.settings.set(MODULE_ID, "enableVehicleHoverEffect", Boolean(formData.enableVehicleHoverEffect));
        await game.settings.set(MODULE_ID, "vehicleHoverOffsetX", clampNumber(Number(formData.hoverOffsetX), 0, 50, 2));
        await game.settings.set(MODULE_ID, "vehicleHoverOffsetY", clampNumber(Number(formData.hoverOffsetY), 0, 50, 3));
        await game.settings.set(MODULE_ID, "vehicleHoverSpeed", clampNumber(Number(formData.hoverSpeed), 0.1, 5, 1));
        refreshVehicleHoverEffects();
    }
}

class FullSpeedAheadTargetingCardsConfig extends FormApplication {
    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "full-speed-ahead-targeting-cards-config",
            title: "Full Speed Ahead: QuickTarget Settings",
            template: `modules/${MODULE_ID}/templates/targeting-cards-settings.hbs`,
            width: 560,
            closeOnSubmit: true,
            tabs: [{ navSelector: ".tabs", contentSelector: ".fsa-quicktarget-body", initial: "general" }]
        });
    }

    getData() {
        const legacyDisabledUsers = getDisabledTargetingCardUsers();
        const disabledCharacterUsers = getDisabledCharacterCardUsers();
        const disabledVehicleUsers = getDisabledVehicleCardUsers();
        const users = collectTargetingCardUsers().map(user => ({
            id: user.id,
            name: user.name,
            active: Boolean(user.active),
            characterDisabled: Boolean(disabledCharacterUsers[user.id] ?? legacyDisabledUsers[user.id]),
            vehicleDisabled: Boolean(disabledVehicleUsers[user.id] ?? legacyDisabledUsers[user.id])
        }));

        return {
            enableTargetingSystem: game.settings.get(MODULE_ID, "enableTargetingSystem"),
            enableTargetingSystemPlayers: game.settings.get(MODULE_ID, "enableTargetingSystemPlayers"),
            enableTargetingSystemGM: game.settings.get(MODULE_ID, "enableTargetingSystemGM"),
            enableVehicleQuickTarget: game.settings.get(MODULE_ID, "enableVehicleQuickTarget"),
            enableVehicleQuickTargetPlayers: game.settings.get(MODULE_ID, "enableVehicleQuickTargetPlayers"),
            enableVehicleQuickTargetGM: game.settings.get(MODULE_ID, "enableVehicleQuickTargetGM"),
            replaceDoubleRightClickTargeting: game.settings.get(MODULE_ID, "replaceDoubleRightClickTargeting"),
            autoRemoveTargetingTemplate: game.settings.get(MODULE_ID, "autoRemoveTargetingTemplate"),
            targetingTemplateRemovalSeconds: game.settings.get(MODULE_ID, "targetingTemplateRemovalSeconds"),
            users,
            hasUsers: users.length > 0
        };
    }

    async _updateObject(event, formData) {
        const settingUpdates = {
            enableTargetingSystem: Boolean(formData.enableTargetingSystem),
            enableTargetingSystemPlayers: Boolean(formData.enableTargetingSystemPlayers),
            enableTargetingSystemGM: Boolean(formData.enableTargetingSystemGM),
            enableVehicleQuickTarget: Boolean(formData.enableVehicleQuickTarget),
            enableVehicleQuickTargetPlayers: Boolean(formData.enableVehicleQuickTargetPlayers),
            enableVehicleQuickTargetGM: Boolean(formData.enableVehicleQuickTargetGM),
            replaceDoubleRightClickTargeting: Boolean(formData.replaceDoubleRightClickTargeting),
            autoRemoveTargetingTemplate: Boolean(formData.autoRemoveTargetingTemplate),
            targetingTemplateRemovalSeconds: clampNumber(Number(formData.targetingTemplateRemovalSeconds), 1, 120, 10)
        };
        for (const [key, value] of Object.entries(settingUpdates)) {
            await game.settings.set(MODULE_ID, key, value);
        }

        const disabledCharacterUsers = {};
        const disabledVehicleUsers = {};
        for (const user of collectTargetingCardUsers()) {
            if (Boolean(formData[`disableCharacterCardUser_${user.id}`])) disabledCharacterUsers[user.id] = true;
            if (Boolean(formData[`disableVehicleCardUser_${user.id}`])) disabledVehicleUsers[user.id] = true;
        }
        await game.settings.set(MODULE_ID, DISABLED_CHARACTER_CARD_USERS_SETTING, disabledCharacterUsers);
        await game.settings.set(MODULE_ID, DISABLED_VEHICLE_CARD_USERS_SETTING, disabledVehicleUsers);
        await game.settings.set(MODULE_ID, DISABLED_TARGETING_CARD_USERS_SETTING, {});
    }
}

class FullSpeedAheadSettingsHub extends FormApplication {
    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "full-speed-ahead-settings-hub",
            title: "Full Speed Ahead",
            template: `modules/${MODULE_ID}/templates/settings-hub.hbs`,
            width: 620,
            closeOnSubmit: false,
            submitOnChange: false
        });
    }

    activateListeners(html) {
        super.activateListeners(html);

        html.find("[data-open-fsa-settings]").on("click", event => {
            event.preventDefault();
            openFullSpeedAheadPanel(event.currentTarget.dataset.openFsaSettings);
        });
    }

    async _updateObject() {}
}

Hooks.once("init", () => {
    console.log(`${LOG_PREFIX} Initializing...`);

    game.settings.registerMenu(MODULE_ID, "effectsConfig", {
        name: "Movement Effects",
        label: "Configure, Sound, Thrust, Rotate",
        hint: "Open the same movement effects panel used by the vehicle token HUD gear.",
        icon: "fas fa-cog",
        type: FullSpeedAheadEffectsConfig,
        restricted: true
    });

    game.settings.registerMenu(MODULE_ID, "cosmeticsConfig", {
        name: "Vehicle Sheet Cosmetics",
        label: "Configure Cosmetics",
        hint: "Configure optional vehicle sheet label changes.",
        icon: "fas fa-paint-brush",
        type: FullSpeedAheadCosmeticsConfig,
        restricted: true
    });

    game.settings.registerMenu(MODULE_ID, "targetingCardsConfig", {
        name: "QuickTarget Settings",
        label: "Open QuickTarget Settings",
        hint: "Configure non-vehicle and vehicle QuickTarget access, timeout behavior, and private helper chat cards.",
        icon: "fas fa-crosshairs",
        type: FullSpeedAheadTargetingCardsConfig,
        restricted: true
    });

    game.settings.registerMenu(MODULE_ID, "sceneDragConfig", {
        name: "Disable Vehicle Drag on Scene",
        label: "Configure Scene Movement Locks",
        hint: "Choose scenes where vehicle tokens cannot be dragged and must travel by HyperDrive module instead.",
        icon: "fas fa-map-marked-alt",
        type: FullSpeedAheadSceneDragConfig,
        restricted: true
    });

    registerSetting("enableShipRotation", {
        name: "Enable Vehicle Rotation When Moved",
        hint: "Automatically face vehicle tokens toward their movement destination. The top of the token is treated as the front.",
        type: Boolean,
        default: true,
        config: false
    });

    registerSetting("rotateBeforeMove", {
        name: "Smooth Rotation During Movement",
        hint: "Rotate vehicles by the shortest path while they start moving instead of instantly snapping to the destination heading.",
        type: Boolean,
        default: true,
        config: false
    });

    registerSetting("rotationDelayMs", {
        name: "Rotation Update Interval",
        hint: "How often, in milliseconds, to publish smooth rotation updates while a vehicle starts moving.",
        type: Number,
        default: 75,
        range: { min: 25, max: 500, step: 25 },
        config: false
    });

    registerSetting("rotationFinishSquares", {
        name: "Rotation Finish Distance",
        hint: "How many grid spaces the vehicle may travel before it has finished rotating to its new heading.",
        type: Number,
        default: 2,
        range: { min: 0.25, max: 10, step: 0.25 },
        config: false
    });

    registerSetting("rotationOffset", {
        name: "Rotation Offset",
        hint: "Advanced degrees added to the calculated heading after Vehicle Bow Facing is applied.",
        type: Number,
        default: 0,
        range: { min: -180, max: 180, step: 15 },
        config: false
    });

    registerSetting("vehicleBowFacing", {
        name: "Vehicle Bow Facing",
        hint: "Direction the vehicle art faces before Foundry applies token rotation.",
        type: String,
        default: "north",
        choices: {
            north: "North",
            east: "East",
            south: "South",
            west: "West"
        },
        config: false
    });

    registerSetting("enableVehicleHoverEffect", {
        name: "Vehicles have a hover effect",
        hint: "Gently move vehicle token art in place using Full Speed Ahead's built-in hover motion.",
        type: Boolean,
        default: true,
        config: false,
        onChange: refreshVehicleHoverEffects
    });

    registerSetting("vehicleHoverOffsetX", {
        name: "Vehicle Hover X Offset",
        hint: "Global horizontal hover drift in pixels for all vehicle tokens.",
        type: Number,
        default: 2,
        range: { min: 0, max: 50, step: 0.5 },
        config: false,
        onChange: refreshVehicleHoverEffects
    });

    registerSetting("vehicleHoverOffsetY", {
        name: "Vehicle Hover Y Offset",
        hint: "Global vertical hover drift in pixels for all vehicle tokens.",
        type: Number,
        default: 3,
        range: { min: 0, max: 50, step: 0.5 },
        config: false,
        onChange: refreshVehicleHoverEffects
    });

    registerSetting("vehicleHoverSpeed", {
        name: "Vehicle Hover Speed",
        hint: "Global hover speed multiplier for all vehicle tokens.",
        type: Number,
        default: 1,
        range: { min: 0.1, max: 5, step: 0.1 },
        config: false,
        onChange: refreshVehicleHoverEffects
    });

    registerSetting("enableMovementSound", {
        name: "Enable Movement Sound",
        hint: "Play a sound effect whenever a vehicle token moves.",
        type: Boolean,
        default: true,
        config: false
    });

    registerSetting("movementSoundPath", {
        name: "Movement Sound Path",
        hint: "Path to a movement sound. Defaults to the bundled lock-on sound until you add a dedicated thruster audio file.",
        type: String,
        default: DEFAULT_MOVEMENT_SOUND_PATH,
        config: false
    });

    registerSetting("movementSoundVolume", {
        name: "Movement Sound Volume",
        hint: "Volume for the vehicle movement sound.",
        type: Number,
        default: 0.18,
        range: { min: 0, max: 1, step: 0.05 },
        config: false
    });

    registerSetting("enableThrusterEffect", {
        name: "Enable Thruster Effect",
        hint: "Draw a short colored thrust trail behind vehicle tokens while they move.",
        type: Boolean,
        default: true,
        config: false
    });

    registerSetting("thrusterColor", {
        name: "Thruster Color",
        hint: "Hex color used for the movement thrust trail.",
        type: String,
        default: DEFAULT_THRUSTER_COLOR,
        config: false
    });

    registerSetting("thrusterScale", {
        name: "Thruster Global Scale",
        hint: "Global multiplier applied to the movement thrust trail.",
        type: Number,
        default: 0,
        range: { min: -10, max: 10, step: 0.5 },
        config: false
    });

    registerSetting("thrusterLength", {
        name: "Thruster Length",
        hint: "Length of the attached thrust cone in grid spaces.",
        type: Number,
        default: 1.25,
        range: { min: 0.25, max: 6, step: 0.25 },
        config: false
    });

    registerSetting("thrusterWidth", {
        name: "Thruster Width",
        hint: "Width of the attached thrust cone in grid spaces.",
        type: Number,
        default: 0.55,
        range: { min: 0.1, max: 3, step: 0.05 },
        config: false
    });

    registerSetting(SHIP_PROFILES_SETTING, {
        name: "Ship Effect Profiles",
        hint: "Name-keyed vehicle effect profiles used by Full Speed Ahead.",
        type: Object,
        default: {},
        config: false
    });

    registerSetting(SCENE_THRUSTER_PROFILES_SETTING, {
        name: "Scene Ship Thruster Profiles",
        hint: "Scene and ship name keyed thruster dimensions used by Full Speed Ahead.",
        type: Object,
        default: {},
        config: false
    });

    registerSetting(DISABLED_VEHICLE_DRAG_SCENES_SETTING, {
        name: "Scenes with Vehicle Drag Disabled",
        hint: "Scene IDs where vehicle token dragging is blocked by Full Speed Ahead.",
        type: Object,
        default: {},
        config: false
    });

    registerSetting(DISABLED_TARGETING_CARD_ACTORS_SETTING, {
        name: "Disabled QuickTarget Chat Card Actors",
        hint: "Actor IDs whose players should not receive Full Speed Ahead QuickTarget attack option chat cards.",
        type: Object,
        default: {},
        config: false
    });

    registerSetting(DISABLED_TARGETING_CARD_USERS_SETTING, {
        name: "Disabled QuickTarget Chat Card Players",
        hint: "Player user IDs that should not receive Full Speed Ahead QuickTarget helper chat cards.",
        type: Object,
        default: {},
        config: false
    });

    registerSetting(DISABLED_CHARACTER_CARD_USERS_SETTING, {
        name: "Hidden Character QuickTarget Cards",
        hint: "Player user IDs that should not receive helper cards for non-vehicle QuickTarget interactions.",
        type: Object,
        default: {},
        config: false
    });

    registerSetting(DISABLED_VEHICLE_CARD_USERS_SETTING, {
        name: "Hidden Vehicle QuickTarget Cards",
        hint: "Player user IDs that should not receive helper cards for vehicle QuickTarget interactions.",
        type: Object,
        default: {},
        config: false
    });

    registerSetting("renameCreatureCapacity", {
        name: "Change Creature Capacity Label",
        hint: "On Tidy5e vehicle sheets, change the Creature Capacity label to Module Capacity.",
        type: Boolean,
        default: false,
        config: false
    });

    registerSetting("renameFeaturesToShipFunctions", {
        name: "Change Features Label",
        hint: "On Tidy5e vehicle sheets, change the Features label to Ship Functions.",
        type: Boolean,
        default: false,
        config: false
    });

    registerTargetingSettings();
    addTargetingSystemButton();
});

Hooks.on("ready", () => {
    console.log(`${LOG_PREFIX} Ready.`);
    game.fullSpeedAhead = game.fullSpeedAhead || {};
    game.fullSpeedAhead.openSettings = openFullSpeedAheadSettings;
    game.fullSpeedAhead.getProtectionSettingsForActor = getProtectionSettingsForActor;
    game.fullSpeedAhead.getProtectionSettingsForTokenDocument = getProtectionSettingsForTokenDocument;
    refreshVehicleHoverEffects();
});

Hooks.on("canvasReady", () => {
    refreshVehicleHoverEffects();
});

Hooks.on("drawToken", token => {
    applyVehicleHoverIfNeeded(token);
});

Hooks.on("controlToken", (token, controlled) => {
    applyVehicleHoverIfNeeded(token);
});

Hooks.on("deleteToken", tokenDocument => {
    stopVehicleHoverForTokenId(tokenDocument.id);
});

Hooks.on("preUpdateToken", (tokenDocument, changes, options, userId) => {
    if (options?.[INTERNAL_MOVE]) return;
    if (!isVehicleDocument(tokenDocument)) return;
    if (hasMovement(changes) && isVehicleDragDisabledForScene(tokenDocument.parent)) {
        warnVehicleDragDisabled();
        return false;
    }

    const rotationSettings = getRotationSettingsForTokenDocument(tokenDocument);
    if (!rotationSettings.enableShipRotation) return;
    if (!hasMovement(changes)) return;

    const destination = {
        x: Number.isFinite(changes.x) ? changes.x : tokenDocument.x,
        y: Number.isFinite(changes.y) ? changes.y : tokenDocument.y
    };
    const origin = { x: tokenDocument.x, y: tokenDocument.y };
    const rotation = getHeadingRotation(origin, destination);
    if (rotation === null) return;

    const adjustedRotation = normalizeDegrees(rotation + getVehicleRotationOffset(tokenDocument));
    lastTokenPositions.set(tokenDocument.id, origin);
    options.fullSpeedAheadMotion = {
        origin,
        destination,
        startRotation: normalizeDegrees(tokenDocument.rotation ?? 0),
        targetRotation: adjustedRotation,
        rotationSettings
    };
    delete changes.rotation;
});

Hooks.on("updateToken", (tokenDocument, changes, options, userId) => {
    if (options?.[INTERNAL_MOVE] && options.fullSpeedAheadRotationOnly) return;
    if (!hasMovement(changes)) return;
    if (!isVehicleDocument(tokenDocument)) return;

    playMovementSound(tokenDocument, userId);
    startVehicleMotionEffects(tokenDocument, options);
});

Hooks.on("renderTidy5eVehicleSheet", (app, html, data) => {
    applyVehicleSheetCosmetics(app, html);
});

Hooks.on("renderTokenHUD", (app, html, data) => {
    if (!game.user.isGM) return;

    const token = app.object ?? canvas.tokens.get(data?._id);
    if (token?.actor?.type !== "vehicle") return;
    if (html.find(".full-speed-ahead-effects").length) return;

    const effectsButton = $(`
        <div class="control-icon full-speed-ahead-effects" title="Full Speed Ahead Movement Effects">
            <i class="fas fa-rocket"></i>
        </div>
    `);
    effectsButton.css({
        background: "rgba(32, 32, 32, 0.88)",
        border: "1px solid rgba(255, 180, 80, 0.9)",
        color: "#ffb24a",
        boxShadow: "0 0 10px rgba(255, 140, 32, 0.5)"
    });
    effectsButton.on("click", event => {
        event.preventDefault();
        event.stopPropagation();
        new FullSpeedAheadEffectsConfig(token.document).render(true);
    });

    const leftColumn = html.find(".col.left");
    if (leftColumn.length) leftColumn.append(effectsButton);
    else html.append(effectsButton);
});

function registerSetting(key, data) {
    game.settings.register(MODULE_ID, key, {
        scope: "world",
        config: true,
        ...data
    });
}

function registerTargetingSettings() {
    registerSetting("enableTargetingSystem", {
        name: "Enable QuickTarget",
        hint: "Enable QuickTarget for character and other non-vehicle interactions. Vehicle QuickTarget is controlled separately. Requires refresh.",
        type: Boolean,
        default: true,
        config: false
    });

    registerSetting("enablePlayerQuickTarget", {
        name: "Deprecated Player QuickTarget",
        hint: "Legacy setting retained for world-data compatibility. Non-vehicle QuickTarget now uses Enable QuickTarget.",
        type: Boolean,
        default: true,
        config: false
    });

    registerSetting("enableVehicleQuickTarget", {
        name: "Vehicle QuickTarget",
        hint: "Enable QuickTarget range overlays, T-key targeting, and private attack helpers for vehicle tokens.",
        type: Boolean,
        default: true,
        config: false
    });

    registerSetting("enableTargetingSystemGM", {
        name: "Enable QuickTarget for GM",
        hint: "Enable non-vehicle QuickTarget and its token-control button for the GM. Requires refresh.",
        type: Boolean,
        default: true,
        config: false
    });

    registerSetting("enableTargetingSystemPlayers", {
        name: "Enable QuickTarget for Players",
        hint: "Enable non-vehicle QuickTarget and its token-control button for non-GM players. Requires refresh.",
        type: Boolean,
        default: true,
        config: false
    });

    registerSetting("enableVehicleQuickTargetPlayers", {
        name: "Vehicle QuickTarget for Players",
        hint: "Enable vehicle QuickTarget for non-GM players. Requires refresh.",
        type: Boolean,
        default: true,
        config: false
    });

    registerSetting("enableVehicleQuickTargetGM", {
        name: "Vehicle QuickTarget for GM",
        hint: "Enable vehicle QuickTarget for the GM. Requires refresh.",
        type: Boolean,
        default: true,
        config: false
    });

    registerSetting("replaceDoubleRightClickTargeting", {
        name: "Replace Double Right-Click with QuickTarget",
        hint: "Use non-vehicle or Vehicle QuickTarget and private attack helpers when double right-clicking a token. Leave unchecked to keep Foundry's default targeting behavior.",
        type: Boolean,
        default: false,
        config: false
    });

    registerSetting("autoRemoveTargetingTemplate", {
        name: "Automatically Remove QuickTarget Template",
        hint: "Automatically clear QuickTarget labels and range templates after the configured number of seconds.",
        type: Boolean,
        default: true,
        config: false
    });

    registerSetting("targetingTemplateRemovalSeconds", {
        name: "QuickTarget Template Removal Seconds",
        hint: "How many seconds QuickTarget labels and range templates remain visible when automatic removal is enabled.",
        type: Number,
        default: 10,
        range: { min: 1, max: 120, step: 1 },
        config: false
    });
}

function addTargetingSystemButton() {
    Hooks.on("getSceneControlButtons", controls => {
        if (isStandaloneQuickTargetActive()) return;
        const nonVehicleEnabled = game.settings.get(MODULE_ID, "enableTargetingSystem") && (
            game.user.isGM
                ? game.settings.get(MODULE_ID, "enableTargetingSystemGM")
                : game.settings.get(MODULE_ID, "enableTargetingSystemPlayers")
        );
        const vehicleEnabled = game.settings.get(MODULE_ID, "enableVehicleQuickTarget") && (
            game.user.isGM
                ? game.settings.get(MODULE_ID, "enableVehicleQuickTargetGM")
                : game.settings.get(MODULE_ID, "enableVehicleQuickTargetPlayers")
        );
        if (!nonVehicleEnabled && !vehicleEnabled) return;

        const tokenControl = getTokenSceneControl(controls);
        if (!tokenControl) return;

        const targetingTool = {
            name: "highlight-weapon-range",
            title: "Use QuickTarget",
            icon: "fas fa-crosshairs",
            button: true,
            onClick: () => {
                const api = game.modules.get(MODULE_ID)?.api;
                if (api?.highlightWeaponRange) api.highlightWeaponRange();
                else ui.notifications.warn("Full Speed Ahead QuickTarget is not ready yet.");
            }
        };

        if (Array.isArray(tokenControl.tools)) {
            tokenControl.tools = tokenControl.tools.filter(tool => tool.name !== targetingTool.name);
            tokenControl.tools.push(targetingTool);
        } else if (tokenControl.tools && typeof tokenControl.tools === "object") {
            tokenControl.tools[targetingTool.name] = targetingTool;
        }
    });
}

function isStandaloneQuickTargetActive() {
    const modules = Array.from(game.modules?.entries?.() ?? game.modules ?? []);
    return modules.some(entry => {
        const [moduleId, module] = Array.isArray(entry)
            ? entry
            : [entry?.id ?? entry?.name ?? entry?.data?.name, entry];
        const id = String(moduleId ?? "");
        if (id === MODULE_ID || !module?.active) return false;
        const identity = `${id} ${module.title ?? ""} ${module.data?.title ?? ""} ${module.data?.name ?? ""}`;
        return STANDALONE_QUICKTARGET_MODULE_IDS.includes(id) || /quick\s*-?\s*target/i.test(identity);
    });
}

function getTokenSceneControl(controls) {
    if (Array.isArray(controls)) return controls.find(control => control.name === "token");
    return controls?.token ?? Object.values(controls ?? {}).find(control => control.name === "token");
}

function isVehicleDocument(tokenDocument) {
    return tokenDocument?.actor?.type === "vehicle";
}

function hasMovement(changes) {
    return Object.prototype.hasOwnProperty.call(changes, "x") || Object.prototype.hasOwnProperty.call(changes, "y");
}

function getDisabledVehicleDragScenes() {
    return foundry.utils.deepClone(game.settings.get(MODULE_ID, DISABLED_VEHICLE_DRAG_SCENES_SETTING) ?? {});
}

function isVehicleDragDisabledForScene(scene) {
    if (!scene?.id) return false;
    const disabledScenes = getDisabledVehicleDragScenes();
    return Boolean(disabledScenes[scene.id]);
}

function warnVehicleDragDisabled() {
    const now = Date.now();
    if (now - lastVehicleDragLockWarningAt < 1500) return;
    lastVehicleDragLockWarningAt = now;
    ui.notifications.warn("You must use a HyperDrive Module to Travel at this scale");
}

function getHeadingRotation(origin, destination) {
    const dx = destination.x - origin.x;
    const dy = destination.y - origin.y;
    if (dx === 0 && dy === 0) return null;

    const radians = Math.atan2(dy, dx);
    return normalizeDegrees((radians * 180 / Math.PI) + 90);
}

function normalizeDegrees(degrees) {
    return ((degrees % 360) + 360) % 360;
}

function getVehicleRotationOffset(tokenDocument = null) {
    const settings = getProfileRotationSettings(getShipProfile(getShipProfileName(tokenDocument)));
    return VEHICLE_BOW_OFFSETS[settings.vehicleBowFacing] + settings.rotationOffset;
}

function getVehicleBowFacing() {
    return getValidVehicleBowFacing(game.settings.get(MODULE_ID, "vehicleBowFacing"));
}

function getValidVehicleBowFacing(value) {
    const facing = String(value ?? "north").toLocaleLowerCase();
    return Object.prototype.hasOwnProperty.call(VEHICLE_BOW_OFFSETS, facing) ? facing : "north";
}

function getValidProtectionVisualMode(value) {
    const mode = String(value ?? VEHICLE_PROTECTION_VISUAL_MODES.BUILT_IN);
    return Object.values(VEHICLE_PROTECTION_VISUAL_MODES).includes(mode) ? mode : VEHICLE_PROTECTION_VISUAL_MODES.BUILT_IN;
}

function getSettingNumber(key, fallback) {
    const value = Number(game.settings.get(MODULE_ID, key));
    return Number.isFinite(value) ? value : fallback;
}

function clampNumber(value, min, max, fallback) {
    if (!Number.isFinite(value)) return fallback;
    return Math.max(min, Math.min(max, value));
}

function openFullSpeedAheadSettings() {
    const SettingsClass = globalThis.SettingsConfig;
    if (!SettingsClass) return new FullSpeedAheadSettingsHub().render(true);

    const settingsApp = game.settings?.sheet instanceof SettingsClass ? game.settings.sheet : new SettingsClass();
    const activateFsaPage = () => activateFullSpeedAheadSettingsPage(settingsApp);
    Hooks.once("renderSettingsConfig", app => {
        if (app === settingsApp || app?.id === settingsApp.id) activateFsaPage();
    });
    settingsApp.render(true);
    window.setTimeout(activateFsaPage, 50);
    window.setTimeout(activateFsaPage, 200);
    return settingsApp;
}

function activateFullSpeedAheadSettingsPage(settingsApp) {
    const root = settingsApp?.element;
    if (!root?.length) return false;

    const search = root.find('input[type="search"], input[name="filter"], input[name="search"], input[placeholder="Filter"]').first();
    if (search.length && search.val()) search.val("").trigger("input").trigger("keyup").trigger("change");

    const tabId = MODULE_ID;
    if (settingsApp._tabs?.[0]?.activate) settingsApp._tabs[0].activate(tabId);

    const tabButton = root.find(`[data-tab="${tabId}"], [data-category="${tabId}"], [data-package-id="${tabId}"]`).filter((_index, element) => {
        return !element.classList.contains("tab");
    }).first();

    if (tabButton.length) {
        tabButton.trigger("click");
        tabButton[0].scrollIntoView?.({ block: "center" });
    } else {
        root.find(".tabs .item, nav .item, aside li, aside a").filter((_index, element) => {
            return element.textContent?.trim().startsWith("Full Speed Ahead");
        }).first().trigger("click");
    }

    root.find(".tab").removeClass("active");
    root.find(`.tab[data-tab="${tabId}"], [data-tab-content="${tabId}"]`).addClass("active");
    root.find(".tabs .item, nav .item").removeClass("active");
    root.find(`.tabs .item[data-tab="${tabId}"], nav .item[data-tab="${tabId}"], [data-category="${tabId}"], [data-package-id="${tabId}"]`).addClass("active");
    return true;
}

function openFullSpeedAheadPanel(panel) {
    if (panel === "effects") return new FullSpeedAheadEffectsConfig().render(true);
    if (panel === "cosmetics") return new FullSpeedAheadCosmeticsConfig().render(true);
    if (panel === "quicktarget") return new FullSpeedAheadTargetingCardsConfig().render(true);
    if (panel === "scene-drag") return new FullSpeedAheadSceneDragConfig().render(true);
    if (panel === "combat") {
        const opened = game.fullSpeedAhead?.openVehicleCombatSettings?.();
        if (opened) return opened;
        return openRegisteredFullSpeedAheadMenu("vehicleCombatConfig");
    }
    if (panel === "capital") {
        const opened = game.fullSpeedAhead?.openSharedCapitalSettings?.();
        if (opened) return opened;
        return openRegisteredFullSpeedAheadMenu("sharedCapitalConfig");
    }
    if (panel === "sheet-buttons") {
        const opened = game.fullSpeedAhead?.openVehicleSheetButtonsSettings?.();
        if (opened) return opened;
        return openRegisteredFullSpeedAheadMenu("vehicleSheetButtonsConfig");
    }
    return null;
}

function openRegisteredFullSpeedAheadMenu(menuKey) {
    const key = `${MODULE_ID}.${menuKey}`;
    const menu = game.settings?.menus?.get?.(key) ?? game.settings?.menus?.get?.(menuKey);
    const MenuClass = menu?.type;
    if (MenuClass) return new MenuClass().render(true);
    ui.notifications.warn("That Full Speed Ahead settings panel is not available yet.");
    return null;
}

function normalizeHexColor(value, fallback = DEFAULT_THRUSTER_COLOR) {
    const color = String(value ?? "").trim();
    return /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
}

function getThrusterScaleFactor(scale) {
    const normalized = clampNumber(Number(scale), -10, 10, 0);
    return normalized >= 0 ? 1 + normalized / 2 : 1 / (1 + Math.abs(normalized) / 2);
}

function getTokenTextureScale(token) {
    const texture = token?.document?.texture ?? {};
    const scaleX = Math.abs(Number(texture.scaleX ?? texture.scale ?? 1));
    const scaleY = Math.abs(Number(texture.scaleY ?? texture.scale ?? 1));
    const x = Number.isFinite(scaleX) && scaleX > 0 ? scaleX : 1;
    const y = Number.isFinite(scaleY) && scaleY > 0 ? scaleY : 1;
    return { x, y, average: (x + y) / 2 };
}

function getTokenVisualDimensions(token) {
    const textureScale = getTokenTextureScale(token);
    const gridSize = Number(canvas.grid?.size) || 100;
    const tokenWidth = Number(token?.w) || (Number(token?.document?.width) || 1) * gridSize;
    const tokenHeight = Number(token?.h) || (Number(token?.document?.height) || 1) * gridSize;
    return {
        width: Math.max(1, tokenWidth * textureScale.x),
        height: Math.max(1, tokenHeight * textureScale.y),
        scale: textureScale.average
    };
}

function getTokenVisualHalfExtent(token, forwardX, forwardY) {
    const dimensions = getTokenVisualDimensions(token);
    return (Math.abs(forwardX) * dimensions.width + Math.abs(forwardY) * dimensions.height) / 2;
}

function playMovementSound(tokenDocument, userId) {
    if (userId && game.user.id !== userId) return;

    const { src, volume, enabled } = getMovementSoundOptions(tokenDocument);
    if (!src || !enabled) return;

    AudioHelper.play({
        src,
        volume,
        autoplay: true,
        loop: false
    }, true);
}

function applyVehicleSheetCosmetics(app, html) {
    if (app.actor?.type !== "vehicle") return;

    if (game.settings.get(MODULE_ID, "renameCreatureCapacity")) {
        html.find('h4:contains("Creature Capacity")').each((index, element) => {
            const label = $(element);
            label.text(label.text().replace("Creature Capacity", "Module Capacity"));
        });
        makeModuleCapacityReadonlyForPlayers(html);
    }

    if (game.settings.get(MODULE_ID, "renameFeaturesToShipFunctions")) {
        html.find('div.item-table-column:contains("Features")').each((index, element) => {
            const label = $(element);
            label.text(label.text().replace("Features", "Ship Functions"));
        });
    }
}

function makeModuleCapacityReadonlyForPlayers(html) {
    if (game.user?.isGM) return;
    const root = html?.jquery ? html : $(html);
    const capacityInputs = root.find('input[name*="creature"][name*="capacity"], input[data-path*="creature"][data-path*="capacity"], input[name*="cargo.creature"], input[data-path*="cargo.creature"]');
    capacityInputs.prop("readonly", true).attr("tabindex", "-1").addClass("full-speed-ahead-readonly-capacity-input");

    root.find('h4:contains("Module Capacity")').each((_index, element) => {
        const label = $(element);
        const valueNodes = label.nextUntil("h4").filter((_nodeIndex, node) => {
            const text = $(node).text().trim();
            return Boolean(text) && !/^Cargo Capacity\b/i.test(text);
        });
        label.add(valueNodes).addClass("full-speed-ahead-readonly-capacity");
        blockModuleCapacityEditing(label.add(valueNodes));
    });
}

function blockModuleCapacityEditing(elements) {
    elements.each((_index, element) => {
        element.addEventListener("pointerdown", stopModuleCapacityEditEvent, true);
        element.addEventListener("mousedown", stopModuleCapacityEditEvent, true);
        element.addEventListener("click", stopModuleCapacityEditEvent, true);
        element.addEventListener("dblclick", stopModuleCapacityEditEvent, true);
        element.addEventListener("keydown", stopModuleCapacityEditEvent, true);
    });
}

function stopModuleCapacityEditEvent(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
}

function refreshVehicleHoverEffects() {
    if (!canvas?.ready || !canvas.tokens) return;

    for (const token of canvas.tokens.placeables ?? []) {
        applyVehicleHoverIfNeeded(token);
    }
    ensureVehicleHoverTicker();
}

function applyVehicleHoverIfNeeded(token) {
    if (!canvas?.ready || !token?.document) return;
    if (!getHoverSettingsForTokenDocument(token.document).enabled) {
        stopVehicleHoverForTokenId(token.id);
        return;
    }
    if (token.actor?.type !== "vehicle" || token.document.hidden) {
        stopVehicleHoverForTokenId(token.id);
        return;
    }
    if (activeVehicleHovers.has(token.id)) return;

    const object = getVehicleHoverObject(token);
    const position = getVehicleHoverPosition(object);
    if (!position) return;

    activeVehicleHovers.set(token.id, {
        token,
        object,
        baseX: position.x,
        baseY: position.y,
        offsetX: 0,
        offsetY: 0,
        hoverSeed: getStableHoverSeed(token.id)
    });
    ensureVehicleHoverTicker();
}

function ensureVehicleHoverTicker() {
    if (vehicleHoverTicker || !canvas?.app?.ticker) return;

    vehicleHoverTicker = () => updateVehicleHovers();
    canvas.app.ticker.add(vehicleHoverTicker);
}

function updateVehicleHovers() {
    if (!canvas?.ready) {
        stopAllVehicleHovers();
        return;
    }

    for (const token of canvas.tokens?.placeables ?? []) {
        if (token.actor?.type === "vehicle" && !token.document.hidden) applyVehicleHoverIfNeeded(token);
    }

    const now = performance.now();
    for (const [tokenId, state] of activeVehicleHovers) {
        const token = canvas.tokens.get(tokenId);
        if (!token || token.actor?.type !== "vehicle" || token.document.hidden) {
            stopVehicleHoverState(tokenId, state);
            continue;
        }

        const object = getVehicleHoverObject(token);
        const position = getVehicleHoverPosition(object);
        if (!position) {
            stopVehicleHoverState(tokenId, state);
            continue;
        }

        if (object !== state.object) {
            restoreVehicleHoverState(state);
            state.object = object;
            state.baseX = position.x;
            state.baseY = position.y;
            state.offsetX = 0;
            state.offsetY = 0;
        } else {
            state.baseX = position.x - state.offsetX;
            state.baseY = position.y - state.offsetY;
        }

        const hoverSettings = getHoverSettingsForTokenDocument(token.document);
        if (!hoverSettings.enabled) {
            stopVehicleHoverState(tokenId, state);
            continue;
        }
        const amplitudeX = Math.max(0, hoverSettings.offsetX);
        const amplitudeY = Math.max(0, hoverSettings.offsetY);
        const speed = Math.max(0.1, hoverSettings.speed);
        const startOffset = state.hoverSeed.startOffsetMs;
        const cycle = ((now + startOffset) * speed) / VEHICLE_HOVER_LOOP_MS;
        const primary = cycle * Math.PI * 2;
        const secondary = (cycle * 1.73 + state.hoverSeed.secondaryPhase) * Math.PI * 2;
        const tertiary = (cycle * 0.61 + state.hoverSeed.tertiaryPhase) * Math.PI * 2;
        const offsetX = (
            Math.sin(primary + state.hoverSeed.xPhase) * 0.7 +
            Math.sin(secondary) * 0.22 +
            Math.cos(tertiary) * 0.08
        ) * amplitudeX;
        const offsetY = (
            Math.cos(primary * 0.83 + state.hoverSeed.yPhase) * 0.66 +
            Math.sin(secondary * 0.71 + state.hoverSeed.yPhase * 0.31) * 0.24 +
            Math.cos(tertiary * 1.37) * 0.1
        ) * amplitudeY;

        position.set(state.baseX + offsetX, state.baseY + offsetY);
        state.offsetX = offsetX;
        state.offsetY = offsetY;
    }

    if (!activeVehicleHovers.size) stopVehicleHoverTicker();
}

function stopVehicleHoverForTokenId(tokenId) {
    const state = activeVehicleHovers.get(tokenId);
    if (!state) return;
    stopVehicleHoverState(tokenId, state);
}

function stopVehicleHoverState(tokenId, state) {
    restoreVehicleHoverState(state);
    activeVehicleHovers.delete(tokenId);
    if (!activeVehicleHovers.size) stopVehicleHoverTicker();
}

function stopAllVehicleHovers() {
    for (const [tokenId, state] of activeVehicleHovers) {
        stopVehicleHoverState(tokenId, state);
    }
    stopVehicleHoverTicker();
}

function stopVehicleHoverTicker() {
    if (!vehicleHoverTicker || !canvas?.app?.ticker) return;
    canvas.app.ticker.remove(vehicleHoverTicker);
    vehicleHoverTicker = null;
}

function restoreVehicleHoverState(state) {
    const position = getVehicleHoverPosition(state?.object);
    if (!position) return;
    position.set(state.baseX, state.baseY);
    state.offsetX = 0;
    state.offsetY = 0;
}

function getVehicleHoverObject(token) {
    return token.mesh ?? token.icon ?? token.children?.find(child => child.texture || child.isSprite) ?? null;
}

function getVehicleHoverPosition(object) {
    if (!object || object.destroyed) return null;
    try {
        return object.position ?? null;
    } catch (error) {
        return null;
    }
}

function getStableHoverSeed(tokenId) {
    let hash = 2166136261;
    for (const character of String(tokenId ?? "")) {
        hash ^= character.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
    }

    const normalized = hash >>> 0;
    const ratio = part => ((normalized >>> part) & 0xff) / 255;
    return {
        startOffsetMs: normalized % VEHICLE_HOVER_MAX_START_OFFSET_MS,
        xPhase: ratio(0) * Math.PI * 2,
        yPhase: ratio(8) * Math.PI * 2,
        secondaryPhase: ratio(16),
        tertiaryPhase: ratio(24)
    };
}

function startVehicleMotionEffects(tokenDocument, options) {
    if (!canvas?.ready || !canvas.tokens) return;

    const token = canvas.tokens.get(tokenDocument.id);
    if (!token) return;

    const current = { x: tokenDocument.x, y: tokenDocument.y };
    const motion = options?.fullSpeedAheadMotion ?? getFallbackMotion(tokenDocument, current);
    lastTokenPositions.delete(tokenDocument.id);
    if (!motion) return;

    stopVehicleMotionEffects(tokenDocument.id);

    const effects = getProfileMotionSettings(tokenDocument);
    const thruster = effects.enableThrusterEffect ? createUnderTokenThruster(token) : null;
    if (thruster) thruster.alpha = 0;

    const controller = {
        destroyed: false,
        thruster,
        lastRotationUpdate: 0,
        currentRotation: motion.startRotation
    };
    activeMotionEffects.set(tokenDocument.id, controller);

    const startTime = performance.now();
    const maxDuration = 5000;
    const tick = () => {
        if (controller.destroyed) return;

        const progress = getMotionProgress(token, motion);
        if (effects.rotation.rotateBeforeMove) {
            updateSmoothRotation(tokenDocument, motion, progress, controller);
        } else {
            controller.currentRotation = motion.targetRotation;
        }
        if (controller.thruster && !controller.thruster.destroyed) {
            controller.thruster.alpha = Math.min(0.85, 0.85 * ((performance.now() - startTime) / 180));
        }
        drawThrusterCone(controller.thruster, token, controller.currentRotation);

        if (progress >= 0.995 || performance.now() - startTime > maxDuration) {
            finishVehicleMotionEffects(tokenDocument, motion, controller, tick);
        }
    };

    controller.tick = tick;
    canvas.app.ticker.add(tick);
}

function getFallbackMotion(tokenDocument, destination) {
    const origin = lastTokenPositions.get(tokenDocument.id);
    if (!origin) return null;

    const targetRotation = getHeadingRotation(origin, destination);
    if (targetRotation === null) return null;

    return {
        origin,
        destination,
        startRotation: normalizeDegrees(tokenDocument.rotation ?? 0),
        targetRotation: normalizeDegrees(targetRotation + getVehicleRotationOffset(tokenDocument)),
        rotationSettings: getRotationSettingsForTokenDocument(tokenDocument)
    };
}

function getMotionProgress(token, motion) {
    const totalDistance = Math.hypot(
        motion.destination.x - motion.origin.x,
        motion.destination.y - motion.origin.y
    );
    if (totalDistance === 0) return 1;

    const currentX = Number.isFinite(token.x) ? token.x : motion.destination.x;
    const currentY = Number.isFinite(token.y) ? token.y : motion.destination.y;
    const traveled = Math.hypot(currentX - motion.origin.x, currentY - motion.origin.y);
    return Math.max(0, Math.min(1, traveled / totalDistance));
}

function updateSmoothRotation(tokenDocument, motion, moveProgress, controller) {
    const totalDistance = Math.hypot(
        motion.destination.x - motion.origin.x,
        motion.destination.y - motion.origin.y
    );
    const rotationSettings = motion.rotationSettings ?? getRotationSettingsForTokenDocument(tokenDocument);
    const finishDistance = Math.max(canvas.grid.size * 0.1, rotationSettings.rotationFinishSquares * canvas.grid.size);
    const rotationProgress = totalDistance <= finishDistance ? moveProgress : Math.min(1, moveProgress * totalDistance / finishDistance);
    const easedProgress = easeOutCubic(rotationProgress);
    const target = interpolateRotation(motion.startRotation, motion.targetRotation, easedProgress);
    const now = performance.now();
    const interval = Math.max(25, rotationSettings.rotationDelayMs);
    controller.currentRotation = target;

    if (rotationProgress < 1 && now - controller.lastRotationUpdate < interval) return;
    controller.lastRotationUpdate = now;

    const rounded = Math.round(target);
    if (normalizeDegrees(tokenDocument.rotation ?? 0) === normalizeDegrees(rounded)) return;
    if (!canUpdateTokenDocument(tokenDocument)) return;

    tokenDocument.update(
        { rotation: rounded },
        { animate: false, [INTERNAL_MOVE]: true, fullSpeedAheadRotationOnly: true }
    ).catch(error => console.warn(`${LOG_PREFIX} Could not update smooth vehicle rotation.`, error));
}

function finishVehicleMotionEffects(tokenDocument, motion, controller, tick) {
    canvas.app.ticker.remove(tick);
    if (canUpdateTokenDocument(tokenDocument)) {
        tokenDocument.update(
            { rotation: motion.targetRotation },
            { animate: false, [INTERNAL_MOVE]: true, fullSpeedAheadRotationOnly: true }
        ).catch(error => console.warn(`${LOG_PREFIX} Could not finish vehicle rotation.`, error));
    }

    fadeAndDestroyThruster(controller);
    activeMotionEffects.delete(tokenDocument.id);
}

function canUpdateTokenDocument(tokenDocument) {
    return game.user.isGM || tokenDocument.canUserModify?.(game.user, "update") === true;
}

function stopVehicleMotionEffects(tokenId) {
    const controller = activeMotionEffects.get(tokenId);
    if (!controller) return;

    controller.destroyed = true;
    if (controller.tick) canvas.app.ticker.remove(controller.tick);
    fadeAndDestroyThruster(controller);
    activeMotionEffects.delete(tokenId);
}

function createUnderTokenThruster(token) {
    const graphics = new PIXI.Graphics();
    graphics.blendMode = PIXI.BLEND_MODES.ADD;
    graphics.alpha = 0.85;
    graphics.eventMode = "none";
    graphics.interactive = false;
    graphics.zIndex = getTokenSortValue(token) - 1;

    const layer = canvas.primary ?? canvas.tokens;
    layer.sortableChildren = true;
    layer.addChildAt(graphics, 0);
    return graphics;
}

function drawThrusterCone(graphics, token, rotation, dimensions = null) {
    if (!graphics || graphics.destroyed) return;

    const resolvedDimensions = normalizeThrusterConfig(dimensions ?? getThrusterDimensions(token.document), getThrusterColor(token));
    const centerX = token.x + token.w / 2;
    const centerY = token.y + token.h / 2;
    const radians = normalizeDegrees(rotation) * Math.PI / 180;
    const forwardX = Math.sin(radians);
    const forwardY = -Math.cos(radians);
    const sideX = -forwardY;
    const sideY = forwardX;
    const scaleFactor = getThrusterScaleFactor(resolvedDimensions.scale);
    const tokenVisualDimensions = getTokenVisualDimensions(token);
    const designUnit = scaleFactor * canvas.grid.size * tokenVisualDimensions.scale;
    const rearDistance = Math.max(0, getTokenVisualHalfExtent(token, forwardX, forwardY) * 0.96 + resolvedDimensions.position * designUnit);
    const rearX = centerX - forwardX * rearDistance;
    const rearY = centerY - forwardY * rearDistance;

    graphics.clear();
    graphics.zIndex = getTokenSortValue(token) - 1;

    const coneCount = Math.max(1, Math.min(3, resolvedDimensions.coneCount));
    for (let coneIndex = 0; coneIndex < coneCount; coneIndex++) {
        const cone = resolvedDimensions.cones[coneIndex] ?? resolvedDimensions.cones[0];
        const offset = getThrusterConeOffset(coneIndex, coneCount) * resolvedDimensions.coneSpacing * designUnit;
        drawSingleThrusterCone(graphics, {
            rearX: rearX + sideX * offset,
            rearY: rearY + sideY * offset,
            forwardX,
            forwardY,
            sideX,
            sideY,
            length: cone.length * designUnit,
            width: cone.width * designUnit,
            color: hexToNumber(cone.color, 0x40c7ff),
            inverted: Boolean(cone.inverted)
        });
    }
}

function getThrusterConeOffset(coneIndex, coneCount) {
    if (coneIndex === 0) return 0;
    if (coneCount === 2) return 1;
    return coneIndex === 1 ? -1 : 1;
}

function drawSingleThrusterCone(graphics, cone) {
    const tipX = cone.rearX - cone.forwardX * cone.length;
    const tipY = cone.rearY - cone.forwardY * cone.length;
    const segments = 8;

    for (let i = 0; i < segments; i++) {
        const start = i / segments;
        const end = (i + 1) / segments;
        const startWidth = cone.width * (cone.inverted ? start : 1 - start);
        const endWidth = cone.width * (cone.inverted ? end : 1 - end);
        const alpha = 0.65 * Math.pow(1 - start, 1.8);
        const startX = cone.rearX + (tipX - cone.rearX) * start;
        const startY = cone.rearY + (tipY - cone.rearY) * start;
        const endX = cone.rearX + (tipX - cone.rearX) * end;
        const endY = cone.rearY + (tipY - cone.rearY) * end;

        graphics.beginFill(cone.color, alpha);
        graphics.drawPolygon([
            startX + cone.sideX * startWidth / 2, startY + cone.sideY * startWidth / 2,
            startX - cone.sideX * startWidth / 2, startY - cone.sideY * startWidth / 2,
            endX - cone.sideX * endWidth / 2, endY - cone.sideY * endWidth / 2,
            endX + cone.sideX * endWidth / 2, endY + cone.sideY * endWidth / 2
        ]);
        graphics.endFill();
    }
}

function getTokenSortValue(token) {
    return Number.isFinite(token.mesh?.zIndex) ? token.mesh.zIndex : Number.isFinite(token.zIndex) ? token.zIndex : 0;
}

function getThrusterColor(token) {
    return getThrusterColorForTokenDocument(token.document);
}

function getThrusterColorForTokenDocument(tokenDocument) {
    const profile = getShipProfile(getShipProfileName(tokenDocument));
    const fallbackColor = game.settings.get(MODULE_ID, "thrusterColor") || DEFAULT_THRUSTER_COLOR;
    return profile?.thrusterColor ?? tokenDocument?.getFlag(MODULE_ID, THRUSTER_COLOR_FLAG) ?? fallbackColor;
}

async function setShipThrusterColor(tokenDocument, color) {
    const profileName = getShipProfileName(tokenDocument);
    if (!profileName) return;

    const fallbackColor = game.settings.get(MODULE_ID, "thrusterColor") || DEFAULT_THRUSTER_COLOR;
    const normalizedColor = /^#[0-9a-f]{6}$/i.test(color) ? color : fallbackColor;
    const profiles = getShipProfiles();
    const profileKey = normalizeShipProfileName(profileName);
    profiles[profileKey] = {
        ...(profiles[profileKey] ?? {}),
        name: profileName,
        thrusterColor: normalizedColor
    };
    await game.settings.set(MODULE_ID, SHIP_PROFILES_SETTING, profiles);
}

function getThrusterDimensions(tokenDocument) {
    return getThrusterDimensionsForProfile(canvas.scene?.id, getShipProfileName(tokenDocument));
}

function getThrusterDimensionsForProfile(sceneId, shipName) {
    const shipProfile = getShipProfile(shipName);
    const sceneProfile = getSceneThrusterProfile(sceneId, shipName);
    const color = shipProfile?.thrusterColor ?? game.settings.get(MODULE_ID, "thrusterColor") ?? DEFAULT_THRUSTER_COLOR;
    const profileConfig = normalizeThrusterConfig(shipProfile?.thrusterDimensions, color);
    const sceneScale = sceneProfile && Number.isFinite(Number(sceneProfile.scale)) ? Number(sceneProfile.scale) : profileConfig.scale;
    const config = normalizeThrusterConfig({ ...profileConfig, scale: sceneScale }, color);
    config.color = color;
    config.cones[0] = { ...config.cones[0], color };
    return config;
}

function normalizeThrusterConfig(config, fallbackColor = DEFAULT_THRUSTER_COLOR) {
    const scale = clampNumber(Number(config?.scale), -10, 10, getSettingNumber("thrusterScale", 0));
    const position = clampNumber(Number(config?.position), -6, 6, 0);
    const length = clampNumber(Number(config?.length), 0.25, 12, getSettingNumber("thrusterLength", 1.25));
    const width = clampNumber(Number(config?.width), 0.1, 6, getSettingNumber("thrusterWidth", 0.55));
    const color = normalizeHexColor(config?.color, fallbackColor);
    const coneCount = Math.round(clampNumber(Number(config?.coneCount), 1, 3, 1));
    const coneSpacing = clampNumber(Number(config?.coneSpacing), 0, 6, 0.45);
    const rawCones = Array.isArray(config?.cones) ? config.cones : [];
    const cones = [0, 1, 2].map(index => {
        const cone = rawCones[index] ?? {};
        return {
            color: normalizeHexColor(cone.color, index === 0 ? color : color),
            length: clampNumber(Number(cone.length), 0.25, 12, length),
            width: clampNumber(Number(cone.width), 0.1, 6, width),
            inverted: Boolean(cone.inverted)
        };
    });

    cones[0] = { ...cones[0], color, length, width };

    return { scale, position, length, width, color, coneCount, coneSpacing, cones };
}

function getSceneThrusterProfiles() {
    return foundry.utils.deepClone(game.settings.get(MODULE_ID, SCENE_THRUSTER_PROFILES_SETTING) ?? {});
}

function getSceneThrusterProfile(sceneId, shipName) {
    return getSceneThrusterProfiles()[getSceneThrusterProfileKey(sceneId, shipName)];
}

function getSceneThrusterProfileKey(sceneId, shipName) {
    return `${sceneId || "global"}:${normalizeShipProfileName(shipName)}`;
}

async function setSceneThrusterDimensions(tokenDocument, dimensions) {
    return setSceneThrusterDimensionsForProfile(canvas.scene?.id, getShipProfileName(tokenDocument), dimensions);
}

async function setSceneThrusterDimensionsForProfile(sceneId, shipName, dimensions) {
    const profileName = String(shipName ?? "").trim();
    if (!profileName) {
        await game.settings.set(MODULE_ID, "thrusterLength", clampNumber(Number(dimensions.length), 0.25, 12, getSettingNumber("thrusterLength", 1.25)));
        await game.settings.set(MODULE_ID, "thrusterWidth", clampNumber(Number(dimensions.width), 0.1, 6, getSettingNumber("thrusterWidth", 0.55)));
        return;
    }

    const profiles = getSceneThrusterProfiles();
    profiles[getSceneThrusterProfileKey(sceneId, profileName)] = {
        sceneId: sceneId || "global",
        name: profileName,
        ...normalizeThrusterConfig(dimensions, getShipProfile(profileName)?.thrusterColor ?? DEFAULT_THRUSTER_COLOR)
    };
    await game.settings.set(MODULE_ID, SCENE_THRUSTER_PROFILES_SETTING, profiles);
}

async function setSceneThrusterScaleForProfile(sceneId, shipName, scale) {
    const profileName = String(shipName ?? "").trim();
    if (!profileName) return;

    const profiles = getSceneThrusterProfiles();
    const key = getSceneThrusterProfileKey(sceneId, profileName);
    profiles[key] = {
        ...(profiles[key] ?? {}),
        sceneId: sceneId || "global",
        name: profileName,
        scale: clampNumber(Number(scale), -10, 10, 0)
    };
    await game.settings.set(MODULE_ID, SCENE_THRUSTER_PROFILES_SETTING, profiles);
}

async function clearSceneThrusterDimensions(tokenDocument) {
    const profileName = getShipProfileName(tokenDocument);
    if (!profileName) return;

    return clearSceneThrusterDimensionsForProfile(canvas.scene?.id, profileName);
}

async function clearSceneThrusterDimensionsForProfile(sceneId, shipName) {
    const profileName = String(shipName ?? "").trim();
    if (!profileName) return;

    const profiles = getSceneThrusterProfiles();
    delete profiles[getSceneThrusterProfileKey(sceneId, profileName)];
    await game.settings.set(MODULE_ID, SCENE_THRUSTER_PROFILES_SETTING, profiles);
}

function showThrusterPreview(token, dimensions) {
    if (!activeThrusterPreview || activeThrusterPreview.destroyed || !activeThrusterPreview.parent) {
        activeThrusterPreview = createUnderTokenThruster(token);
    }

    activeThrusterPreview.alpha = 0.9;
    drawThrusterCone(activeThrusterPreview, token, dimensions.rotation, dimensions);
}

function clearThrusterPreview() {
    if (!activeThrusterPreview || activeThrusterPreview.destroyed) return;
    activeThrusterPreview.destroy({ children: true });
    activeThrusterPreview = null;
}

function getMovementSoundOptions(tokenDocument, providedProfile = null) {
    const profile = providedProfile ?? getShipProfile(getShipProfileName(tokenDocument));
    const enabled = getProfileBoolean(profile, "enableMovementSound", "enableMovementSound");
    const hasProfilePath = Object.prototype.hasOwnProperty.call(profile ?? {}, "movementSoundPath");
    const hasProfileVolume = Object.prototype.hasOwnProperty.call(profile ?? {}, "movementSoundVolume");
    const src = String(hasProfilePath ? profile.movementSoundPath : game.settings.get(MODULE_ID, "movementSoundPath") ?? DEFAULT_MOVEMENT_SOUND_PATH).trim();
    const volume = clampNumber(
        Number(hasProfileVolume ? profile.movementSoundVolume : game.settings.get(MODULE_ID, "movementSoundVolume")),
        0,
        1,
        0.18
    );

    return { enabled, src, volume };
}

function getProfileBoolean(profile, profileKey, settingKey) {
    if (Object.prototype.hasOwnProperty.call(profile ?? {}, profileKey)) return Boolean(profile[profileKey]);
    return Boolean(game.settings.get(MODULE_ID, settingKey));
}

function getProfileRotationSettings(profile = null) {
    const rotation = profile?.rotationSettings ?? {};
    return {
        vehicleBowFacing: getValidVehicleBowFacing(rotation.vehicleBowFacing ?? game.settings.get(MODULE_ID, "vehicleBowFacing")),
        enableShipRotation: Object.prototype.hasOwnProperty.call(rotation, "enableShipRotation") ? Boolean(rotation.enableShipRotation) : Boolean(game.settings.get(MODULE_ID, "enableShipRotation")),
        rotateBeforeMove: Object.prototype.hasOwnProperty.call(rotation, "rotateBeforeMove") ? Boolean(rotation.rotateBeforeMove) : Boolean(game.settings.get(MODULE_ID, "rotateBeforeMove")),
        rotationDelayMs: clampNumber(Number(rotation.rotationDelayMs), 25, 500, getSettingNumber("rotationDelayMs", 75)),
        rotationFinishSquares: clampNumber(Number(rotation.rotationFinishSquares), 0.25, 10, getSettingNumber("rotationFinishSquares", 2)),
        rotationOffset: clampNumber(Number(rotation.rotationOffset), -180, 180, getSettingNumber("rotationOffset", 0))
    };
}

function getProfileHoverSettings(profile = null) {
    const hover = profile?.hoverSettings ?? {};
    return {
        enabled: Object.prototype.hasOwnProperty.call(hover, "enabled") ? Boolean(hover.enabled) : Boolean(game.settings.get(MODULE_ID, "enableVehicleHoverEffect")),
        offsetX: clampNumber(Number(hover.offsetX), 0, 50, getSettingNumber("vehicleHoverOffsetX", 2)),
        offsetY: clampNumber(Number(hover.offsetY), 0, 50, getSettingNumber("vehicleHoverOffsetY", 3)),
        speed: clampNumber(Number(hover.speed), 0.1, 5, getSettingNumber("vehicleHoverSpeed", 1))
    };
}

function getProfileProtectionSettings(profile = null) {
    const protection = profile?.protectionSettings ?? {};
    return {
        enabled: Object.prototype.hasOwnProperty.call(protection, "enabled") ? Boolean(protection.enabled) : Boolean(game.settings.get(MODULE_ID, "vehicleShieldAutomation")),
        visualMode: getValidProtectionVisualMode(protection.visualMode ?? game.settings.get(MODULE_ID, "vehicleProtectionVisualMode"))
    };
}

function getRotationSettingsForTokenDocument(tokenDocument) {
    return getProfileRotationSettings(getShipProfile(getShipProfileName(tokenDocument)));
}

function getHoverSettingsForTokenDocument(tokenDocument) {
    return getProfileHoverSettings(getShipProfile(getShipProfileName(tokenDocument)));
}

function getProtectionSettingsForActor(actor) {
    const tokenDocument = (canvas?.tokens?.placeables ?? []).find(token => token.actor?.id === actor?.id)?.document;
    if (tokenDocument) return getProtectionSettingsForTokenDocument(tokenDocument);
    return getProfileProtectionSettings(getShipProfile(String(actor?.name ?? "")));
}

function getProtectionSettingsForTokenDocument(tokenDocument) {
    return getProfileProtectionSettings(getShipProfile(getShipProfileName(tokenDocument)));
}

function getProfileMotionSettings(tokenDocument) {
    const profile = getShipProfile(getShipProfileName(tokenDocument));
    return {
        enableThrusterEffect: getProfileBoolean(profile, "enableThrusterEffect", "enableThrusterEffect"),
        rotation: getProfileRotationSettings(profile)
    };
}

function getShipProfiles() {
    return foundry.utils.deepClone(game.settings.get(MODULE_ID, SHIP_PROFILES_SETTING) ?? {});
}

function getDisabledTargetingCardUsers() {
    return foundry.utils.deepClone(game.settings.get(MODULE_ID, DISABLED_TARGETING_CARD_USERS_SETTING) ?? {});
}

function getDisabledCharacterCardUsers() {
    return foundry.utils.deepClone(game.settings.get(MODULE_ID, DISABLED_CHARACTER_CARD_USERS_SETTING) ?? {});
}

function getDisabledVehicleCardUsers() {
    return foundry.utils.deepClone(game.settings.get(MODULE_ID, DISABLED_VEHICLE_CARD_USERS_SETTING) ?? {});
}

function collectTargetingCardUsers() {
    return Array.from(game.users ?? [])
        .filter(user => user && !user.isGM)
        .sort((a, b) => a.name.localeCompare(b.name));
}

function getShipProfile(shipName) {
    return getShipProfiles()[normalizeShipProfileName(shipName)];
}

function normalizeShipProfileName(shipName) {
    return String(shipName ?? "").trim().toLocaleLowerCase();
}

function getShipProfileName(tokenDocument) {
    return getAssignedShipProfileName(tokenDocument) || getDefaultShipProfileName(tokenDocument);
}

function getDefaultShipProfileName(tokenDocument) {
    return String(tokenDocument?.name || tokenDocument?.actor?.name || "").trim();
}

function getAssignedShipProfileName(tokenDocument) {
    return String(tokenDocument?.getFlag?.(MODULE_ID, SHIP_PROFILE_FLAG) ?? "").trim();
}

async function setAssignedShipProfileName(tokenDocument, profileName) {
    if (!tokenDocument) return;

    const selectedProfile = String(profileName ?? "").trim();
    const defaultProfile = getDefaultShipProfileName(tokenDocument);
    if (!selectedProfile || normalizeShipProfileName(selectedProfile) === normalizeShipProfileName(defaultProfile)) {
        if (getAssignedShipProfileName(tokenDocument)) await tokenDocument.unsetFlag(MODULE_ID, SHIP_PROFILE_FLAG);
        return;
    }

    await tokenDocument.setFlag(MODULE_ID, SHIP_PROFILE_FLAG, selectedProfile);
}

function collectVehicleShipNames() {
    const names = new Set();

    for (const actor of game.actors ?? []) {
        if (actor.type === "vehicle") names.add(actor.name);
    }

    for (const token of canvas?.tokens?.placeables ?? []) {
        if (token.actor?.type === "vehicle") {
            names.add(getDefaultShipProfileName(token.document));
            names.add(getShipProfileName(token.document));
        }
    }

    for (const profile of Object.values(getShipProfiles())) {
        if (profile?.name) names.add(profile.name);
    }

    return Array.from(names).filter(Boolean).sort((a, b) => a.localeCompare(b));
}

function fadeAndDestroyThruster(controller) {
    const graphics = controller.thruster;
    if (!graphics || graphics.destroyed) return;

    const startedAt = performance.now();
    const startAlpha = graphics.alpha;
    const duration = 250;
    const fade = () => {
        const progress = Math.min(1, (performance.now() - startedAt) / duration);
        graphics.alpha = startAlpha * (1 - progress);
        if (progress < 1) return;

        canvas.app.ticker.remove(fade);
        graphics.destroy({ children: true });
    };
    canvas.app.ticker.add(fade);
}

function interpolateRotation(start, end, progress) {
    return normalizeDegrees(start + shortestRotationDelta(start, end) * progress);
}

function shortestRotationDelta(start, end) {
    return ((((end - start) % 360) + 540) % 360) - 180;
}

function easeOutCubic(progress) {
    return 1 - Math.pow(1 - Math.max(0, Math.min(1, progress)), 3);
}

function hexToNumber(value, fallback) {
    if (typeof value !== "string") return fallback;
    const normalized = value.trim().replace(/^#/, "");
    if (!/^[0-9a-f]{6}$/i.test(normalized)) return fallback;
    return parseInt(normalized, 16);
}
