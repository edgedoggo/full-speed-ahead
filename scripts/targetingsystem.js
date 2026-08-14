// targetingsystem.js: QuickTarget range overlays, the T-key override, and private attack cards.

const MODULE_ID = "full-speed-ahead";
const DISABLED_TARGETING_CARD_ACTORS_SETTING = "disabledTargetingCardActors";
const DISABLED_TARGETING_CARD_USERS_SETTING = "disabledTargetingCardUsers";
const DISABLED_CHARACTER_CARD_USERS_SETTING = "disabledCharacterTargetingCardUsers";
const DISABLED_VEHICLE_CARD_USERS_SETTING = "disabledVehicleTargetingCardUsers";
const STANDALONE_QUICKTARGET_MODULE_IDS = ["quicktarget", "quick-target", "vehicle-quicktarget", "vehicle-quick-target"];

export class TargetingSystem {
    static async highlightWeaponRange(sourceToken = null) {
        if (!isAnyQuickTargetEnabled()) {
            console.log("QuickTarget is disabled in settings. Exiting highlightWeaponRange.");
            return;
        }

        const selectedToken = sourceToken ?? getActingToken();
        if (!selectedToken) return;
        if (!isQuickTargetEnabledForSource(selectedToken)) {
            ui.notifications.warn(`${getQuickTargetFeatureName(selectedToken)} is disabled in Full Speed Ahead settings.`);
            return;
        }

        const actor = selectedToken.actor;
        if (!actor) {
            ui.notifications.warn("The selected token does not have an actor.");
            return;
        }

        const gridUnit = canvas.scene.grid.units;
        if (gridUnit.toLowerCase() !== "ft" && gridUnit.toLowerCase() !== "m") {
            ui.notifications.error("There are weapons equipped that function at this range.");
            return;
        }

        const hiddenWindows = [...Object.values(ui.windows)];
        hiddenWindows.forEach(win => win.minimize());

        const { weapons, spells } = getActorAttacks(actor);

        ui.notifications.error("Please click on the token you wish to target!");
        document.body.style.cursor = "crosshair";

        let floatingElements = [];
        let cleanedUp = false;
        let longRangeTemplate;
        let shortRangeTemplate;

        if (actor.type === "vehicle") {
            const templates = await createVehicleRangeTemplates(selectedToken);
            longRangeTemplate = templates.longRangeTemplate;
            shortRangeTemplate = templates.shortRangeTemplate;
        }

        for (let token of canvas.tokens.placeables) {
            if (!isPotentialTarget(token, selectedToken)) continue;

            const { distance, validAttacks } = getTargetingData(selectedToken, token, weapons, spells);
            const { text, textColor } = getRangeLabel(distance, validAttacks);

            const transparentMat = new PIXI.Graphics();
            transparentMat.beginFill(0x000000, 0.001);
            transparentMat.drawRect(token.center.x - token.w / 2, token.center.y - token.h / 2, token.w, token.h);
            transparentMat.endFill();
            transparentMat.interactive = true;
            transparentMat.buttonMode = true;
            canvas.stage.addChild(transparentMat);
            floatingElements.push(transparentMat);

            const targetNameText = new PIXI.Text(token.name, {
                fontFamily: "Arial",
                fontSize: 22,
                fill: "#FFFFFF",
                stroke: "#000000",
                strokeThickness: 4,
                dropShadow: true,
                dropShadowColor: "#000000",
                dropShadowBlur: 4,
                dropShadowAngle: Math.PI / 6,
                dropShadowDistance: 4
            });
            targetNameText.position.set(token.center.x + 60, token.center.y - 42);
            canvas.stage.addChild(targetNameText);
            floatingElements.push(targetNameText);

            const floatingText = new PIXI.Text(text, {
                fontFamily: "Arial",
                fontSize: 24,
                fill: textColor,
                stroke: "#000000",
                strokeThickness: 4,
                dropShadow: true,
                dropShadowColor: "#000000",
                dropShadowBlur: 4,
                dropShadowAngle: Math.PI / 6,
                dropShadowDistance: 4
            });
            floatingText.position.set(token.center.x + 60, token.center.y - 16);
            canvas.stage.addChild(floatingText);
            floatingElements.push(floatingText);

            const distanceText = `${distance} ${actor.type === "vehicle" ? "M" : "ft"} away`;
            const floatingDistanceText = new PIXI.Text(distanceText, {
                fontFamily: "Arial",
                fontSize: 20,
                fill: "#FFFFFF",
                align: "left",
                padding: 2,
                dropShadow: true,
                dropShadowColor: "#000000",
                dropShadowBlur: 4,
                dropShadowAngle: Math.PI / 6,
                dropShadowDistance: 4
            });
            floatingDistanceText.position.set(token.center.x + 62, token.center.y + 14);
            canvas.stage.addChild(floatingDistanceText);
            floatingElements.push(floatingDistanceText);

            const clickIconText = new PIXI.Text("⌖", {
                fontFamily: "Arial",
                fontSize: 60,
                fill: getTargetCrosshairColor(token),
                stroke: "#000000",
                strokeThickness: 8,
                dropShadow: true,
                dropShadowColor: "#000000",
                dropShadowBlur: 4,
                dropShadowAngle: Math.PI / 6,
                dropShadowDistance: 4
            });
            clickIconText.position.set(token.center.x - 32, token.center.y - 48);
            clickIconText.interactive = true;
            clickIconText.buttonMode = true;
            canvas.stage.addChild(clickIconText);
            floatingElements.push(clickIconText);

            const selectTarget = async event => {
                stopFoundryEvent(event);
                await TargetingSystem.targetTokenAndShowAttacks(selectedToken, token, validAttacks, distance);
                cleanupTargetingDisplay();
                selectedToken.control({ releaseOthers: true });
            };

            transparentMat.on("pointerdown", selectTarget);
            clickIconText.on("pointerdown", selectTarget);
        }

        const cancelTargetingOnEscape = event => {
            if (event.key !== "Escape") return;
            stopFoundryEvent(event);
            cleanupTargetingDisplay();
        };

        const cancelTargetingOnBoardClick = event => {
            if (floatingElements.includes(event.target)) return;
            cleanupTargetingDisplay();
        };

        document.addEventListener("keydown", cancelTargetingOnEscape, true);
        canvas.stage?.on("pointerdown", cancelTargetingOnBoardClick);

        if (game.settings.get(MODULE_ID, "autoRemoveTargetingTemplate")) {
            const removalSeconds = Math.max(1, getRangeNumber(game.settings.get(MODULE_ID, "targetingTemplateRemovalSeconds")) || 10);
            setTimeout(() => cleanupTargetingDisplay(), removalSeconds * 1000);
        }

        function cleanupTargetingDisplay() {
            if (cleanedUp) return;
            cleanedUp = true;

            floatingElements.forEach(element => {
                if (canvas.stage.children.includes(element)) canvas.stage.removeChild(element);
            });
            floatingElements = [];
            document.body.style.cursor = "default";
            document.removeEventListener("keydown", cancelTargetingOnEscape, true);
            canvas.stage?.off("pointerdown", cancelTargetingOnBoardClick);

            if (longRangeTemplate?.[0]) canvas.scene.deleteEmbeddedDocuments("MeasuredTemplate", [longRangeTemplate[0].id]);
            if (shortRangeTemplate?.[0]) canvas.scene.deleteEmbeddedDocuments("MeasuredTemplate", [shortRangeTemplate[0].id]);

            hiddenWindows.forEach(win => win.maximize());
        }
    }

    static async handleTargetShortcut(event) {
        if (!isTargetShortcutEvent(event)) return;
        if (!isAnyQuickTargetEnabled()) return;
        if (!canvas?.ready || !canvas.tokens) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        const sourceToken = getActingToken();
        if (!sourceToken) return;
        if (!isQuickTargetEnabledForSource(sourceToken)) {
            ui.notifications.warn(`${getQuickTargetFeatureName(sourceToken)} is disabled in Full Speed Ahead settings.`);
            return;
        }

        const hoveredToken = getHoveredTargetToken(sourceToken);
        if (!hoveredToken) {
            await TargetingSystem.highlightWeaponRange(sourceToken);
            return;
        }

        const { weapons, spells } = getActorAttacks(sourceToken.actor);
        const { distance, validAttacks } = getTargetingData(sourceToken, hoveredToken, weapons, spells);
        await TargetingSystem.targetTokenAndShowAttacks(sourceToken, hoveredToken, validAttacks, distance);
    }

    static async handleDoubleRightClickTarget(targetToken, event) {
        if (!isAnyQuickTargetEnabled()) return false;
        if (!game.settings.get(MODULE_ID, "replaceDoubleRightClickTargeting")) return false;
        if (!canvas?.ready || !targetToken?.actor || targetToken.document.hidden) return false;

        stopFoundryEvent(event);

        const sourceToken = getActingToken();
        if (!sourceToken) return true;
        if (!isQuickTargetEnabledForSource(sourceToken)) {
            ui.notifications.warn(`${getQuickTargetFeatureName(sourceToken)} is disabled in Full Speed Ahead settings.`);
            return true;
        }

        if (sourceToken.id === targetToken.id) {
            ui.notifications.warn("Please double right-click a target, not the attacking character.");
            return true;
        }

        const { weapons, spells } = getActorAttacks(sourceToken.actor);
        const { distance, validAttacks } = getTargetingData(sourceToken, targetToken, weapons, spells);
        await TargetingSystem.targetTokenAndShowAttacks(sourceToken, targetToken, validAttacks, distance);
        return true;
    }

    static async targetTokenAndShowAttacks(sourceToken, targetToken, validAttacks, distance) {
        setOnlyTarget(targetToken);
        ui.notifications.warn(`[QuickTarget] ${targetToken.name} has been targeted.`);
        console.log(`[QuickTarget] ${targetToken.name} has been targeted.`);
        AudioHelper.play({ src: "/modules/full-speed-ahead/sounds/lockon.ogg", volume: 0.3, autoplay: true, loop: false });
        await TargetingSystem.createAttackCard(sourceToken, targetToken, validAttacks, distance);
    }

    static async createAttackCard(sourceToken, targetToken, validAttacks, distance) {
        if (shouldHideAttackCardForSource(sourceToken)) return;

        const content = buildAttackCardContent(sourceToken, targetToken, validAttacks, distance);
        await ChatMessage.create({
            user: game.user.id,
            speaker: ChatMessage.getSpeaker({ token: sourceToken }),
            content,
            whisper: [game.user.id]
        });
    }

    static async rollAttackFromChat(event) {
        event.preventDefault();
        event.stopPropagation();

        const button = event.currentTarget;
        const item = await fromUuid(button.dataset.itemUuid);
        const targetToken = await getTokenObjectFromUuid(button.dataset.targetTokenUuid);
        const disadvantage = button.dataset.disadvantage === "true";

        if (!item) {
            ui.notifications.warn("That attack could not be found on the actor anymore.");
            return;
        }

        if (targetToken) setOnlyTarget(targetToken);

        const rollEvent = {
            altKey: disadvantage,
            ctrlKey: false,
            shiftKey: false,
            metaKey: false,
            currentTarget: button,
            target: button,
            preventDefault: () => {},
            stopPropagation: () => {}
        };

        const rollOptions = {
            event: rollEvent,
            disadvantage,
            advantage: false,
            rollMode: "publicroll",
            messageData: { whisper: [], blind: false }
        };
        if (typeof item.use === "function") await item.use(rollOptions);
        else if (typeof item.roll === "function") await item.roll(rollOptions);
        else ui.notifications.warn(`${item.name} cannot be rolled directly by Full Speed Ahead.`);
    }
}

async function createVehicleRangeTemplates(selectedToken) {
    const actor = selectedToken.actor;
    let longRangeTemplate;
    let shortRangeTemplate;
    const weaponArrayItems = actor.items.filter(i => i.type === "weapon" && getRangeNumber(i.system.range?.long) > 0);
    if (!weaponArrayItems.length) return { longRangeTemplate, shortRangeTemplate };

    const highestLongRangeItem = weaponArrayItems.reduce((max, item) => getRangeNumber(item.system.range.long) > getRangeNumber(max.system.range.long) ? item : max);
    const longRange = getRangeNumber(highestLongRangeItem.system.range.long) - 50;
    const shortRange = getRangeNumber(highestLongRangeItem.system.range.value) - 50;
    const unit = highestLongRangeItem.system.range.units;

    if (longRange <= 0 || shortRange <= 0 || (unit !== "m" && unit !== "ft")) {
        return { longRangeTemplate, shortRangeTemplate };
    }

    longRangeTemplate = await canvas.scene.createEmbeddedDocuments("MeasuredTemplate", [{
        t: "circle",
        user: game.user.id,
        x: selectedToken.center.x,
        y: selectedToken.center.y,
        distance: longRange,
        borderColor: "",
        fillColor: "#898234",
        fillAlpha: 0.0,
        flags: { "myModule.weaponLongRangeTemplate": true }
    }]);

    shortRangeTemplate = await canvas.scene.createEmbeddedDocuments("MeasuredTemplate", [{
        t: "circle",
        user: game.user.id,
        x: selectedToken.center.x,
        y: selectedToken.center.y,
        distance: shortRange,
        borderColor: "",
        fillColor: "#159504",
        fillAlpha: 0.0,
        flags: { "myModule.weaponShortRangeTemplate": true }
    }]);

    return { longRangeTemplate, shortRangeTemplate };
}

function getActingToken() {
    const controlled = canvas.tokens.controlled.filter(token => token.actor);
    if (controlled.length === 1) return controlled[0];

    if (controlled.length > 1) {
        ui.notifications.warn("Please select the attacking character first.");
        return null;
    }

    const character = game.user.character;
    if (character) {
        const characterTokens = canvas.tokens.placeables.filter(token => token.actor?.id === character.id && !token.document.hidden);
        if (characterTokens.length === 1) return characterTokens[0];
        if (characterTokens.length > 1) {
            ui.notifications.warn("Please select the attacking character first.");
            return null;
        }
    }

    ui.notifications.warn("Please select the attacking character first.");
    return null;
}

function getActorAttacks(actor) {
    if (!actor) return { weapons: [], spells: [] };
    const weapons = actor.items.filter(item => item.type === "weapon" && item.system.equipped);
    const spells = actor.items.filter(item => item.type === "spell" && item.system.range?.value);
    return { weapons, spells };
}

function isAnyQuickTargetEnabled() {
    if (isStandaloneQuickTargetActive()) return false;
    return isNonVehicleQuickTargetEnabledForCurrentUser() || isVehicleQuickTargetEnabledForCurrentUser();
}

function isQuickTargetEnabledForSource(sourceToken) {
    return sourceToken?.actor?.type === "vehicle"
        ? isVehicleQuickTargetEnabledForCurrentUser()
        : isNonVehicleQuickTargetEnabledForCurrentUser();
}

function isNonVehicleQuickTargetEnabledForCurrentUser() {
    if (!game.settings.get(MODULE_ID, "enableTargetingSystem")) return false;
    return game.user.isGM
        ? game.settings.get(MODULE_ID, "enableTargetingSystemGM")
        : game.settings.get(MODULE_ID, "enableTargetingSystemPlayers");
}

function isVehicleQuickTargetEnabledForCurrentUser() {
    if (!game.settings.get(MODULE_ID, "enableVehicleQuickTarget")) return false;
    return game.user.isGM
        ? game.settings.get(MODULE_ID, "enableVehicleQuickTargetGM")
        : game.settings.get(MODULE_ID, "enableVehicleQuickTargetPlayers");
}

function getQuickTargetFeatureName(sourceToken) {
    return sourceToken?.actor?.type === "vehicle" ? "Vehicle QuickTarget" : "QuickTarget";
}

function isStandaloneQuickTargetActive() {
    const modules = Array.from(game.modules?.entries?.() ?? []);

    return modules.some(([moduleId, module]) => {
        const id = String(moduleId ?? module?.id ?? "");

        if (id === MODULE_ID || !module?.active) return false;

        const identity = `${id} ${module?.title ?? ""}`;

        return (
            STANDALONE_QUICKTARGET_MODULE_IDS.includes(id) ||
            /quick\s*-?\s*target/i.test(identity)
        );
    });
}

function getTargetingData(sourceToken, targetToken, weapons, spells) {
    const distance = canvas.grid.measureDistances([{ ray: new Ray(sourceToken.center, targetToken.center) }], { gridSpaces: true })[0];
    const validWeapons = weapons.filter(weapon => distance <= getAttackRanges(weapon).long);
    const validSpells = spells.filter(spell => distance <= getRangeNumber(spell.system.range?.value));
    return { distance, validAttacks: [...validWeapons, ...validSpells] };
}

function getRangeLabel(distance, validAttacks) {
    if (!validAttacks.length) return { text: "[Out of Range]", textColor: "#FF0000" };
    const inShortRange = distance <= Math.min(...validAttacks.map(attack => getAttackRanges(attack).short));
    return {
        text: "[In Range]",
        textColor: inShortRange ? "#00FF00" : "#FFFF00"
    };
}

function isPotentialTarget(token, selectedToken) {
    if (!token?.actor) return false;
    if (token.id === selectedToken.id || token.document.hidden) return false;
    return true;
}

function getTargetCrosshairColor(token) {
    return token?.actor?.hasPlayerOwner ? "#00FF66" : "#FF0000";
}

function getHoveredTargetToken(sourceToken) {
    const hovered = canvas.tokens.hover ?? canvas.tokens.placeables.find(token => token.hover || token._hover);
    if (!hovered || hovered.id === sourceToken.id || hovered.document.hidden) return null;
    return hovered;
}

function setOnlyTarget(targetToken) {
    game.user.targets.forEach(token => {
        if (token.id !== targetToken.id) token.setTarget(false, { user: game.user });
    });
    targetToken.setTarget(true, { user: game.user });
}

function shouldHideAttackCardForSource(sourceToken) {
    if (game.user.isGM) return false;

    const isVehicle = sourceToken?.actor?.type === "vehicle";
    const specificSetting = isVehicle
        ? DISABLED_VEHICLE_CARD_USERS_SETTING
        : DISABLED_CHARACTER_CARD_USERS_SETTING;
    const disabledUsers = game.settings.get(MODULE_ID, specificSetting) ?? {};
    if (disabledUsers[game.user.id]) return true;

    const legacyDisabledUsers = game.settings.get(MODULE_ID, DISABLED_TARGETING_CARD_USERS_SETTING) ?? {};
    if (legacyDisabledUsers[game.user.id]) return true;

    // Preserve actor exclusions saved by versions up to v1.0.43.
    const actorId = sourceToken?.actor?.id;
    if (!actorId) return false;

    const disabledActors = game.settings.get(MODULE_ID, DISABLED_TARGETING_CARD_ACTORS_SETTING) ?? {};
    return Boolean(disabledActors[actorId]);
}

function buildAttackCardContent(sourceToken, targetToken, validAttacks, distance) {
    const sourceName = escapeHtml(sourceToken.name);
    const targetName = escapeHtml(targetToken.name);
    const distanceText = escapeHtml(`${distance} ${sourceToken.actor?.type === "vehicle" ? "M" : "ft"} away`);

    if (!validAttacks.length) {
        return `<div class="full-speed-ahead-target-card">
            <p><strong>${sourceName}</strong> has no available attacks in range for <strong>${targetName}</strong>.</p>
            <p>${distanceText}</p>
        </div>`;
    }

    const buttons = validAttacks.map(attack => {
        const ranges = getAttackRanges(attack);
        const disadvantage = distance > ranges.short && distance <= ranges.long;
        const prefix = disadvantage ? "[Dis.] " : "";
        const title = disadvantage ? "Roll with disadvantage" : "Roll normally";
        return `<button type="button"
                class="full-speed-ahead-roll-attack"
                data-item-uuid="${escapeHtml(attack.uuid)}"
                data-target-token-uuid="${escapeHtml(targetToken.document.uuid)}"
                data-disadvantage="${disadvantage ? "true" : "false"}"
                title="${title}"
                style="display:block;width:100%;margin:4px 0;text-align:left;">
            ${escapeHtml(prefix + attack.name)}
        </button>`;
    }).join("");

    return `<div class="full-speed-ahead-target-card">
        <p><strong>${sourceName}</strong> targeting <strong>${targetName}</strong></p>
        <p>${distanceText}</p>
        <div>${buttons}</div>
    </div>`;
}

async function getTokenObjectFromUuid(uuid) {
    const document = await fromUuid(uuid);
    if (!document) return null;
    return document.object ?? canvas.tokens.get(document.id) ?? null;
}

function isTargetShortcutEvent(event) {
    if (event.repeat) return false;
    if (event.key?.toLowerCase() !== "t" && event.code !== "KeyT") return false;
    if (event.altKey || event.ctrlKey || event.metaKey) return false;

    const target = event.target;
    if (target?.closest?.("input, textarea, select, [contenteditable='true']")) return false;
    return true;
}

function stopFoundryEvent(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    event?.stopImmediatePropagation?.();
    event?.data?.originalEvent?.preventDefault?.();
    event?.data?.originalEvent?.stopPropagation?.();
    event?.data?.originalEvent?.stopImmediatePropagation?.();
}

function patchDoubleRightClickTargeting() {
    if (!globalThis.Token?.prototype?._onClickRight2) return;
    if (Token.prototype._fullSpeedAheadRightClickPatched) return;

    const original = Token.prototype._onClickRight2;
    Token.prototype._onClickRight2 = function(event) {
        if (
            !isAnyQuickTargetEnabled() ||
            !game.settings.get(MODULE_ID, "replaceDoubleRightClickTargeting")
        ) {
            return original.call(this, event);
        }

        void TargetingSystem.handleDoubleRightClickTarget(this, event);
        return false;
    };
    Token.prototype._fullSpeedAheadRightClickPatched = true;
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

function getRangeNumber(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    const normalized = String(value ?? "").replace(/,/g, "").trim();
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
}

function getAttackRanges(attack) {
    const short = getRangeNumber(attack.system.range?.value);
    const long = getRangeNumber(attack.system.range?.long) || short;
    return { short, long };
}

Hooks.on("ready", () => {
    game.modules.get(MODULE_ID).api = {
        ...(game.modules.get(MODULE_ID).api ?? {}),
        highlightWeaponRange: TargetingSystem.highlightWeaponRange
    };

    if (isStandaloneQuickTargetActive()) {
        console.log("Standalone QuickTarget detected. Full Speed Ahead bundled QuickTarget handlers are idle.");
        return;
    }

    document.addEventListener("keydown", event => TargetingSystem.handleTargetShortcut(event), true);
    patchDoubleRightClickTargeting();

    Hooks.on("renderChatMessage", (_message, html) => {
        html.find(".full-speed-ahead-roll-attack").on("click", event => TargetingSystem.rollAttackFromChat(event));
    });

    console.log("QuickTarget has been initialized");
});
