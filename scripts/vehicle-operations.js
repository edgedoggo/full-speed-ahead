// vehicle-operations.js: Full Speed Ahead vehicle damage, scans, repairs, and heat-sink operations.

const FSA_MODULE_ID = "full-speed-ahead";
const FSA_SOCKET = `module.${FSA_MODULE_ID}`;
const FSA_DESTROYED_FLAG = "destroyedUnequipped";
const FSA_GLAXON_FLAG = "glaxonInsured";
const FSA_GLAXON_MIGRATION_FLAG = "glaxonInsuranceMigrated";
const FSA_POWER_CORE_OFFLINE_FLAG = "powerCoreOffline";
const FSA_HEAT_SINK_CARD_SELECTOR = "[data-fsa-heat-sink], [data-fsa-heat-sink-no]";
const FSA_STRUCTURAL_SYNC_DELAY_MS = 500;
const FSA_DEFAULT_DATA = { pendingCarryover: {} };
const FSA_REPAIR_ACTIONS = new Set(["repair-module", "stabilize-module", "full-service", "pristine"]);
const FSA_DAMAGE_CONTEXTS = new Set(["attack", "fuel", "mining"]);
const fsaVehicleSyncTimers = new Map();
const fsaPromptRegistry = new Map();
let fsaSharedCapitalRefreshTimer = null;

function fsaVehiclePromptKey(actor, suffix) {
    return `vehicle:${actor?.uuid || actor?.id || actor?.name || "unknown"}:${suffix}`;
}

function focusFsaPrompt(app) {
    try {
        app?.bringToTop?.();
        const element = app?.element;
        if (!element?.length) return;
        element[0].scrollIntoView?.({ block: "nearest", inline: "nearest" });
        const target = element.find("input, select, textarea, button").filter(":visible").first();
        (target[0] ?? element[0])?.focus?.();
    } catch (_error) {
        // Focusing is only a convenience; never let it interrupt the originating action.
    }
}

function renderUniqueFsaDialog(key, data, options = {}) {
    const existing = fsaPromptRegistry.get(key);
    if (existing?.rendered) {
        focusFsaPrompt(existing);
        return existing;
    }

    const originalClose = data.close;
    const dialog = new Dialog({
        ...data,
        close: (...args) => {
            fsaPromptRegistry.delete(key);
            return originalClose?.(...args);
        }
    }, options);
    fsaPromptRegistry.set(key, dialog);
    dialog.render(true);
    return dialog;
}

function renderUniqueFsaApplication(key, createApp) {
    const existing = fsaPromptRegistry.get(key);
    if (existing?.rendered) {
        focusFsaPrompt(existing);
        return existing;
    }

    const app = createApp();
    const originalClose = app.close.bind(app);
    app.close = async function(options) {
        fsaPromptRegistry.delete(key);
        return originalClose(options);
    };
    fsaPromptRegistry.set(key, app);
    app.render(true);
    return app;
}

async function confirmUniqueFsaDialog(key, data, options = {}) {
    const existing = fsaPromptRegistry.get(key);
    if (existing?.rendered) {
        focusFsaPrompt(existing);
        return false;
    }

    return new Promise(resolve => {
        let resolved = false;
        renderUniqueFsaDialog(key, {
            title: data.title,
            content: data.content,
            buttons: {
                yes: {
                    icon: data.yesIcon ?? '<i class="fas fa-check"></i>',
                    label: data.yesLabel ?? "Yes",
                    callback: html => {
                        resolved = true;
                        resolve(data.yes ? data.yes(html) : true);
                    }
                },
                no: {
                    icon: data.noIcon ?? '<i class="fas fa-times"></i>',
                    label: data.noLabel ?? "No",
                    callback: html => {
                        resolved = true;
                        resolve(data.no ? data.no(html) : false);
                    }
                }
            },
            default: data.defaultYes === false ? "no" : "yes",
            close: () => {
                if (!resolved) resolve(false);
            }
        }, options);
    });
}

class TradeHubIntegrationAdapter {
    static isAvailable() {
        return Boolean(game.modules?.get("tradehub-markets")?.active);
    }

    static capitalGetter() {
        return [
            game.tradehub?.getCapital,
            game.tradehub?.capital,
            game.tradehub?.bankBalance,
            game.tradehub?.getBankBalance
        ].find(method => typeof method === "function") || null;
    }

    static capitalSetter() {
        return [
            game.tradehub?.setCapital,
            game.tradehub?.updateCapital,
            game.tradehub?.updateBank,
            game.tradehub?.setBankBalance
        ].find(method => typeof method === "function") || null;
    }

    static usesTradeHubCapital() {
        return this.isAvailable() && (this.capitalGetter() || typeof this.data().capital !== "undefined");
    }

    static setting(key, fallback = null) {
        if (!this.isAvailable()) return fallback;
        try {
            return game.settings.get("tradehub-markets", key);
        } catch (_error) {
            return fallback;
        }
    }

    static data() {
        const data = this.setting("data", {});
        return foundry.utils.deepClone(data && typeof data === "object" ? data : {});
    }

    static fallbackCapital() {
        try {
            return Number(game.settings.get(FSA_MODULE_ID, "vehicleOpsFallbackCapital") || 0);
        } catch (_error) {
            return 0;
        }
    }

    static fallbackWasUsed() {
        try {
            return Boolean(game.settings.get(FSA_MODULE_ID, "vehicleOpsFallbackCapitalWasUsed"));
        } catch (_error) {
            return false;
        }
    }

    static async setFallbackCapital(value) {
        await game.settings.set(FSA_MODULE_ID, "vehicleOpsFallbackCapital", Math.max(0, Number(value || 0)));
    }

    static capitalAvailable() {
        return this.usesTradeHubCapital() || Number.isFinite(this.fallbackCapital());
    }

    static capital() {
        if (this.usesTradeHubCapital()) {
            const getter = this.capitalGetter();
            const publicCapital = getter ? getter.call(game.tradehub) : null;
            if (Number.isFinite(Number(publicCapital))) return Number(publicCapital);
            return Number(this.data().capital || 0);
        }
        return this.fallbackCapital();
    }

    static capitalSourceLabel() {
        return this.usesTradeHubCapital() ? "TradeHub Markets" : "Full Speed Ahead";
    }

    static async reconcileSharedCapital() {
        if (!game.user?.isGM) return;
        if (!this.usesTradeHubCapital()) return;
        const tradeHubCapital = this.capital();
        const fallbackCapital = this.fallbackCapital();
        if (tradeHubCapital <= 0 && fallbackCapital > 0 && this.fallbackWasUsed()) {
            await this.setCapital(fallbackCapital);
            return;
        }
        if (fallbackCapital !== tradeHubCapital) await this.setFallbackCapital(tradeHubCapital);
        if (this.fallbackWasUsed()) await game.settings.set(FSA_MODULE_ID, "vehicleOpsFallbackCapitalWasUsed", false);
    }

    static async setCapital(value) {
        if (!this.capitalAvailable()) throw new Error("TradeHub billing is unavailable.");
        if (!game.user?.isGM) throw new Error("Only the active GM can update TradeHub Capital.");
        const clamped = Math.max(0, Number(value || 0));
        const setter = this.capitalSetter();
        if (this.usesTradeHubCapital() && setter) {
            await setter.call(game.tradehub, clamped);
            await this.setFallbackCapital(clamped);
            await game.settings.set(FSA_MODULE_ID, "vehicleOpsFallbackCapitalWasUsed", false);
            this.refreshTradeHub();
            return;
        }
        if (this.usesTradeHubCapital()) {
            const data = this.data();
            data.capital = clamped;
            await game.settings.set("tradehub-markets", "data", data);
            await this.setFallbackCapital(clamped);
            await game.settings.set(FSA_MODULE_ID, "vehicleOpsFallbackCapitalWasUsed", false);
        } else {
            await this.setFallbackCapital(clamped);
            await game.settings.set(FSA_MODULE_ID, "vehicleOpsFallbackCapitalWasUsed", true);
        }
        this.refreshTradeHub();
        refreshSharedCapitalInterfaces({ broadcast: true });
    }

    static async bill(amount) {
        const cost = Math.max(0, Number(amount || 0));
        if (!cost) return { charged: 0, unpaid: 0, remaining: this.capitalAvailable() ? this.capital() : 0 };
        if (!this.capitalAvailable()) throw new Error("TradeHub Capital is unavailable. Install/enable TradeHub Markets or configure an FSA currency provider before using capital-billing actions.");
        const current = this.capital();
        const charged = Math.min(current, cost);
        const remaining = Math.max(0, current - cost);
        await this.setCapital(remaining);
        return { charged, unpaid: Math.max(0, cost - current), remaining };
    }

    static async requireAndBill(amount) {
        const cost = Math.max(0, Number(amount || 0));
        if (!this.capitalAvailable()) throw new Error("TradeHub Capital is unavailable. Install/enable TradeHub Markets or configure an FSA currency provider before using capital-billing actions.");
        if (this.capital() < cost) throw new Error("Not enough TradeHub Capital.");
        await this.setCapital(this.capital() - cost);
        return { charged: cost, unpaid: 0, remaining: this.capital() };
    }

    static repairCostPerHp() {
        return Number(this.setting("repairCostPerHp", game.settings.get(FSA_MODULE_ID, "vehicleOpsRepairCostPerHp")) || 0);
    }

    static repairCostPerShieldPoint() {
        return Number(this.setting("repairCostPerShieldPoint", game.settings.get(FSA_MODULE_ID, "vehicleOpsRepairCostPerShieldPoint")) || 0);
    }

    static insuranceConfirmationRequired() {
        const localRequired = Boolean(game.settings.get(FSA_MODULE_ID, "vehicleOpsInsuranceCodeRequired"));
        const getter = [
            game.tradehub?.isInsuranceConfirmationRequired,
            game.tradehub?.getInsuranceConfirmationRequired,
            game.tradehub?.isGlaxonInsuranceConfirmationRequired,
            game.tradehub?.getGlaxonInsuranceConfirmationRequired
        ].find(method => typeof method === "function");
        const apiRequired = getter ? Boolean(getter()) : false;

        const tradeHubKeys = ["insuranceConfirmationRequired", "glaxonInsuranceConfirmationRequired", "shipInsuranceConfirmationRequired"];
        const tradeHubKey = tradeHubKeys.find(key => this.tradeHubSettingExists(key));
        const tradeHubRequired = tradeHubKey ? Boolean(this.setting(tradeHubKey, false)) : false;

        return Boolean(localRequired || apiRequired || tradeHubRequired || this.insuranceConfirmationCode());
    }

    static insuranceCompanyName() {
        const getter = [
            game.tradehub?.getInsuranceCompanyName,
            game.tradehub?.getGlaxonInsuranceCompanyName
        ].find(method => typeof method === "function");
        const tradeHubName = getter ? getter() : null;
        return String(tradeHubName || game.settings.get(FSA_MODULE_ID, "vehicleOpsInsuranceCompanyName") || "Glaxxon Insurance").trim() || "Glaxxon Insurance";
    }

    static async setInsuranceCompanyName(name) {
        const normalized = String(name || "Glaxxon Insurance").trim() || "Glaxxon Insurance";
        await game.settings.set(FSA_MODULE_ID, "vehicleOpsInsuranceCompanyName", normalized);
        return normalized;
    }

    static insuranceConfirmationCode() {
        const getter = [
            game.tradehub?.getInsuranceConfirmationCode,
            game.tradehub?.getGlaxonInsuranceConfirmationCode
        ].find(method => typeof method === "function");
        if (getter) return String(getter() || "").trim();

        const tradeHubKeys = ["insuranceConfirmationCode", "glaxonInsuranceConfirmationCode", "shipInsuranceConfirmationCode"];
        const tradeHubKey = tradeHubKeys.find(key => this.tradeHubSettingExists(key));
        if (tradeHubKey) return String(this.setting(tradeHubKey, "") || "").trim();

        return String(game.settings.get(FSA_MODULE_ID, "vehicleOpsInsuranceConfirmationCode") || "").trim();
    }

    static validateInsuranceConfirmationCode(code) {
        if (!this.insuranceConfirmationRequired()) return true;
        const expected = this.insuranceConfirmationCode();
        const companyName = this.insuranceCompanyName();
        if (!expected) throw new Error(`${companyName} confirmation is required, but no confirmation code has been configured.`);
        if (String(code || "").trim() !== expected) throw new Error(`Invalid ${companyName} confirmation code.`);
        return true;
    }

    static tradeHubSettingExists(key) {
        return this.isAvailable() && Boolean(game.settings?.settings?.has?.(`tradehub-markets.${key}`));
    }

    static numberSetting(key, fallback) {
        return Math.max(0, Number(this.setting(key, fallback) ?? fallback));
    }

    static shipUpkeepPercent() {
        const getter = game.tradehub?.getShipUpkeepPercent;
        if (typeof getter === "function") return Math.max(0, Number(getter.call(game.tradehub) ?? 0.2));
        if (this.tradeHubSettingExists("shipUpkeepPercent")) return this.numberSetting("shipUpkeepPercent", 0.2);
        return Math.max(0, Number(game.settings.get(FSA_MODULE_ID, "vehicleOpsShipUpkeepPercent") ?? 0.2));
    }

    static calculateShipUpkeep(totalShipValue) {
        const calculate = game.tradehub?.calculateShipUpkeep;
        if (typeof calculate === "function") return Math.max(0, Number(calculate.call(game.tradehub, totalShipValue) || 0));
        return this.calculateShipUpkeepFromPercent(totalShipValue);
    }

    static calculateShipUpkeepFromPercent(totalShipValue) {
        return Math.floor(Math.max(0, Number(totalShipValue || 0)) * this.shipUpkeepPercent() / 100);
    }

    static async setShipUpkeepPercent(value) {
        const percent = Math.max(0, Number(value ?? 0.2));
        if (this.tradeHubSettingExists("shipUpkeepPercent")) {
            await game.settings.set("tradehub-markets", "shipUpkeepPercent", percent);
        }
        await game.settings.set(FSA_MODULE_ID, "vehicleOpsShipUpkeepPercent", percent);
        return this.shipUpkeepPercent();
    }

    static glaxonInsurancePremiumPercent() {
        const getters = [
            game.tradehub?.getGlaxonInsurancePremiumPercent,
            game.tradehub?.getShipInsurancePremiumPercent,
            game.tradehub?.getInsurancePremiumPercent
        ];
        const getter = getters.find(method => typeof method === "function");
        if (getter) return Math.max(0, Number(getter.call(game.tradehub) ?? 5));

        const settingKeys = ["glaxonInsurancePremiumPercent", "shipInsurancePremiumPercent", "insurancePremiumPercent"];
        const key = settingKeys.find(settingKey => this.tradeHubSettingExists(settingKey));
        if (key) return this.numberSetting(key, 5);
        return Math.max(0, Number(game.settings.get(FSA_MODULE_ID, "vehicleOpsGlaxonPremiumPercent") ?? 5));
    }

    static glaxonPremiumSettingKey() {
        const settingKeys = ["glaxonInsurancePremiumPercent", "shipInsurancePremiumPercent", "insurancePremiumPercent"];
        return settingKeys.find(settingKey => this.tradeHubSettingExists(settingKey)) || null;
    }

    static async setGlaxonInsurancePremiumPercent(value) {
        const percent = Math.max(0, Number(value ?? 5));
        const tradeHubKey = this.glaxonPremiumSettingKey();
        if (tradeHubKey) await game.settings.set("tradehub-markets", tradeHubKey, percent);
        await game.settings.set(FSA_MODULE_ID, "vehicleOpsGlaxonPremiumPercent", percent);
        return this.glaxonInsurancePremiumPercent();
    }

    static calculateGlaxonInsurancePremium(totalRepairValue) {
        const calculators = [
            game.tradehub?.calculateGlaxonInsurancePremium,
            game.tradehub?.calculateShipInsurancePremium,
            game.tradehub?.calculateInsurancePremium
        ];
        const calculate = calculators.find(method => typeof method === "function");
        if (calculate) return Math.max(0, Number(calculate.call(game.tradehub, totalRepairValue) || 0));
        return this.calculateGlaxonInsurancePremiumFromPercent(totalRepairValue);
    }

    static calculateGlaxonInsurancePremiumFromPercent(totalRepairValue) {
        return Math.ceil(Math.max(0, Number(totalRepairValue || 0)) * this.glaxonInsurancePremiumPercent() / 100);
    }

    static isGlaxonInsured(actor) {
        return actor?.getFlag?.("tradehub-markets", FSA_GLAXON_FLAG) === true || actor?.getFlag?.(FSA_MODULE_ID, FSA_GLAXON_FLAG) === true;
    }

    static async setGlaxonInsured(actor, insured) {
        if (!actor) return;
        if (insured) {
            await actor.setFlag(FSA_MODULE_ID, FSA_GLAXON_FLAG, true);
            await actor.setFlag("tradehub-markets", FSA_GLAXON_FLAG, true);
        } else {
            await actor.unsetFlag(FSA_MODULE_ID, FSA_GLAXON_FLAG);
            await actor.unsetFlag("tradehub-markets", FSA_GLAXON_FLAG);
        }
    }

    static locations() {
        const journal = game.journal?.getName?.("TradeHubData");
        const journalNames = Array.from(journal?.pages || []).map(page => page.name?.trim()).filter(Boolean);
        if (journalNames.length) return [...new Set(journalNames)].sort((a, b) => a.localeCompare(b));
        return Object.keys(this.data().locations || {}).filter(Boolean).sort((a, b) => a.localeCompare(b));
    }

    static async hydrogenFuelData() {
        const existing = Array.from(game.items ?? []).find(item => item.name?.toLowerCase() === "hydrogen fuel" && ["loot", "consumable"].includes(item.type));
        if (existing) return duplicateDocumentData(existing);
        if (!this.isAvailable()) return null;
        const packId = this.setting("tradeGoodsPack", "");
        const folderPath = String(this.setting("tradeGoodsFolderPath", "") || "").trim().toLowerCase();
        const pack = packId ? game.packs.get(packId) : null;
        if (!pack) return null;
        const docs = await pack.getDocuments();
        const hydrogen = docs.find(doc => doc.name?.toLowerCase() === "hydrogen fuel" && (!folderPath || folderMatchesPath(doc.folder, folderPath)));
        return hydrogen ? duplicateDocumentData(hydrogen) : null;
    }

    static refreshTradeHub() {
        try {
            game.tradehub?.refresh?.();
        } catch (_error) {
            // Adapter refresh is best-effort only.
        }
    }
}

class VehicleTargetResolver {
    static current({ notify = true, requireModules = false } = {}) {
        if (!game.settings.get(FSA_MODULE_ID, "vehicleOpsEnabled")) {
            if (notify) ui.notifications.warn("Full Speed Ahead vehicle operations are disabled.");
            return null;
        }
        const targeted = Array.from(game.user?.targets ?? []).find(token => token?.actor?.type === "vehicle");
        const controlled = canvas?.tokens?.controlled?.find(token => token?.actor?.type === "vehicle");
        const token = targeted || controlled;
        if (!token?.actor || token.actor.type !== "vehicle") {
            if (notify) ui.notifications.warn("Target or select a vehicle token first.");
            return null;
        }
        const modules = requireModules ? VehicleModuleService.damageableModules(token.actor) : [];
        if (requireModules && !modules.length) {
            ui.notifications.warn(`${token.actor.name} has no equipped, HP-bearing vehicle modules.`);
            return null;
        }
        return this.packToken(token);
    }

    static firstSceneVehicle() {
        if (!game.settings.get(FSA_MODULE_ID, "vehicleOpsEnabled")) {
            ui.notifications.warn("Full Speed Ahead vehicle operations are disabled.");
            return null;
        }
        const option = currentSceneVehicleOptions().find(entry => entry.id);
        const tokenDocument = option?.id ? canvas?.scene?.tokens?.get(option.id) : null;
        if (!tokenDocument?.actor || tokenDocument.actor.type !== "vehicle") {
            ui.notifications.warn("No vehicle tokens are available on this scene.");
            return null;
        }
        return this.packToken(tokenDocument);
    }

    static packToken(tokenOrDocument) {
        const tokenDocument = tokenOrDocument?.document || tokenOrDocument;
        const actor = tokenOrDocument?.actor || tokenDocument?.actor;
        const scene = tokenOrDocument?.scene || tokenDocument?.parent || canvas?.scene;
        return {
            actorId: actor?.id || tokenDocument?.actorId || "",
            actorUuid: actor?.uuid || "",
            sceneId: scene?.id || canvas?.scene?.id || "",
            tokenId: tokenDocument?.id || "",
            tokenUuid: tokenDocument?.uuid || "",
            name: tokenOrDocument?.name || tokenDocument?.name || actor?.name || ""
        };
    }

    static resolve(payload = {}) {
        const scene = payload.sceneId ? game.scenes.get(payload.sceneId) : null;
        const tokenDocument = payload.tokenId && scene ? scene.tokens.get(payload.tokenId) : null;
        const actor = tokenDocument?.actor || (payload.actorUuid ? fromUuidSyncSafe(payload.actorUuid) : null) || game.actors.get(payload.actorId);
        return { scene, tokenDocument, actor };
    }
}

function vehicleOperationsHasOwnerPermission(document, user) {
    if (!document || !user) return false;
    if (typeof document.testUserPermission === "function") return document.testUserPermission(user, "OWNER");
    const ownerLevel = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
    const ownership = document.ownership || {};
    return Number(ownership[user.id] ?? ownership.default ?? 0) >= ownerLevel;
}

function vehicleOperationsIsPlayerVehicle(tokenDocument) {
    const actor = tokenDocument?.actor;
    return game.users?.contents?.some(user => !user.isGM && (
        vehicleOperationsHasOwnerPermission(actor, user) ||
        vehicleOperationsHasOwnerPermission(tokenDocument, user)
    )) === true;
}

function currentSceneVehicleOptions(target = {}) {
    const scene = canvas?.scene;
    const tokenDocuments = Array.from(scene?.tokens ?? []).filter(tokenDocument => tokenDocument?.actor?.type === "vehicle");
    return tokenDocuments
        .map(tokenDocument => {
            const actor = tokenDocument.actor;
            const playerVehicle = vehicleOperationsIsPlayerVehicle(tokenDocument);
            const tokenName = tokenDocument.name || actor?.name || "Unnamed Vehicle";
            const actorName = actor?.name || tokenName;
            const label = tokenName === actorName ? tokenName : `${tokenName} (${actorName})`;
            return {
                id: tokenDocument.id,
                label,
                playerVehicle,
                selected: tokenDocument.id === target?.tokenId
            };
        })
        .sort((a, b) => Number(b.playerVehicle) - Number(a.playerVehicle) || a.label.localeCompare(b.label));
}

class VehicleModuleService {
    static isEquippedShipModule(item) {
        return ["equipment", "weapon"].includes(item?.type) && item?.system?.equipped === true;
    }

    static isShipModuleItem(item) {
        return ["equipment", "weapon"].includes(item?.type) && this.itemMaxHp(item) > 0;
    }

    static wasDestroyed(item) {
        return item?.getFlag?.(FSA_MODULE_ID, FSA_DESTROYED_FLAG) === true || item?.getFlag?.("tradehub-markets", FSA_DESTROYED_FLAG) === true;
    }

    static damageableModules(actor) {
        return Array.from(actor?.items ?? []).filter(item => this.isEquippedShipModule(item) && this.itemMaxHp(item) > 0);
    }

    static isOperationalShipModule(item) {
        return this.isShipModuleItem(item) && this.isEquippedShipModule(item) && this.itemHp(item) > 0;
    }

    static offlineModuleError(item, label = "Module") {
        const name = item?.name || label;
        return `${name} is offline or unequipped and cannot be used.`;
    }

    static assertOperationalShipModule(item, label = "Module") {
        if (!item) throw new Error(`${label} module not found.`);
        if (!this.isOperationalShipModule(item)) throw new Error(this.offlineModuleError(item, label));
        return item;
    }

    static selectedOperationalModule(actor, itemId, label = "Selected module") {
        if (!itemId || itemId === "evenly") return null;
        const item = actor?.items?.get(itemId);
        if (!item) return null;
        return this.assertOperationalShipModule(item, label);
    }

    static repairableModules(actor) {
        return Array.from(actor?.items ?? []).filter(item => this.isShipModuleItem(item) && (this.isEquippedShipModule(item) || this.wasDestroyed(item)));
    }

    static itemMaxHp(item) {
        return Number(item?.system?.hp?.max || 0);
    }

    static itemHp(item) {
        return Number(item?.system?.hp?.value || 0);
    }

    static itemAc(item) {
        return Number(item?.system?.armor?.value ?? item?.system?.ac?.value ?? 0);
    }

    static isShield(item) {
        return /shield generator/i.test(item?.name || "");
    }

    static isPowerCore(item) {
        return /power core/i.test(item?.name || "");
    }

    static hasOnlinePowerCore(actor) {
        return Array.from(actor?.items ?? []).some(item => this.isShipModuleItem(item) && this.isPowerCore(item) && item?.system?.equipped === true && this.itemHp(item) > 0);
    }

    static powerCoreShutdownActive(actor) {
        return actor?.getFlag?.(FSA_MODULE_ID, FSA_POWER_CORE_OFFLINE_FLAG) === true || Array.from(actor?.items ?? []).some(item => this.isShipModuleItem(item) && this.isPowerCore(item) && item?.system?.equipped !== true);
    }

    static shieldModules(actor) {
        return Array.from(actor?.items ?? []).filter(item => this.isShipModuleItem(item) && this.isShield(item) && this.itemMaxHp(item) > 0);
    }

    static activeShield(actor) {
        return this.shieldModules(actor)
            .filter(item => this.isOperationalShipModule(item))
            .sort((a, b) => Number(this.isEquippedShipModule(b)) - Number(this.isEquippedShipModule(a)) || this.itemHp(b) - this.itemHp(a))[0] || null;
    }

    static findModule(actor, pattern) {
        return Array.from(actor?.items ?? []).find(item => this.isOperationalShipModule(item) && pattern.test(item.name || ""));
    }

    static firstHealthyHull(actor) {
        return this.damageableModules(actor).find(item => /hull reinforcements?/i.test(item.name || "") && this.itemHp(item) > 0);
    }

    static heatSink(actor) {
        return Array.from(actor?.items ?? []).find(item => {
            if (!/heat sink/i.test(item.name || "")) return false;
            if (Number(item.system?.quantity ?? 1) <= 0) return false;
            if (item.system && Object.prototype.hasOwnProperty.call(item.system, "equipped") && item.system.equipped !== true) return false;
            if (this.itemMaxHp(item) > 0 && this.itemHp(item) <= 0) return false;
            return true;
        });
    }

    static requireOperationalModule(actor, pattern, label) {
        const item = this.findModule(actor, pattern);
        if (!item) throw new Error(`${label} is offline, unequipped, destroyed, or missing. ${label} cannot be used.`);
        return item;
    }

    static hydrogenFuel(actor) {
        return Array.from(actor?.items ?? []).find(item => item.name?.toLowerCase() === "hydrogen fuel" && ["loot", "consumable"].includes(item.type));
    }

    static async consumeHeatSink(actor) {
        const heatSink = this.heatSink(actor);
        if (!heatSink) return false;
        if (this.isShipModuleItem(heatSink)) this.assertOperationalShipModule(heatSink, "Heat Sink");
        const quantity = Number(heatSink.system?.quantity ?? 1);
        if (quantity > 1) await heatSink.update({ "system.quantity": quantity - 1 });
        else await heatSink.delete();
        return true;
    }

    static async updateModuleHp(item, hp) {
        const value = Math.max(0, Number(hp || 0));
        const update = { "system.hp.value": value };
        if (value <= 0 && this.isEquippedShipModule(item)) {
            update["system.equipped"] = false;
            update[`flags.${FSA_MODULE_ID}.${FSA_DESTROYED_FLAG}`] = true;
        }
        await item.update(update, { fullSpeedAheadVehicleOperation: true });
    }

    static async restoreModuleHp(item, hp = this.itemMaxHp(item)) {
        const value = Math.max(0, Number(hp || 0));
        const update = { "system.hp.value": value };
        if (value > 0 && this.wasDestroyed(item)) {
            update["system.equipped"] = true;
            update[`flags.${FSA_MODULE_ID}.${FSA_DESTROYED_FLAG}`] = false;
        }
        await item.update(update, { fullSpeedAheadVehicleOperation: true });
    }

    static async repairEquippedModuleHp(item, hp) {
        if (!this.isEquippedShipModule(item)) throw new Error(`${item?.name || "Module"} must be stabilized before it can be repaired.`);
        const value = clampNumber(Number(hp || 0), 0, this.itemMaxHp(item), 0);
        await item.update({ "system.hp.value": value }, { fullSpeedAheadVehicleOperation: true });
    }

    static async stabilizeModule(item) {
        await item.update({
            "system.hp.value": 1,
            "system.equipped": true,
            [`flags.${FSA_MODULE_ID}.${FSA_DESTROYED_FLAG}`]: false,
            "flags.tradehub-markets.destroyedUnequipped": false
        }, { fullSpeedAheadVehicleOperation: true });
    }

    static async disableModulesForPowerCoreFailure(actor) {
        if (!actor || actor.type !== "vehicle") return;
        const updates = Array.from(actor.items ?? [])
            .filter(item => this.isShipModuleItem(item))
            .map(item => ({
                _id: item.id,
                "system.equipped": false
            }));
        if (updates.length) await actor.updateEmbeddedDocuments("Item", updates, { fullSpeedAheadVehicleOperation: true });
        await actor.update({
            "system.attributes.hp.value": 1,
            [`flags.${FSA_MODULE_ID}.${FSA_POWER_CORE_OFFLINE_FLAG}`]: true
        }, { fullSpeedAheadVehicleOperation: true });
    }

    static async enableModulesForPowerCoreRestore(actor) {
        if (!actor || actor.type !== "vehicle") return;
        const modulesToEquip = Array.from(actor.items ?? [])
            .filter(item => this.isShipModuleItem(item) && this.itemHp(item) > 0);
        const restoredHpTotal = modulesToEquip.reduce((sum, item) => sum + this.itemHp(item), 0);
        const updates = modulesToEquip.map(item => ({
                _id: item.id,
                "system.equipped": true,
                [`flags.${FSA_MODULE_ID}.${FSA_DESTROYED_FLAG}`]: false,
                "flags.tradehub-markets.destroyedUnequipped": false
            }));
        if (updates.length) await actor.updateEmbeddedDocuments("Item", updates, { fullSpeedAheadVehicleOperation: true });
        await actor.update({
            "system.attributes.hp.value": restoredHpTotal,
            [`flags.${FSA_MODULE_ID}.${FSA_POWER_CORE_OFFLINE_FLAG}`]: false
        }, { fullSpeedAheadVehicleOperation: true });
    }

    static currentModuleHpTotal(actor) {
        return this.damageableModules(actor).reduce((sum, item) => sum + Math.max(0, Math.min(this.itemHp(item), this.itemMaxHp(item))), 0);
    }

    static async syncVehicleHpFromModules(actor) {
        const modules = this.damageableModules(actor);
        const moduleTotal = modules.reduce((sum, item) => sum + this.itemHp(item), 0);
        const total = moduleTotal <= 0 && this.powerCoreShutdownActive(actor) ? 1 : moduleTotal;
        await actor.update({ "system.attributes.hp.value": total }, { fullSpeedAheadVehicleOperation: true });
        return total;
    }

    static statSummary(actor) {
        const modules = this.damageableModules(actor);
        const nonShield = modules.filter(item => !this.isShield(item));
        const totalMaxHp = modules.reduce((sum, item) => sum + this.itemMaxHp(item), 0);
        const shieldHp = modules.filter(item => this.isShield(item)).reduce((sum, item) => sum + this.itemMaxHp(item), 0);
        const acModules = nonShield.filter(item => this.itemAc(item) > 0);
        const averageAc = acModules.length ? Math.round(acModules.reduce((sum, item) => sum + this.itemAc(item), 0) / acModules.length) : 0;
        const moduleValue = modules.reduce((sum, item) => sum + parseNumber(item.system?.price?.value ?? item.system?.price ?? 0), 0);
        const shipCost = parseNumber(actor.system?.traits?.dimensions || 0);
        return { modules, totalMaxHp, shieldHp, averageAc, moduleValue, shipCost, totalValue: shipCost + moduleValue, hyperdrive: VehicleScanService.hyperdriveRange(actor) };
    }

    static shipValue(actor) {
        return parseNumber(actor?.system?.traits?.dimensions || 0) + parseNumber(actor?.system?.details?.source?.custom || 0);
    }

    static upkeepCost(actor) {
        const totalShipValue = this.shipValue(actor);
        return TradeHubIntegrationAdapter.calculateShipUpkeep(totalShipValue);
    }

    static fullRepairValue(actor) {
        return this.damageableModules(actor).reduce((total, item) => total + this.itemMaxHp(item) * VehicleRepairService.unitCost(item), 0);
    }

    static glaxonPremium(actor) {
        const value = this.fullRepairValue(actor);
        return TradeHubIntegrationAdapter.calculateGlaxonInsurancePremium(value);
    }

    static wantedCrew(actor) {
        const crew = actor?.system?.cargo?.crew || [];
        const entries = Array.isArray(crew) ? crew : Object.values(crew);
        return entries.some(member => String(typeof member === "string" ? member : member?.name ?? member?.label ?? "").includes("[Wanted]"));
    }

    static registrationCost(actor) {
        return this.wantedCrew(actor) ? 4000 : 2000;
    }

    static async syncVehicleStatsFromModules(actor, { restore = false, reason = "Loadout updated", chat = false, userId = game.user.id } = {}) {
        if (!actor || actor.type !== "vehicle") throw new Error("Selected vehicle not found.");
        if (restore) {
            for (const item of this.repairableModules(actor)) await this.restoreModuleHp(item, this.itemMaxHp(item));
        }
        const summary = this.statSummary(actor);
        const currentHp = restore ? summary.totalMaxHp : this.currentModuleHpTotal(actor);
        const publicBio = [
            `HP Adjusted to ${summary.totalMaxHp} HP`,
            `Current Shields: ${summary.shieldHp} HP`,
            `Max Jump Distance: ${summary.hyperdrive}`,
            `Cargo Capacity: ${actor.system?.cargo?.capacity || 0} Tonnes`,
            `Ship Cost: ${Math.floor(summary.totalValue).toLocaleString()} GP`,
            `Average AC: ${summary.averageAc}`
        ].join("<br>");
        await actor.update({
            "system.attributes.hp.max": summary.totalMaxHp,
            "system.attributes.hp.value": currentHp,
            "system.attributes.ac.value": summary.averageAc,
            "system.details.source.custom": `Module Value: ${Math.floor(summary.moduleValue).toLocaleString()} GP`,
            "system.details.biography.public": publicBio
        }, { fullSpeedAheadVehicleOperation: true });
        if (restore) await VehicleTokenEffectService.refresh(actor);
        if (chat) {
            await VehicleChatCardService.create({
                user: userId,
                speaker: { alias: "Full Speed Ahead Vehicle Repair" },
                content: `<b>${escapeHtml(actor.name)} Made Pristine</b><br>${escapeHtml(reason)}<br>HP Adjusted to ${summary.totalMaxHp} HP<br>Current Shields: ${summary.shieldHp} HP<br>Max Jump Distance: ${escapeHtml(summary.hyperdrive)}<br>Ship Value: ${formatGp(summary.totalValue)}<br>Average AC: ${summary.averageAc}`
            });
        }
        return { ...summary, currentHp };
    }

    static scheduleStructuralSync(actor, reason) {
        if (!game.user?.isGM || !actor?.id || actor.type !== "vehicle") return;
        clearTimeout(fsaVehicleSyncTimers.get(actor.id));
        fsaVehicleSyncTimers.set(actor.id, window.setTimeout(async () => {
            fsaVehicleSyncTimers.delete(actor.id);
            try {
                await this.syncVehicleStatsFromModules(actor, { restore: false, reason });
            } catch (error) {
                console.warn(`${FSA_MODULE_ID} | Vehicle stat sync failed.`, error);
            }
        }, FSA_STRUCTURAL_SYNC_DELAY_MS));
    }
}

class VehicleDamageAllocator {
    static even(actor, amount, attack, { excludeShield = true } = {}) {
        let remaining = Math.max(0, Number(amount || 0));
        const modules = VehicleModuleService.damageableModules(actor);
        let pool = modules.filter(module => VehicleModuleService.itemHp(module) > 0 && VehicleModuleService.itemAc(module) <= Number(attack || 0) && (!excludeShield || !VehicleModuleService.isShield(module)));
        const hpRemaining = new Map(pool.map(module => [module.id, VehicleModuleService.itemHp(module)]));
        const allocations = new Map();
        while (remaining > 0 && pool.length) {
            const shuffled = shuffleArray(pool);
            const base = Math.floor(remaining / shuffled.length);
            let remainder = remaining % shuffled.length;
            let overflow = 0;
            for (const module of shuffled) {
                const requested = base + (remainder > 0 ? 1 : 0);
                if (remainder > 0) remainder -= 1;
                if (requested <= 0) continue;
                const available = Number(hpRemaining.get(module.id) || 0);
                const dealt = Math.min(available, requested);
                hpRemaining.set(module.id, available - dealt);
                allocations.set(module.id, (allocations.get(module.id) || 0) + dealt);
                overflow += requested - dealt;
            }
            remaining = overflow;
            pool = pool.filter(module => Number(hpRemaining.get(module.id) || 0) > 0);
        }
        return { modules, allocations, unallocated: remaining };
    }
}

class VehicleHeatSinkService {
    static pending() {
        const data = game.settings.get(FSA_MODULE_ID, "vehicleOperationsData") || foundry.utils.deepClone(FSA_DEFAULT_DATA);
        data.pendingCarryover ||= {};
        return data;
    }

    static async savePending(data) {
        await game.settings.set(FSA_MODULE_ID, "vehicleOperationsData", data);
    }

    static canOffer(actor, amount, reason, damageType) {
        if (Number(amount || 0) <= 0) return false;
        if (!(damageType === "thermal" || /shield generator|hull reinforcements?|cargo bay|fuel scoop|stealth camouflage/i.test(reason || ""))) return false;
        return Boolean(VehicleModuleService.heatSink(actor));
    }

    static async createChoice({ actor, amount, reason, attack, damageType, mode = "carryover", extra = "", sceneId = "", tokenId = "", source = "incoming damage" }) {
        const id = foundry.utils.randomID();
        const data = this.pending();
        data.pendingCarryover[id] = { actorId: actor.id, actorUuid: actor.uuid, sceneId, tokenId, amount, reason, attack, damageType, mode, source };
        await this.savePending(data);
        const prompt = mode === "cargo"
            ? `<b>${escapeHtml(actor.name)}</b> is about to lose cargo because <b>${escapeHtml(reason)}</b> failed.<br>Deploy a Heat Sink to protect the cargo hold?`
            : `<b>${escapeHtml(actor.name)}</b> is incurring <b>${Number(amount || 0)} Thermal Damage</b> from <b>${escapeHtml(reason)}</b>.<br>Would you like to use a Heat Sink to tank the excess damage and protect the craft?`;
        return `<div class="fsa-heat-sink-card">${prompt}${extra}<div class="fsa-heat-sink-actions"><button type="button" data-fsa-heat-sink data-choice-id="${id}">Deploy Heat Sink</button><button type="button" data-fsa-heat-sink-no data-choice-id="${id}">No</button></div></div>`;
    }

    static async resolve(choiceId, deploy, userId, messageId) {
        const data = this.pending();
        const pending = data.pendingCarryover?.[choiceId];
        if (!pending) throw new Error("That Heat Sink decision has already been resolved.");
        delete data.pendingCarryover[choiceId];
        await this.savePending(data);
        const { actor } = VehicleTargetResolver.resolve(pending);
        if (!actor) throw new Error("Selected vehicle not found.");
        await this.markChoice(messageId, deploy ? "Heat Sink Deployed" : "Heat Sink Spared");
        if (deploy) {
            const used = await VehicleModuleService.consumeHeatSink(actor);
            if (!used) throw new Error("No Heat Sink is available to deploy.");
            await VehicleChatCardService.create({
                content: pending.mode === "cargo"
                    ? `<b style="color:green;">Heat Sink Ejected!</b><br><b style="color:green;">Cargo Secured</b><br><span class="fsa-muted">${escapeHtml(actor.name)}: ${escapeHtml(pending.reason)}</span>`
                    : `<b style="color:green;">Heat Sink Ejected!</b><br><b style="color:green;">${Number(pending.amount || 0)} Thermal Damage Avoided</b><br><span class="fsa-muted">${escapeHtml(actor.name)}: ${escapeHtml(pending.reason)}</span>`,
                speaker: { alias: "Full Speed Ahead Combat Damage" }
            });
            return;
        }
        if (pending.mode === "cargo") {
            const removed = await VehicleCargoJettisonService.jettison(actor, pending);
            await VehicleChatCardService.create({
                content: `<div class="fsa-heat-sink-card fsa-heat-sink-danger"><b style="color:red;">Cargo Jettisoned!</b><br>${removed.length ? removed.join("<br>") : "No cargo was available to jettison."}<br><span class="fsa-muted">${escapeHtml(actor.name)}: ${escapeHtml(pending.reason)}</span></div>`,
                speaker: { alias: "Full Speed Ahead Combat Damage" }
            });
        } else {
            const result = await VehicleDamageService.applyQueuedCarryover(actor, pending);
            const label = pending.damageType === "thermal" ? "Thermal" : "Hull";
            await VehicleChatCardService.create({
                content: `<b style="color:red;">Heat Sink Spared: ${escapeHtml(actor.name)} takes ${Number(pending.amount || 0)} ${label} carryover.</b><br><b>Attack was AC: ${pending.attack || "N/A"}</b><br>${result.details.join("<br>")}${result.prompts.length ? `<br><br>${result.prompts.join("<br>")}` : ""}`,
                speaker: { alias: "Full Speed Ahead Combat Damage" }
            });
        }
    }

    static async markChoice(messageId, label) {
        const original = game.messages.get(messageId);
        if (!original?.isOwner) return;
        const content = original.content
            .replace(/<button[^>]*data-fsa-heat-sink[^>]*>Deploy Heat Sink<\/button>/g, `<button type="button" disabled>${escapeHtml(label)}</button>`)
            .replace(/<button[^>]*data-fsa-heat-sink-no[^>]*>No<\/button>/g, `<button type="button" disabled>Resolved</button>`);
        await original.update({ content });
    }
}

class VehicleCargoJettisonService {
    static cargoStats(actor) {
        const base = Number(actor?.system?.attributes?.capacity?.cargo || 0) * 2000;
        let bonus = 0;
        for (const effect of actor?.effects ?? []) {
            const label = effect.label || effect.name || effect.data?.label || "";
            if (!label.toLowerCase().includes("cargo bay")) continue;
            for (const change of effect.changes || effect.data?.changes || []) {
                if (String(change.key).includes("attributes.capacity.cargo")) bonus += parseNumber(change.value);
            }
        }
        const items = Array.from(actor?.items ?? []).filter(item => ["consumable", "loot"].includes(item.type));
        const current = items.reduce((total, item) => total + Number(item.system?.weight || 0) * Number(item.system?.quantity || 0), 0);
        const max = base + bonus;
        return { max, current, remaining: max - current };
    }

    static async jettison(actor, context = {}) {
        const cargo = Array.from(actor.items ?? []).filter(item => item.type === "loot" || item.type === "consumable");
        if (!cargo.length) return [];
        const count = Math.min(cargo.length, Math.floor(Math.random() * 4) + 1);
        const removed = [];
        const drops = [];
        for (let index = 0; index < count; index++) {
            const item = cargo.splice(Math.floor(Math.random() * cargo.length), 1)[0];
            const quantity = Number(item.system?.quantity || 1);
            const value = parseNumber(item.system?.price?.value ?? item.system?.price ?? 0) * quantity;
            removed.push(`${escapeHtml(item.name)} x${quantity}${value ? ` (${formatGp(value)})` : ""}`);
            drops.push({ item, quantity });
        }
        for (let index = 0; index < drops.length; index++) await this.createPile(actor, drops[index], context, index, drops.length);
        for (const { item } of drops) await item.delete({}, { fullSpeedAheadVehicleOperation: true });
        return removed;
    }

    static async createPile(actor, drop, context, index, total) {
        const api = game.itempiles?.API;
        if (!api?.createItemPile || !game.settings.get(FSA_MODULE_ID, "vehicleOpsItemPilesJettison")) return false;
        const scene = game.scenes.get(context.sceneId) || canvas?.scene;
        const tokenDoc = context.tokenId && scene ? scene.tokens.get(context.tokenId) : null;
        if (!scene || !tokenDoc) return false;
        const gridSize = Number(scene.grid?.size || canvas?.grid?.size || 100) || 100;
        const gridDistance = Number(scene.grid?.distance || 5) || 5;
        const radiusPx = Math.max(gridSize * 2, 350 / gridDistance * gridSize);
        const centerX = Number(tokenDoc.x || 0) + Number(tokenDoc.width || 1) * gridSize / 2;
        const centerY = Number(tokenDoc.y || 0) + Number(tokenDoc.height || 1) * gridSize / 2;
        const angle = Math.random() * Math.PI * 2 + index * 2.399963229728653;
        const spread = total <= 1 ? 0.25 : (index + 1) / (total + 1);
        const position = {
            x: Math.round(clampNumber(centerX + Math.cos(angle) * radiusPx * spread - gridSize / 2, 0, Math.max(0, Number(scene.width || 0) - gridSize))),
            y: Math.round(clampNumber(centerY + Math.sin(angle) * radiusPx * spread - gridSize / 2, 0, Math.max(0, Number(scene.height || 0) - gridSize)))
        };
        const itemData = duplicateDocumentData(drop.item);
        delete itemData._id;
        foundry.utils.setProperty(itemData, "system.quantity", Math.max(1, Number(drop.quantity || 1)));
        try {
            await api.createItemPile({ sceneId: scene.id, position, items: [{ item: itemData, quantity: Math.max(1, Number(drop.quantity || 1)) }], tokenOverrides: { name: `${drop.item.name} x${drop.quantity}`, texture: { src: drop.item.img || "icons/svg/item-bag.svg" } } });
            return true;
        } catch (error) {
            console.warn(`${FSA_MODULE_ID} | Could not create Item Piles cargo drop.`, error);
            return false;
        }
    }
}

class VehicleTokenEffectService {
    static async refresh(actor) {
        await this.clearDamage(actor);
        game.fullSpeedAheadVehicleCombat?.syncVehicleShields?.();
    }

    static async clearDamage(_actor) {
        // Built-in FSA protection visuals are synchronized by vehicle-combat.js.
    }

    static async damage(actor) {
        game.fullSpeedAheadVehicleCombat?.syncVehicleShields?.();
        if (!game.user?.isGM || !game.modules?.get("tokenmagic")?.active || !globalThis.TokenMagic || !game.settings.get(FSA_MODULE_ID, "vehicleOpsTokenMagicDamage")) return;
        const tokens = canvas?.tokens?.placeables?.filter(token => token.actor?.id === actor.id) ?? [];
        const params = [{ filterType: "splash", filterId: `fsaDamage${foundry.utils.randomID()}`, rank: 5, color: 0x808080, padding: 80, time: Math.random() * 1000, seed: Math.random(), splashFactor: 1, spread: 0.2, blend: 1, dimX: 1, dimY: 1, cut: false, textureAlphaBlend: true, anchorX: 0.32 + Math.random() * 0.36, anchorY: 0.32 + Math.random() * 0.36 }];
        for (const token of tokens) {
            try {
                if (TokenMagic.addFilters) await TokenMagic.addFilters(token, params);
                else if (TokenMagic.addUpdateFilters) await TokenMagic.addUpdateFilters(token, params);
            } catch (_error) {
                // Visual failure must not fail damage.
            }
        }
    }
}

class VehicleDamageService {
    static async apply(payload, userId) {
        const { actor } = VehicleTargetResolver.resolve(payload);
        if (!actor || actor.type !== "vehicle") throw new Error("Selected vehicle not found.");
        const context = FSA_DAMAGE_CONTEXTS.has(payload.context) ? payload.context : "attack";
        const attack = Number(payload.attack || 0);
        const damage = Math.max(0, Number(payload.damage || 0));
        const damageType = payload.damageType === "thermal" ? "thermal" : "hull";
        const modules = VehicleModuleService.damageableModules(actor);
        if (!modules.length) throw new Error(`${actor.name} has no equipped, HP-bearing vehicle modules. Damage was not applied.`);
        const state = { actor, attack, damageType, sceneId: payload.sceneId || "", tokenId: payload.tokenId || "", details: [], destroyed: [], prompts: [], tokenDamageEffect: false };

        let remaining = damage;
        if (context === "fuel") {
            const fuelScoop = VehicleModuleService.selectedOperationalModule(actor, payload.targetModule, "Fuel Scoop") || VehicleModuleService.requireOperationalModule(actor, /fuel scoop/i, "Fuel Scoop");
            remaining = await this.applyToModule(state, fuelScoop, remaining);
            if (remaining > 0) await this.applyCarryover(state, remaining, fuelScoop.name);
        } else if (context === "mining") {
            const shield = VehicleModuleService.activeShield(actor);
            const hull = VehicleModuleService.firstHealthyHull(actor);
            const selected = VehicleModuleService.selectedOperationalModule(actor, payload.targetModule, "Mining damage target");
            const target = selected || VehicleModuleService.findModule(actor, /refinery/i) || shield || hull;
            if (target) {
                remaining = await this.applyToModule(state, target, remaining);
                if (remaining > 0) await this.applyCarryover(state, remaining, target.name);
            } else {
                await this.applyCarryover(state, remaining, "asteroid debris impact");
            }
        } else {
            const shield = VehicleModuleService.activeShield(actor);
            const selected = VehicleModuleService.selectedOperationalModule(actor, payload.targetModule, "Damage target");
            const shieldFirst = shield && (!payload.targetModule || payload.targetModule === shield.id);
            if (shieldFirst) {
                const before = VehicleModuleService.itemHp(shield);
                const dealt = Math.min(before, remaining);
                await VehicleModuleService.updateModuleHp(shield, before - dealt);
                state.details.push(`${escapeHtml(shield.name)} hit for ${dealt} HP`);
                remaining -= dealt;
                if (VehicleModuleService.itemHp(shield) <= 0) state.details.push(`<b>${escapeHtml(shield.name)} is depleted! Shields are down!</b>`);
                if (remaining > 0) await this.applyCarryover(state, remaining, shield.name);
            } else if (selected) {
                remaining = await this.applyToModule(state, selected, remaining);
                if (remaining > 0) await this.applyCarryover(state, remaining, selected.name);
            } else if (payload.targetModule === "evenly") {
                await this.applyCarryover(state, remaining, "directed module damage");
            } else {
                const hull = VehicleModuleService.firstHealthyHull(actor);
                const target = hull;
                if (target) {
                    remaining = await this.applyToModule(state, target, remaining);
                    if (remaining > 0) await this.applyCarryover(state, remaining, target.name);
                } else {
                    await this.applyCarryover(state, remaining, "incoming damage");
                }
            }
        }

        const totalHp = await VehicleModuleService.syncVehicleHpFromModules(actor);
        if (state.tokenDamageEffect) await VehicleTokenEffectService.damage(actor);
        if (totalHp <= 0 && modules.length && damage > 0) state.destroyed.push(`<b style="color:red;">${escapeHtml(actor.name)} explodes into a ball of fiery force!</b>`);
        const label = context === "attack" ? "Combat" : (damageType === "thermal" ? "Thermal" : "Hull");
        await VehicleChatCardService.create({
            user: userId,
            speaker: { alias: "Full Speed Ahead Combat Damage" },
            content: `<b style="color:red;">${escapeHtml(actor.name)} suffers ${damage} ${label} Damage!</b><br><b>Attack was AC: ${attack || "N/A"}</b><br>${state.details.concat(state.destroyed.length ? ["", ...state.destroyed] : []).join("<br>")}${state.prompts.length ? `<br><br>${state.prompts.join("<br>")}` : ""}`
        });
        TradeHubIntegrationAdapter.refreshTradeHub();
    }

    static async applyToModule(state, module, amount) {
        if (!module || amount <= 0 || VehicleModuleService.itemHp(module) <= 0) return amount;
        VehicleModuleService.assertOperationalShipModule(module, "Damage target");
        const before = VehicleModuleService.itemHp(module);
        const dealt = Math.min(before, amount);
        const after = before - dealt;
        await VehicleModuleService.updateModuleHp(module, after);
        const line = after <= 0 ? `<b>${escapeHtml(module.name)} hit for ${dealt} HP and is destroyed!</b>` : `${escapeHtml(module.name)} hit for ${dealt} HP`;
        (after <= 0 ? state.destroyed : state.details).push(line);
        if (await this.handlePowerCoreShutdown(state, module, before, after)) return 0;
        if (!VehicleModuleService.isShield(module)) state.tokenDamageEffect = true;
        else if (before > 0 && after <= 0) await VehicleTokenEffectService.refresh(state.actor);
        if (before > 0 && after <= 0 && /cargo bay/i.test(module.name || "")) await this.handleCargoFailure(state, module.name, dealt);
        return amount - dealt;
    }

    static async applyCarryover(state, amount, source = "incoming damage") {
        let remaining = Math.max(0, Number(amount || 0));
        if (remaining <= 0) return;
        if (VehicleHeatSinkService.canOffer(state.actor, remaining, source, state.damageType)) {
            state.prompts.push(await VehicleHeatSinkService.createChoice({ actor: state.actor, amount: remaining, reason: source, attack: state.attack, damageType: state.damageType, sceneId: state.sceneId, tokenId: state.tokenId }));
            return;
        }
        const allocation = VehicleDamageAllocator.even(state.actor, remaining, state.attack);
        if (!allocation.allocations.size) {
            state.details.push(`<span class="fsa-muted">No vulnerable modules were hit by AC ${state.attack || "N/A"}.</span>`);
            return;
        }
        for (const module of allocation.modules) {
            const dealt = Number(allocation.allocations.get(module.id) || 0);
            if (dealt <= 0) continue;
            const before = VehicleModuleService.itemHp(module);
            const after = Math.max(0, before - dealt);
            await VehicleModuleService.updateModuleHp(module, after);
            state.tokenDamageEffect = true;
            const line = after <= 0 ? `<b>${escapeHtml(module.name)} hit for ${dealt} HP and is destroyed!</b>` : `${escapeHtml(module.name)} hit for ${dealt} HP`;
            (after <= 0 ? state.destroyed : state.details).push(line);
            if (await this.handlePowerCoreShutdown(state, module, before, after)) break;
            if (before > 0 && after <= 0 && /cargo bay/i.test(module.name || "")) await this.handleCargoFailure(state, module.name, dealt);
        }
    }

    static async handlePowerCoreShutdown(state, module, before, after) {
        if (!(before > 0 && after <= 0 && VehicleModuleService.isPowerCore(module))) return false;
        await VehicleModuleService.disableModulesForPowerCoreFailure(state.actor);
        state.destroyed.push(`<b style="color:red;">Power Core offline!</b> All ship modules are unequipped. Vessel HP remains at 1 instead of dropping to 0.`);
        state.tokenDamageEffect = true;
        state.powerCoreShutdown = true;
        return true;
    }

    static async handleCargoFailure(state, reason, amount) {
        if (VehicleHeatSinkService.canOffer(state.actor, amount, reason, state.damageType)) {
            state.prompts.push(await VehicleHeatSinkService.createChoice({ actor: state.actor, amount, reason, attack: state.attack, damageType: state.damageType, mode: "cargo", extra: `<br>Status: Cargo hold failure imminent.`, sceneId: state.sceneId, tokenId: state.tokenId }));
        } else {
            const removed = await VehicleCargoJettisonService.jettison(state.actor, state);
            if (removed.length) state.details.push(`<div class="fsa-heat-sink-card fsa-heat-sink-danger"><b style="color:red;">Cargo Jettisoned!</b><br>${removed.join("<br>")}</div>`);
        }
    }

    static async applyQueuedCarryover(actor, payload) {
        const state = { actor, attack: Number(payload.attack || 0), damageType: payload.damageType || "thermal", sceneId: payload.sceneId || "", tokenId: payload.tokenId || "", details: [], destroyed: [], prompts: [], tokenDamageEffect: false };
        await this.applyCarryover(state, payload.amount, payload.reason || payload.source);
        const totalHp = await VehicleModuleService.syncVehicleHpFromModules(actor);
        if (state.tokenDamageEffect) await VehicleTokenEffectService.damage(actor);
        return { details: state.details.concat(state.destroyed.length ? ["", ...state.destroyed] : []), prompts: state.prompts, totalHp };
    }
}

class VehicleRepairService {
    static preview(actor) {
        const repairs = VehicleModuleService.repairableModules(actor).map(item => {
            const missing = Math.max(0, VehicleModuleService.itemMaxHp(item) - VehicleModuleService.itemHp(item));
            const rawCost = missing * this.unitCost(item);
            return { item, missing, rawCost, cost: this.costForItem(actor, item, missing) };
        }).filter(entry => entry.missing > 0);
        return { repairs, rawTotal: repairs.reduce((sum, entry) => sum + entry.rawCost, 0), total: repairs.reduce((sum, entry) => sum + entry.cost, 0), insured: TradeHubIntegrationAdapter.isGlaxonInsured(actor) };
    }

    static unitCost(item) {
        return VehicleModuleService.isShield(item) ? TradeHubIntegrationAdapter.repairCostPerShieldPoint() : TradeHubIntegrationAdapter.repairCostPerHp();
    }

    static costForItem(actor, item, missing) {
        const raw = Math.max(0, Number(missing || 0)) * this.unitCost(item);
        return TradeHubIntegrationAdapter.isGlaxonInsured(actor) ? Math.floor(raw * 0.5) : raw;
    }

    static async repair(payload, userId) {
        const { actor } = VehicleTargetResolver.resolve(payload);
        if (!actor || actor.type !== "vehicle") throw new Error("Selected vehicle not found.");
        const action = FSA_REPAIR_ACTIONS.has(payload.action) ? payload.action : "repair-module";
        if (action === "pristine") {
            if (!game.users.get(userId)?.isGM) throw new Error("Make Pristine is a GM-only vehicle maintenance action.");
            await VehicleModuleService.syncVehicleStatsFromModules(actor, { restore: true, chat: true, reason: "GM maintenance action. No billing applied.", userId });
        } else if (action === "full-service") {
            await this.fullService(actor, { billCapital: payload.billCapital !== false, userId });
        } else if (action === "stabilize-module") {
            await this.stabilize(actor, payload.targetModule, userId);
        } else {
            await this.repairModule(actor, payload.targetModule, payload.hp, userId);
        }
        TradeHubIntegrationAdapter.refreshTradeHub();
    }

    static async fullService(actor, { billCapital = true, userId } = {}) {
        const preview = this.preview(actor);
        if (!preview.repairs.length) throw new Error(`${actor.name} has no damaged modules to repair.`);
        if (billCapital) {
            if (!TradeHubIntegrationAdapter.capitalAvailable()) throw new Error("TradeHub billing is unavailable. Disable billing to perform the repair for free.");
            if (TradeHubIntegrationAdapter.capital() < preview.total) throw new Error(`Not enough TradeHub Capital for full service repair. Required: ${formatGp(preview.total)}; Available: ${formatGp(TradeHubIntegrationAdapter.capital())}.`);
            await TradeHubIntegrationAdapter.setCapital(TradeHubIntegrationAdapter.capital() - preview.total);
        }
        for (const entry of preview.repairs) await VehicleModuleService.restoreModuleHp(entry.item, VehicleModuleService.itemMaxHp(entry.item));
        const summary = await VehicleModuleService.syncVehicleStatsFromModules(actor, { restore: false, reason: "Full Service Repair and Replace" });
        await VehicleTokenEffectService.refresh(actor);
        const rows = preview.repairs.sort((a, b) => b.cost - a.cost).map(entry => `${escapeHtml(entry.item.name)}: ${entry.missing} HP restored (${billCapital ? formatGp(entry.cost) : `${formatGp(entry.cost)} waived`}${preview.insured ? `, Glaxon value ${formatGp(entry.rawCost)}` : ""})`);
        await VehicleChatCardService.create({
            user: userId,
            speaker: { alias: "Full Speed Ahead Vehicle Repair" },
            content: `<b>Full Service Repair and Replace: ${escapeHtml(actor.name)}</b><br>${rows.join("<br>")}<br><br><b>Full Repair Value:</b> ${formatGp(preview.rawTotal)}<br><b>Total Repair Cost:</b> ${formatGp(preview.total)}<br><b>TradeHub Capital Billed:</b> ${billCapital ? formatGp(preview.total) : "No, repair waived"}<br><b>Vehicle HP:</b> ${summary.currentHp}<br><b>TradeHub Capital:</b> ${TradeHubIntegrationAdapter.capitalAvailable() ? formatGp(TradeHubIntegrationAdapter.capital()) : "Unavailable"}`
        });
    }

    static async repairModule(actor, targetModule, hpToAdd, userId) {
        let remaining = Math.max(0, Number(hpToAdd || 0));
        const repaired = new Map();
        const addDetail = (item, hp) => {
            const current = repaired.get(item.id) || { name: item.name, hp: 0 };
            current.hp += hp;
            repaired.set(item.id, current);
        };
        if (remaining > 0 && targetModule && targetModule !== "evenly") {
            const item = actor.items.get(targetModule);
            if (item) {
                if (!VehicleModuleService.isEquippedShipModule(item)) throw new Error(`${item.name} is destroyed or unequipped. Stabilize the module before repairing it.`);
                const add = Math.min(remaining, Math.max(0, VehicleModuleService.itemMaxHp(item) - VehicleModuleService.itemHp(item)));
                if (add > 0) {
                    await VehicleModuleService.repairEquippedModuleHp(item, VehicleModuleService.itemHp(item) + add);
                    addDetail(item, add);
                    remaining -= add;
                }
            }
        } else {
            let pool = VehicleModuleService.damageableModules(actor).filter(item => !VehicleModuleService.isShield(item) && VehicleModuleService.itemHp(item) > 0 && VehicleModuleService.itemHp(item) < VehicleModuleService.itemMaxHp(item));
            while (remaining > 0 && pool.length) {
                for (const item of [...pool]) {
                    if (remaining <= 0) break;
                    const add = Math.min(1, VehicleModuleService.itemMaxHp(item) - VehicleModuleService.itemHp(item));
                    if (add > 0) {
                        await VehicleModuleService.repairEquippedModuleHp(item, VehicleModuleService.itemHp(item) + add);
                        addDetail(item, add);
                        remaining -= add;
                    }
                }
                pool = pool.filter(item => VehicleModuleService.itemHp(item) < VehicleModuleService.itemMaxHp(item));
            }
        }
        const details = [...repaired.values()].sort((a, b) => b.hp - a.hp || a.name.localeCompare(b.name)).map(entry => `${escapeHtml(entry.name)}: ${entry.hp} HP repaired`);
        if (!details.length) {
            await VehicleChatCardService.create({ user: userId, speaker: { alias: "Full Speed Ahead Vehicle Repair" }, content: `<b style="color:green;">ERROR: HP FULL</b><br><b>${escapeHtml(actor.name)} has no repairable module damage for that selection.</b>` });
            return;
        }
        const totalHp = await VehicleModuleService.syncVehicleHpFromModules(actor);
        await VehicleTokenEffectService.refresh(actor);
        await VehicleChatCardService.create({ user: userId, speaker: { alias: "Full Speed Ahead Vehicle Repair" }, content: `<b style="color:green;">SUCCESS: MODULES REPAIRED!</b><br><b>${escapeHtml(actor.name)}</b><br><b>Modules Repaired:</b><br>${details.join("<br>")}<br><b>Total HP Restored:</b> ${[...repaired.values()].reduce((s, e) => s + e.hp, 0)}<br><b>Vehicle HP:</b> ${totalHp}` });
    }

    static async stabilize(actor, targetModule, userId) {
        const item = targetModule && targetModule !== "evenly"
            ? actor.items.get(targetModule)
            : VehicleModuleService.repairableModules(actor).find(module => VehicleModuleService.wasDestroyed(module) || !VehicleModuleService.isEquippedShipModule(module) || VehicleModuleService.itemHp(module) <= 0);
        if (!item) throw new Error("Choose a destroyed module to stabilize.");
        if (!VehicleModuleService.isShipModuleItem(item)) throw new Error(`${item.name} is not a vehicle module.`);
        if (VehicleModuleService.isEquippedShipModule(item) && VehicleModuleService.itemHp(item) > 0) throw new Error(`${item.name} is already stabilized.`);
        await VehicleModuleService.stabilizeModule(item);
        const totalHp = await VehicleModuleService.syncVehicleHpFromModules(actor);
        await VehicleTokenEffectService.refresh(actor);
        await VehicleChatCardService.create({
            user: userId,
            speaker: { alias: "Full Speed Ahead Vehicle Repair" },
            content: `<b style="color:green;">SUCCESS: MODULE STABILIZED!</b><br><b>${escapeHtml(actor.name)}</b><br>${escapeHtml(item.name)} is equipped and restored to 1 HP.<br><b>Vehicle HP:</b> ${totalHp}`
        });
    }
}

class VehicleScanService {
    static async scan(payload, userId) {
        if (!game.settings.get(FSA_MODULE_ID, "vehicleOpsScansEnabled")) throw new Error("Vehicle scans are disabled.");
        const { actor } = VehicleTargetResolver.resolve(payload);
        if (!actor || actor.type !== "vehicle") throw new Error("Selected vehicle not found.");
        VehicleModuleService.requireOperationalModule(actor, /scanner suite/i, "Scanner Suite");
        const scanType = ["tactical", "manifest", "wake"].includes(payload.scanType) ? payload.scanType : "tactical";
        const content = scanType === "manifest" ? this.manifest(actor) : scanType === "wake" ? this.wake(actor, payload.destination) : this.tactical(actor);
        await VehicleChatCardService.create({ user: userId, speaker: { alias: "Full Speed Ahead Ship Scanner" }, content });
    }

    static tactical(actor) {
        const visibleItems = Array.from(actor.items ?? []).filter(item => !/^secret compartment:/i.test(item.name || ""));
        const modules = visibleItems.filter(item => ["equipment", "weapon"].includes(item.type));
        const shieldHp = modules.filter(item => /shield/i.test(item.name || "")).reduce((total, item) => total + Math.max(0, VehicleModuleService.itemHp(item)), 0);
        const weapons = modules.filter(item => item.type === "weapon");
        const shortRanges = weapons.map(item => parseNumber(item.system?.range?.value || 0));
        const longRanges = weapons.map(item => parseNumber(item.system?.range?.long || 0));
        const moduleList = modules.length ? modules.map(item => {
            const maxHp = Math.max(0, VehicleModuleService.itemMaxHp(item));
            const currentHp = Math.max(0, VehicleModuleService.itemHp(item));
            const condition = maxHp > 0 ? Math.max(0, Math.min(100, Math.round(currentHp / maxHp * 100))) : 0;
            const line = `${condition}% - ${escapeHtml(item.name)}`;
            return currentHp <= 0 ? `<b>${line} (Offline)</b>` : line;
        }).join("<br>") : "None";
        return `<div class="fsa-chat-card"><b class="fsa-green">Tactical Scan SUCCESS!</b><br><b>Target Loadout: ${escapeHtml(actor.name)}</b><br>Current Health: ${Number(actor.system?.attributes?.hp?.value || 0)} HP<br>Current Shields: ${shieldHp} HP<br>Max Jump Distance: ${escapeHtml(this.hyperdriveRange(actor))}<br>Min Weapon Range: ${shortRanges.length ? `${Math.min(...shortRanges).toLocaleString()} Meters` : "0"}<br>Max Weapon Range: ${longRanges.length ? `${Math.max(...longRanges).toLocaleString()} Meters` : "0"}<br><br><b>Modules:</b><br>${moduleList}</div>`;
    }

    static manifest(actor) {
        const visibleItems = Array.from(actor.items ?? []).filter(item => !/^secret compartment:/i.test(item.name || ""));
        const cargoItems = visibleItems.filter(item => ["loot", "consumable"].includes(item.type));
        const namesFrom = collection => {
            const entries = Array.isArray(collection) ? collection : Object.values(collection || {});
            return entries.map(entry => typeof entry === "string" ? entry : entry?.name).filter(Boolean);
        };
        const crew = namesFrom(actor.system?.cargo?.crew);
        const passengers = namesFrom(actor.system?.cargo?.passengers);
        const illegal = cargoItems.some(item => /\billegal\b/i.test(item.name || ""));
        const cargoList = cargoItems.length ? cargoItems.map(item => {
            const quantity = Math.max(0, Number(item.system?.quantity ?? 1));
            const totalPrice = quantity * parseNumber(item.system?.price?.value ?? item.system?.price ?? 0);
            const line = `${escapeHtml(item.name)} x${quantity} (worth ${formatGp(totalPrice)})`;
            return /\billegal\b/i.test(item.name || "") ? `<span class="fsa-illegal">${line}</span>` : line;
        }).join("<br>") : "None";
        const totalCargoPrice = cargoItems.reduce((sum, item) => sum + Math.max(0, Number(item.system?.quantity ?? 1)) * parseNumber(item.system?.price?.value ?? item.system?.price ?? 0), 0);
        return `<div class="fsa-chat-card"><b class="fsa-green">Manifest Scan SUCCESS!</b>${illegal ? `<br><b class="fsa-illegal">WARNING: ILLEGAL CARGO</b>` : ""}<br><b>${escapeHtml(actor.name)} Crew:</b><br>${crew.length ? crew.map(escapeHtml).join("<br>") : "None"}<br><br><b>Passengers:</b><br>${passengers.length ? passengers.map(escapeHtml).join("<br>") : "None"}<br><br><b>Cargo:</b><br>${cargoList}<br><br><b>Total Cargo Worth:</b> ${formatGp(totalCargoPrice)}</div>`;
    }

    static wake(actor, destination) {
        const destinations = TradeHubIntegrationAdapter.locations();
        const selected = String(destination || "").trim();
        if (!selected || !destinations.includes(selected)) throw new Error("Select a valid Wake Scanner destination.");
        return `<div class="fsa-chat-card"><b class="fsa-green">Wake Scan SUCCESS!</b><br><b>Target ${escapeHtml(actor.name)} jumped to the ${escapeHtml(selected)} system.</b></div>`;
    }

    static hyperdriveRange(actor) {
        const hyperdrive = VehicleModuleService.damageableModules(actor).find(item => /hyperdrive/i.test(item.name || ""));
        if (!hyperdrive) return "No HyperDrive module found";
        return this.parseHyperdriveFormula(hyperdrive) || this.hyperdriveFallbackFormula(hyperdrive);
    }

    static parseHyperdriveFormula(item) {
        const customCandidates = [item.system?.source?.custom, item.system?.details?.source?.custom];
        for (const text of customCandidates) {
            const plain = stripHtml(text);
            const match = plain.match(/^\s*(\d+d\d+(?:\s*[+-]\s*\d+)?)\s*(?:LY|light\s*years?)?\s*$/i);
            if (match) return `${normalizeDiceFormula(match[1])} LY`;
        }
        const candidates = [item.system?.formula, item.system?.description?.value, item.system?.description?.chat, item.system?.description?.unidentified, ...stringsFromValue(item.system)];
        for (const text of candidates) {
            const plain = stripHtml(text);
            const match = plain.match(/(\d+d\d+(?:\s*[+-]\s*\d+)?)\s*(?:LY|light\s*years?)/i);
            if (match) return `${normalizeDiceFormula(match[1])} LY`;
        }
        return "";
    }

    static hyperdriveFallbackFormula(item) {
        const name = item?.name || "";
        if (/\[S\]/i.test(name)) return "6d4 + 14 LY";
        if (/\[A\]/i.test(name)) return "4d4 + 12 LY";
        if (/\[B\]/i.test(name)) return "3d4 + 10 LY";
        if (/\[C\]/i.test(name)) return "2d4 + 4 LY";
        if (/\[D\]/i.test(name)) return "1d4 + 6 LY";
        return item ? "Unknown HyperDrive" : "No HyperDrive module found";
    }
}

class VehicleFuelService {
    static async grant(payload, userId) {
        const { actor } = VehicleTargetResolver.resolve(payload);
        if (!actor || actor.type !== "vehicle") throw new Error("Selected vehicle not found.");
        VehicleModuleService.requireOperationalModule(actor, /fuel scoop/i, "Fuel Scoop");
        const amount = Math.floor(Math.max(0, Number(payload.quantity || 0)));
        if (!amount) throw new Error("Enter the Hydrogen Fuel amount scooped.");
        const hydrogen = await TradeHubIntegrationAdapter.hydrogenFuelData();
        if (!hydrogen) throw new Error("Hydrogen Fuel source is unavailable. Configure TradeHub trade goods or create a Hydrogen Fuel world item.");
        const addedWeight = amount * Number(foundry.utils.getProperty(hydrogen, "system.weight") || 0);
        const stats = VehicleCargoJettisonService.cargoStats(actor);
        if (stats.current + addedWeight > stats.max) throw new Error("Insufficient cargo capacity for the scooped Hydrogen Fuel.");
        const existing = Array.from(actor.items ?? []).find(item => item.name.toLowerCase() === "hydrogen fuel" && ["loot", "consumable"].includes(item.type));
        if (existing) await existing.update({ "system.quantity": Number(existing.system?.quantity || 0) + amount }, { fullSpeedAheadVehicleOperation: true });
        else {
            delete hydrogen._id;
            foundry.utils.setProperty(hydrogen, "system.quantity", amount);
            await actor.createEmbeddedDocuments("Item", [hydrogen], { fullSpeedAheadVehicleOperation: true });
        }
        await VehicleChatCardService.create({ user: userId, content: `<strong>Fuel Scooping Complete</strong><br><strong>${escapeHtml(actor.name)}</strong> gained Hydrogen Fuel x${amount}.` });
    }
}

class VehicleSheetToolService {
    static actorPayload(actor) {
        return { actorId: actor?.id || "", actorUuid: actor?.uuid || "" };
    }

    static showLoadout(actor) {
        if (!actor || actor.type !== "vehicle") return ui.notifications.error("Selected vehicle not found.");
        VehicleOperationsSocketService.request("postVehicleLoadout", this.actorPayload(actor));
    }

    static confirmLongRest(actor) {
        if (!actor || actor.type !== "vehicle") return ui.notifications.error("Selected vehicle not found.");
        const value = VehicleModuleService.shipValue(actor);
        const upkeep = VehicleModuleService.upkeepCost(actor);
        const insured = TradeHubIntegrationAdapter.isGlaxonInsured(actor);
        const premium = insured ? VehicleModuleService.glaxonPremium(actor) : 0;
        const total = upkeep + premium;
        confirmUniqueFsaDialog(fsaVehiclePromptKey(actor, "long-rest"), {
            title: "Long Rest Confirmation",
            content: `<div class="fsa-chat-card fsa-center">
                <p>When your vehicle takes a Long Rest, shields recharge and crew/item uses are restored.</p>
                <p>Equipment condition will not change unless repaired. Destroyed modules remain offline.</p>
                <p><strong>Ship Value:</strong> ${formatGp(value)}<br><strong>Upkeep:</strong> ${formatGp(upkeep)}<br><strong>Glaxon Premium:</strong> ${insured ? formatGp(premium) : "Not insured"}<br><strong>Total Due:</strong> ${formatGp(total)}</p>
            </div>`,
            yes: () => VehicleOperationsSocketService.request("shipLongRest", this.actorPayload(actor)),
            defaultYes: false
        });
    }

    static showRegistration(actor) {
        if (!actor || actor.type !== "vehicle") return ui.notifications.error("Selected vehicle not found.");
        const cost = VehicleModuleService.registrationCost(actor);
        const insured = TradeHubIntegrationAdapter.isGlaxonInsured(actor);
        const premium = VehicleModuleService.glaxonPremium(actor);
        const premiumPercent = TradeHubIntegrationAdapter.glaxonInsurancePremiumPercent();
        const codeRequired = TradeHubIntegrationAdapter.insuranceConfirmationRequired();
        const companyName = TradeHubIntegrationAdapter.insuranceCompanyName();
        const fullValue = VehicleModuleService.fullRepairValue(actor);
        renderUniqueFsaDialog(fsaVehiclePromptKey(actor, "registration"), {
            title: "Ship Registration",
            content: `<div class="fsa-chat-card">
                <p>At any point, you can reregister your ship's designation. If any listed crew member is <strong>[Wanted]</strong>, the cost is doubled.</p>
                <label><strong>Enter Vehicle Name:</strong></label>
                <input type="text" id="fsa-vessel-name" value="${escapeHtml(actor.name)}">
                <p><strong>Cost:</strong> ${formatGp(cost)}</p>
                <hr>
                <p><strong>${escapeHtml(companyName)}:</strong> ${insured ? `<span class="fsa-green">Active</span>` : "Not insured"}<br>
                Insure my vehicle at a base premium of ${Number(premiumPercent).toLocaleString()}% total repair value per long rest.<br>
                <strong>Benefit:</strong> 50% off eligible repair costs while insured.<br>
                <strong>Full Repair Value:</strong> ${formatGp(fullValue)}<br>
                <strong>Premium per Long Rest:</strong> ${formatGp(premium)}</p>
                ${codeRequired && !insured ? `<p class="notes">A confirmation code is required when you click Insure My Vehicle.</p>` : ""}
            </div>`,
            buttons: {
                pay: {
                    label: "Change Ship Name",
                    callback: html => {
                        const name = String(html.find("#fsa-vessel-name").val() || "").trim();
                        if (!name) return ui.notifications.error("You must enter a valid vessel name.");
                        VehicleOperationsSocketService.request("shipRegister", { ...this.actorPayload(actor), name });
                    }
                },
                insure: {
                    label: insured ? "Cancel Coverage" : "Insure My Vehicle",
                    callback: () => {
                        if (!insured && TradeHubIntegrationAdapter.insuranceConfirmationRequired()) return this.promptInsuranceCode(actor);
                        VehicleOperationsSocketService.request("shipInsurance", { ...this.actorPayload(actor), insured: !insured, code: "" });
                    }
                },
                cancel: { label: "Cancel" }
            }
        }, { width: 460 });
    }

    static promptInsuranceCode(actor) {
        const companyName = TradeHubIntegrationAdapter.insuranceCompanyName();
        renderUniqueFsaDialog(fsaVehiclePromptKey(actor, "insurance-code"), {
            title: `${companyName} Confirmation`,
            content: `<div class="fsa-chat-card">
                <p>Please find a ${escapeHtml(companyName)} Rep to obtain a confirmation code.</p>
                <label><strong>Confirmation Code:</strong></label>
                <input type="password" id="fsa-insurance-code" autocomplete="off">
            </div>`,
            buttons: {
                confirm: {
                    label: "Activate Coverage",
                    callback: html => {
                        const code = String(html.find("#fsa-insurance-code").val() || "");
                        VehicleOperationsSocketService.request("shipInsurance", { ...this.actorPayload(actor), insured: true, code });
                    }
                },
                cancel: { label: "Cancel" }
            },
            default: "confirm"
        }, { width: 420 });
    }

    static showFuelRelease(actor) {
        if (!actor || actor.type !== "vehicle") return ui.notifications.error("Selected vehicle not found.");
        renderUniqueFsaDialog(fsaVehiclePromptKey(actor, "fuel-release"), {
            title: "Emergency Hydrogen Fuel Release",
            content: `<div class="fsa-chat-card">
                <label>Hydrogen (tonnes):</label>
                <input type="number" id="fsa-fuel-tonnes" value="1" min="0">
                <p>1 tonne of Hydrogen fuel covers 1 hyperdrive jump, or 1 LY and 1 day of supercruise travel.</p>
            </div>`,
            buttons: {
                warning: {
                    label: "<strong>Purge Hydrogen</strong>",
                    callback: async html => {
                        const quantity = Number(html.find("#fsa-fuel-tonnes").val() || 0);
                        if (quantity < 0) return ui.notifications.error("Invalid value.");
                        const confirmed = await confirmUniqueFsaDialog(fsaVehiclePromptKey(actor, "fuel-hazard"), {
                            title: "WARNING: HAZARDOUS OPERATION",
                            content: `<div style="color:red;font-weight:bold;">WARNING: DO NOT release hydrogen near heat or open flame. Contents under pressure.</div><p>Are you sure you want to proceed?</p>`,
                            yes: () => true,
                            defaultYes: false
                        });
                        if (confirmed) VehicleOperationsSocketService.request("shipFuelPurge", { ...this.actorPayload(actor), quantity });
                    }
                },
                cancel: { label: "Cancel" }
            }
        }, { width: 460 });
    }

    static sheetHtml() {
        return `<div class="full-speed-ahead-sheet-tools">
            <button type="button" data-fsa-sheet-tool="rest"><i class="fas fa-bed"></i> Long Rest</button>
            <button type="button" data-fsa-sheet-tool="registration"><i class="fas fa-registered"></i> Registration</button>
            <button type="button" data-fsa-sheet-tool="loadout"><i class="fas fa-print"></i> Chat Loadout</button>
            <button type="button" data-fsa-sheet-tool="fuel"><i class="fas fa-fire"></i> Fuel Release</button>
        </div>`;
    }
}

class VehicleSheetToolTransactions {
    static resolveActor(payload = {}) {
        const actor = (payload.actorUuid ? fromUuidSyncSafe(payload.actorUuid) : null) || game.actors.get(payload.actorId);
        if (!actor || actor.type !== "vehicle") throw new Error("Selected vehicle not found.");
        return actor;
    }

    static assertUserCanUse(actor, userId) {
        const user = game.users.get(userId);
        if (user?.isGM) return;
        if (!vehicleOperationsHasOwnerPermission(actor, user)) throw new Error("You must own this vehicle to use Full Speed Ahead vehicle sheet tools.");
    }

    static async postLoadout(payload, userId) {
        const actor = this.resolveActor(payload);
        this.assertUserCanUse(actor, userId);
        await VehicleChatCardService.create({ user: userId, speaker: { alias: "Full Speed Ahead Loadout" }, content: this.loadoutContent(actor) });
    }

    static loadoutContent(actor) {
        const stats = VehicleCargoJettisonService.cargoStats(actor);
        const cargoItems = Array.from(actor.items ?? []).filter(item => ["loot", "consumable"].includes(item.type) && Number(item.system?.quantity || 0) > 0);
        const modules = VehicleModuleService.damageableModules(actor);
        const cargoValue = cargoItems.reduce((total, item) => total + parseNumber(item.system?.price?.value ?? item.system?.price ?? 0) * Number(item.system?.quantity || 0), 0);
        const shieldHp = modules.filter(module => VehicleModuleService.isShield(module)).reduce((total, module) => total + Number(module.system?.hp?.value || 0), 0);
        const fuel = VehicleModuleService.hydrogenFuel(actor);
        const insured = TradeHubIntegrationAdapter.isGlaxonInsured(actor);
        const moduleList = modules.length ? modules.map(module => `<li>${escapeHtml(module.name)}</li>`).join("") : "<li>None</li>";
        return `<div class="fsa-chat-card">
            <strong>${escapeHtml(actor.name)}</strong><br>
            Current HP: ${Number(actor.system?.attributes?.hp?.value || 0)} HP<br>
            Current Shield HP: ${shieldHp} HP<br>
            Maximum Jump Distance: ${escapeHtml(VehicleScanService.hyperdriveRange(actor))}<br>
            Ship Value: ${formatGp(VehicleModuleService.shipValue(actor))}<br>
            Glaxon Insurance: ${insured ? `Active (${formatGp(VehicleModuleService.glaxonPremium(actor))} / Long Rest)` : "Not insured"}<br>
            AC: ${Number(actor.system?.attributes?.ac?.value || 0)}<br><br>
            <strong>Equipped Modules:</strong><ul>${moduleList}</ul>
            <strong>Cargo:</strong><br>
            Cargo Capacity: ${Math.floor(stats.max).toLocaleString()} lbs<br>
            Current Cargo Weight: ${Math.floor(stats.current).toLocaleString()} lbs<br>
            Total Cargo Value: ${formatGp(cargoValue)}<br>
            Hydrogen Fuel Quantity: ${Number(fuel?.system?.quantity || 0)} tonnes<br>
            ${stats.remaining >= 0 ? `<span class="fsa-green">${Math.floor(stats.remaining).toLocaleString()} lbs of cargo space remaining.</span>` : `<span class="fsa-illegal">WARNING: OVERWEIGHT<br>Hyperdrive Disabled</span>`}
        </div>`;
    }

    static async longRest(payload, userId) {
        const actor = this.resolveActor(payload);
        this.assertUserCanUse(actor, userId);
        const value = VehicleModuleService.shipValue(actor);
        const upkeep = VehicleModuleService.upkeepCost(actor);
        const insured = TradeHubIntegrationAdapter.isGlaxonInsured(actor);
        const premium = insured ? VehicleModuleService.glaxonPremium(actor) : 0;
        const totalCost = upkeep + premium;
        const billing = await TradeHubIntegrationAdapter.bill(totalCost);

        for (const item of actor.items ?? []) {
            const uses = item.system?.uses;
            if (uses?.max) await item.update({ "system.uses.value": uses.max }, { fullSpeedAheadVehicleOperation: true });
            if (VehicleModuleService.isEquippedShipModule(item) && VehicleModuleService.isShield(item)) {
                await item.update({ "system.hp.value": Number(item.system?.hp?.max || item.system?.hp?.value || 0) }, { fullSpeedAheadVehicleOperation: true });
            }
        }

        const modules = VehicleModuleService.damageableModules(actor).filter(item => !VehicleModuleService.isShield(item));
        const totalModuleHp = modules.reduce((total, item) => total + Number(item.system?.hp?.value || 0), 0);
        await actor.update({ "system.attributes.hp.min": totalModuleHp }, { fullSpeedAheadVehicleOperation: true });
        await VehicleTokenEffectService.refresh(actor);

        if (billing.unpaid > 0) {
            await ChatMessage.create({
                content: `Long rest costs of ${formatGp(billing.unpaid)} were not fully paid. During the next adventuring day, equipment or insurance service may fail unexpectedly at the GM's discretion.`,
                whisper: ChatMessage.getWhisperRecipients("GM")
            });
        }

        await VehicleChatCardService.create({
            user: userId,
            speaker: { alias: "Full Speed Ahead Ship Maintenance" },
            content: `<strong style="color:green;">SHIP MAINTENANCE</strong><br>
                Each long rest, the ship handles air filtration, water purification, waste management, sanitation, upkeep, laundry, and diagnostics.<br><br>
                <strong>Ship Name:</strong> ${escapeHtml(actor.name)}<br>
                <strong>Ship Value:</strong> ${formatGp(value)}<br>
                <strong>Upkeep Cost:</strong> ${formatGp(upkeep)}<br>
                ${insured ? `<strong>Glaxon Premium:</strong> ${formatGp(premium)}<br><strong>Total Long Rest Cost:</strong> ${formatGp(totalCost)}<br>` : ""}
                <strong>TradeHub Capital:</strong> ${TradeHubIntegrationAdapter.capitalAvailable() ? formatGp(TradeHubIntegrationAdapter.capital()) : "Unavailable"}<br>
                <em>Shields and item uses restored. Equipment condition was not repaired. Vessel HP minimum now reflects equipment condition.</em>`
        });
        refreshVehicleOperationInterfaces(actor);
    }

    static async register(payload, userId) {
        const actor = this.resolveActor(payload);
        this.assertUserCanUse(actor, userId);
        const name = String(payload.name || "").trim();
        if (!name) throw new Error("You must enter a valid vessel name.");
        const cost = VehicleModuleService.registrationCost(actor);
        const oldName = actor.name;
        const startingCapital = TradeHubIntegrationAdapter.capital();
        await TradeHubIntegrationAdapter.requireAndBill(cost);
        try {
            await actor.update({ name }, { fullSpeedAheadVehicleOperation: true });
        } catch (error) {
            await TradeHubIntegrationAdapter.setCapital(startingCapital).catch(restoreError => {
                console.error(`${FSA_MODULE_ID} | Failed to restore TradeHub Capital after registration failed.`, restoreError);
            });
            throw error;
        }
        await VehicleChatCardService.create({
            user: userId,
            content: `<strong>${escapeHtml(game.users.get(userId)?.name || "A player")}</strong> updated the registration for <strong>${escapeHtml(oldName)}</strong>.<br>New designation: <strong>${escapeHtml(name)}</strong><br><strong>Cost:</strong> ${formatGp(cost)}<br><strong>TradeHub Capital:</strong> ${formatGp(TradeHubIntegrationAdapter.capital())}`
        });
        refreshVehicleOperationInterfaces(actor);
    }

    static async insurance(payload, userId) {
        const actor = this.resolveActor(payload);
        this.assertUserCanUse(actor, userId);
        const active = payload.insured !== false;
        if (active) TradeHubIntegrationAdapter.validateInsuranceConfirmationCode(payload.code);
        await TradeHubIntegrationAdapter.setGlaxonInsured(actor, active);
        const companyName = TradeHubIntegrationAdapter.insuranceCompanyName();
        await VehicleChatCardService.create({
            user: userId,
            speaker: { alias: companyName },
            content: active
                ? `<strong>${escapeHtml(companyName)} Activated</strong><br><strong>${escapeHtml(actor.name)}</strong> now receives 50% off repair costs while insured.<br><strong>Premium per Long Rest:</strong> ${formatGp(VehicleModuleService.glaxonPremium(actor))}<br><strong>Full Repair Value:</strong> ${formatGp(VehicleModuleService.fullRepairValue(actor))}<br><em>Premiums are billed when the Long Rest button is used.</em>`
                : `<strong>${escapeHtml(companyName)} Cancelled</strong><br><strong>${escapeHtml(actor.name)}</strong> no longer receives the insurance repair discount and will not be billed an insurance premium on Long Rest.`
        });
        refreshVehicleOperationInterfaces(actor);
    }

    static async fuelPurge(payload, userId) {
        const actor = this.resolveActor(payload);
        this.assertUserCanUse(actor, userId);
        const item = VehicleModuleService.hydrogenFuel(actor);
        if (!item) throw new Error("Hydrogen Fuel item not found.");
        const amount = Math.max(0, Number(payload.quantity || 0));
        const available = Number(item.system?.quantity || 0);
        const purged = Math.min(available, amount);
        const remaining = Math.max(0, available - purged);
        await item.update({ "system.quantity": remaining }, { fullSpeedAheadVehicleOperation: true });
        await VehicleChatCardService.create({
            user: userId,
            content: `<strong>${escapeHtml(actor.name)}</strong><br>${purged} tonnes of Hydrogen purged.<br><em>1 tonne of Hydrogen fuel covers 1 hyperdrive jump, or 1 LY and 1 day of supercruise travel.</em>${remaining <= 0 ? `<br><span style="color:red;font-weight:bold;">WARNING: OUT OF FUEL</span>` : ""}`
        });
        refreshVehicleOperationInterfaces(actor);
    }
}

class VehicleChatCardService {
    static async create(data) {
        return ChatMessage.create({ user: game.user.id, ...data });
    }
}

class VehicleOperationsSocketService {
    static init() {
        game.socket.on(FSA_SOCKET, message => this.handle(message));
    }

    static request(action, payload = {}) {
        if (game.user.isGM) return this.process({ action, payload, userId: game.user.id });
        game.socket.emit(FSA_SOCKET, { type: "vehicleOperationsRequest", action, payload, userId: game.user.id });
        ui.notifications.info("Full Speed Ahead request sent to the GM client.");
    }

    static async handle(message) {
        if (message?.type === "vehicleOperationsRefresh") return refreshVehicleOperationInterfaces(null, { broadcast: false });
        if (message?.type === "sharedCapitalRefresh") return refreshSharedCapitalInterfaces({ broadcast: false });
        if (message?.type === "vehicleOperationsResponse" && message.userId === game.user.id) {
            if (message.ok) ui.notifications.info(message.message || "Full Speed Ahead request complete.");
            else ui.notifications.error(message.message || "Full Speed Ahead request failed.");
            return;
        }
        if (message?.type !== "vehicleOperationsRequest" || !game.user.isGM) return;
        await this.process(message);
    }

    static async process(message) {
        try {
            if (!game.settings.get(FSA_MODULE_ID, "vehicleOpsEnabled")) throw new Error("Full Speed Ahead vehicle operations are disabled.");
            let result;
            if (message.action === "applyVehicleDamage") result = await VehicleDamageService.apply(message.payload, message.userId);
            else if (message.action === "performVehicleScan") result = await VehicleScanService.scan(message.payload, message.userId);
            else if (message.action === "repairVehicle") result = await VehicleRepairService.repair(message.payload, message.userId);
            else if (message.action === "grantHydrogenFuel") result = await VehicleFuelService.grant(message.payload, message.userId);
            else if (message.action === "postVehicleLoadout") result = await VehicleSheetToolTransactions.postLoadout(message.payload, message.userId);
            else if (message.action === "shipLongRest") result = await VehicleSheetToolTransactions.longRest(message.payload, message.userId);
            else if (message.action === "shipRegister") result = await VehicleSheetToolTransactions.register(message.payload, message.userId);
            else if (message.action === "shipInsurance") result = await VehicleSheetToolTransactions.insurance(message.payload, message.userId);
            else if (message.action === "shipFuelPurge") result = await VehicleSheetToolTransactions.fuelPurge(message.payload, message.userId);
            else if (message.action === "deployHeatSink") result = await VehicleHeatSinkService.resolve(message.payload.choiceId, true, message.userId, message.payload.messageId);
            else if (message.action === "declineHeatSink") result = await VehicleHeatSinkService.resolve(message.payload.choiceId, false, message.userId, message.payload.messageId);
            else throw new Error(`Unknown Full Speed Ahead vehicle operation: ${message.action || "unknown"}.`);
            if (message.userId !== game.user.id) game.socket.emit(FSA_SOCKET, { type: "vehicleOperationsResponse", userId: message.userId, ok: true, message: "Full Speed Ahead request complete." });
            return result;
        } catch (error) {
            console.error(`${FSA_MODULE_ID} | Vehicle operation failed.`, error);
            ui.notifications.error(error.message || "Vehicle operation failed.");
            if (message.userId !== game.user.id) game.socket.emit(FSA_SOCKET, { type: "vehicleOperationsResponse", userId: message.userId, ok: false, message: error.message || "Vehicle operation failed." });
        }
    }
}

class VehicleOperationsApplication extends FormApplication {
    static current = null;

    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "full-speed-ahead-vehicle-operations",
            title: "FSA",
            template: `modules/${FSA_MODULE_ID}/templates/vehicle-operations.hbs`,
            width: 460,
            height: "auto",
            closeOnSubmit: false,
            submitOnChange: false,
            tabs: [{ navSelector: ".fsa-vehicle-ops-tabs", contentSelector: ".fsa-vehicle-ops-body", initial: "attack" }]
        });
    }

    constructor(object = {}, options = {}) {
        super(object, options);
        this.targetPayload = object;
    }

    static open(initialTab = "attack") {
        const target = VehicleTargetResolver.current({ notify: false }) || VehicleTargetResolver.firstSceneVehicle();
        if (!target) return null;
        if (this.current) this.current.close();
        this.current = new this(target, { initialTab });
        this.current.render(true);
        return this.current;
    }

    static openSettings() {
        if (game.fullSpeedAhead?.openSettings) return game.fullSpeedAhead.openSettings();
        ui.notifications.info("Full Speed Ahead settings are not available yet.");
        return null;
    }

    get target() {
        return this.targetPayload || this.object;
    }

    set target(value) {
        this.targetPayload = value;
    }

    get actor() {
        return VehicleTargetResolver.resolve(this.target).actor;
    }

    getData() {
        const actor = this.actor;
        const rolls = lastAttackAndDamageRolls();
        const repairChatAction = lastRepairChatAction();
        const shield = VehicleModuleService.activeShield(actor);
        const shieldsUp = VehicleModuleService.itemHp(shield) > 0;
        const hull = VehicleModuleService.firstHealthyHull(actor);
        const fuelScoop = VehicleModuleService.findModule(actor, /fuel scoop/i);
        const refinery = VehicleModuleService.findModule(actor, /refinery/i);
        const modules = VehicleModuleService.damageableModules(actor).sort((a, b) => VehicleModuleService.itemAc(a) - VehicleModuleService.itemAc(b) || a.name.localeCompare(b.name));
        const repairableModules = VehicleModuleService.repairableModules(actor).sort((a, b) => VehicleModuleService.itemAc(a) - VehicleModuleService.itemAc(b) || a.name.localeCompare(b.name));
        const options = this.moduleOptions(modules, repairableModules, hull, shieldsUp, shield, fuelScoop, refinery);
        const repairPreview = VehicleRepairService.preview(actor);
        return {
            target: this.target,
            targetName: actor.name,
            sceneVehicles: currentSceneVehicleOptions(this.target),
            shieldsUp,
            shieldStatus: shieldsUp ? "Shields Up" : "Shields Down",
            shieldText: shieldsUp ? `${actor.name} is being attacked. Shields are up, so damage will hit shields first.` : `${actor.name} is being attacked. No shields are active, so damage will go to hull protection before vulnerable modules.`,
            attack: rolls.attack ?? "",
            damage: rolls.damage ?? 0,
            repairAction: repairChatAction,
            repairActions: this.repairActions(repairChatAction),
            fuelYield: rolls.fuelYield ?? 0,
            destinations: TradeHubIntegrationAdapter.locations().map(name => ({ name })),
            tradeHubCapital: TradeHubIntegrationAdapter.capitalAvailable() ? formatGp(TradeHubIntegrationAdapter.capital()) : "Unavailable",
            repairEstimate: formatGp(repairPreview.total),
            repairRawEstimate: formatGp(repairPreview.rawTotal),
            repairAfter: TradeHubIntegrationAdapter.capitalAvailable() ? formatGp(TradeHubIntegrationAdapter.capital() - repairPreview.total) : "Unavailable",
            insured: repairPreview.insured,
            savings: formatGp(repairPreview.rawTotal - repairPreview.total),
            isGM: game.user.isGM,
            ...options
        };
    }

    moduleOptions(modules, repairableModules, hull, shieldsUp, shield, fuelScoop, refinery) {
        const base = modules.map(item => ({ id: item.id, label: `AC ${VehicleModuleService.itemAc(item)} - ${item.name}` }));
        const repairableBase = repairableModules.map(item => {
            const destroyed = !VehicleModuleService.isEquippedShipModule(item) || VehicleModuleService.itemHp(item) <= 0 || VehicleModuleService.wasDestroyed(item);
            return { id: item.id, label: `${destroyed ? "Destroyed - " : ""}AC ${VehicleModuleService.itemAc(item)} - ${item.name}` };
        });
        const evenly = { id: "evenly", label: "Evenly Among Vulnerable Modules", selected: !hull };
        const nonShieldBase = modules
            .filter(item => !VehicleModuleService.isShield(item))
            .map(item => ({ id: item.id, label: `AC ${VehicleModuleService.itemAc(item)} - ${item.name}` }));
        return {
            attackModules: shieldsUp && shield
                ? [{ id: shield.id, label: `${shield.name} (shields absorb first)`, selected: true }, { ...evenly, selected: false }].concat(nonShieldBase.map(option => ({ ...option, selected: false })))
                : [evenly].concat(base.map(option => ({ ...option, selected: option.id === hull?.id }))),
            fuelModules: base.map(option => ({ ...option, selected: option.id === fuelScoop?.id })),
            miningModules: [{ id: "evenly", label: "Evenly Among Vulnerable Modules", selected: !refinery && !shieldsUp && !hull }].concat(base.map(option => ({ ...option, selected: option.id === (refinery || (shieldsUp ? shield : null) || hull)?.id }))),
            repairModules: [{ id: "evenly", label: "Distribute Across Damaged Modules", selected: true }].concat(repairableBase)
        };
    }

    repairActions(selectedAction) {
        const actions = [
            { value: "repair-module", label: "Repair Module" },
            { value: "stabilize-module", label: "Stabilize Module" },
            { value: "full-service", label: "Full Service Repair and Replace" }
        ];
        if (game.user.isGM) actions.push({ value: "pristine", label: "Make Pristine" });
        return actions.map(action => ({ ...action, selected: action.value === selectedAction }));
    }

    activateListeners(html) {
        super.activateListeners(html);
        this.activateOperationTab(html, this.options.initialTab || "attack");
        html.find('[name="vehicleTarget"]').on("change", event => this.changeVehicleTarget(event.currentTarget.value, html));
        html.find("[data-action]").on("click", event => {
            event.preventDefault();
            const action = event.currentTarget.dataset.action;
            if (action === "apply-damage") return this.submitDamage(html, "attack");
            if (action === "apply-fuel-damage") return this.submitDamage(html, "fuel");
            if (action === "apply-mining-damage") return this.submitDamage(html, "mining");
            if (action === "scan") return this.submitScan(html);
            if (action === "repair") return this.submitRepair(html);
            if (action === "grant-fuel") return this.submitFuel(html);
            if (action === "open-settings") return VehicleOperationsApplication.openSettings();
        });
        html.find('[name="repairAction"]').on("change", () => this.updateRepairMode(html));
        html.find('[name="scanType"]').on("change", () => this.updateScanMode(html));
        this.updateRepairMode(html);
        this.updateScanMode(html);
    }

    changeVehicleTarget(tokenId, html) {
        const tokenDocument = canvas?.scene?.tokens?.get(tokenId);
        if (!tokenDocument?.actor || tokenDocument.actor.type !== "vehicle") {
            ui.notifications.warn("That vehicle is no longer available on the current scene.");
            return;
        }
        this.options.initialTab = this.activeOperationTab(html);
        this.target = VehicleTargetResolver.packToken(tokenDocument);
        this.render(false);
    }

    activeOperationTab(html) {
        return html.find(".fsa-vehicle-ops-tabs .item.active").data("tab") || this._tabs?.[0]?.active || this.options.initialTab || "attack";
    }

    submitDamage(html, context) {
        const prefix = context === "attack" ? "" : `${context}-`;
        const damageType = context === "attack" ? "hull" : html.find(`[name="${prefix}damageType"]`).val();
        VehicleOperationsSocketService.request("applyVehicleDamage", { ...this.target, context, damageType, attack: Number(html.find(`[name="${prefix}attack"]`).val() || 0), damage: Math.max(0, Number(html.find(`[name="${prefix}damage"]`).val() || 0)), targetModule: html.find(`[name="${prefix}targetModule"]`).val() || "evenly" });
        this.close();
    }

    submitScan(html) {
        VehicleOperationsSocketService.request("performVehicleScan", { ...this.target, scanType: html.find('[name="scanType"]').val(), destination: html.find('[name="scanDestination"]').val() || "" });
    }

    submitRepair(html) {
        VehicleOperationsSocketService.request("repairVehicle", { ...this.target, action: html.find('[name="repairAction"]').val(), hp: Math.max(0, Number(html.find('[name="repairHp"]').val() || 0)), targetModule: html.find('[name="repairTargetModule"]').val() || "evenly", billCapital: html.find('[name="billCapital"]').prop("checked") !== false });
        this.close();
    }

    submitFuel(html) {
        const quantity = Math.max(0, Number(html.find('[name="fuelYield"]').val() || 0));
        if (!quantity) return ui.notifications.warn("Enter the Hydrogen Fuel amount scooped.");
        VehicleOperationsSocketService.request("grantHydrogenFuel", { ...this.target, quantity });
    }

    updateRepairMode(html) {
        const action = html.find('[name="repairAction"]').val();
        const full = action === "full-service";
        const pristine = action === "pristine";
        const stabilize = action === "stabilize-module";
        html.find("[data-repair-hp-row]").toggle(!full && !pristine && !stabilize);
        html.find("[data-repair-bill-row]").toggle(full);
        html.find("[data-repair-target-row]").toggle(!pristine);
        html.find("[data-repair-estimate]").toggle(!pristine);
        html.find("[data-pristine-note]").toggle(pristine);
        html.find("[data-stabilize-note]").toggle(stabilize);
    }

    updateScanMode(html) {
        html.find("[data-scan-destination]").toggle(html.find('[name="scanType"]').val() === "wake");
    }

    activateOperationTab(html, tab) {
        if (this._tabs?.[0]?.activate) {
            this._tabs[0].activate(tab);
            return;
        }
        html.find(".fsa-vehicle-ops-tabs .item").removeClass("active");
        html.find(`.fsa-vehicle-ops-tabs .item[data-tab="${tab}"]`).addClass("active");
        html.find(".fsa-vehicle-ops-body .tab").removeClass("active");
        html.find(`.fsa-vehicle-ops-body .tab[data-tab="${tab}"]`).addClass("active");
    }

    async close(options) {
        if (VehicleOperationsApplication.current === this) VehicleOperationsApplication.current = null;
        return super.close(options);
    }

    async _updateObject() {}
}

class FullSpeedAheadSharedCapitalConfig extends FormApplication {
    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "full-speed-ahead-shared-capital-config",
            title: "Full Speed Ahead: Shared Capital",
            template: `modules/${FSA_MODULE_ID}/templates/shared-capital-settings.hbs`,
            width: 540,
            closeOnSubmit: true,
            submitOnChange: false
        });
    }

    getData() {
        const activeTradeHub = TradeHubIntegrationAdapter.usesTradeHubCapital();
        const capital = TradeHubIntegrationAdapter.capital();
        const playerOptions = game.actors.contents
            .filter(actor => actor?.hasPlayerOwner && actor.type !== "vehicle")
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(actor => ({ id: actor.id, name: actor.name }));
        return {
            activeTradeHub,
            sourceLabel: TradeHubIntegrationAdapter.capitalSourceLabel(),
            capitalTitle: activeTradeHub ? "TradeHub Capital" : "Shared Capital",
            capital,
            formattedCapital: formatGp(capital),
            fallbackCapital: formatGp(TradeHubIntegrationAdapter.fallbackCapital()),
            playerOptions,
            statusText: activeTradeHub
                ? "TradeHub Markets is active. Full Speed Ahead reads and writes TradeHub's internal capital, then mirrors that value locally so the shared ledger stays aligned."
                : "TradeHub Markets is not active. Full Speed Ahead is holding the shared capital locally. If TradeHub is enabled later, this balance can seed TradeHub's internal capital."
        };
    }

    activateListeners(html) {
        super.activateListeners(html);

        html.find('[name="playerWithdrawal"]').on("change", event => {
            html.find('[name="playerActorId"]').prop("disabled", !event.currentTarget.checked);
        });
        html.find('[data-action="cancel"]').on("click", event => {
            event.preventDefault();
            this.close();
        });
    }

    async _updateObject(_event, formData) {
        const rawAmount = String(formData.capitalAmount ?? "").trim();
        if (!rawAmount) throw new Error("Enter a valid capital amount.");
        const amount = Number(rawAmount.replace(/,/g, ""));
        if (!Number.isFinite(amount)) throw new Error("Enter a valid capital amount.");
        const current = TradeHubIntegrationAdapter.capital();
        const replace = Boolean(formData.replaceTotal);
        const playerWithdrawal = Boolean(formData.playerWithdrawal);
        const next = replace ? amount : current + amount;
        if (next < 0) return ui.notifications.error("Shared capital cannot go below 0.");
        await TradeHubIntegrationAdapter.setCapital(next);

        let messageContent;
        if (replace) {
            messageContent = `<b>${formatGp(next)} has been set as ${escapeHtml(TradeHubIntegrationAdapter.capitalSourceLabel())} Capital.</b><br>Shared Capital: ${formatGp(next)}`;
        } else {
            const action = amount >= 0 ? "added to" : "withdrawn from";
            messageContent = `<b>${formatGp(Math.abs(amount))} has been ${action} shared capital.</b><br>Shared Capital: ${formatGp(next)}`;
        }

        if (!replace && playerWithdrawal && amount < 0 && formData.playerActorId) {
            const playerActor = game.actors.get(String(formData.playerActorId));
            if (playerActor) {
                const playerCash = Number(playerActor.system?.currency?.gp || 0) + Math.abs(amount);
                await playerActor.update({ "system.currency.gp": playerCash });
                messageContent += `<br><b>Withdrew ${formatGp(Math.abs(amount))} to ${escapeHtml(playerActor.name)}.</b>`;
            }
        }

        await VehicleChatCardService.create({ speaker: { alias: "Full Speed Ahead Banking" }, content: messageContent });
        ui.notifications.info(`Shared capital updated to ${formatGp(TradeHubIntegrationAdapter.capital())}.`);
        refreshSharedCapitalInterfaces({ broadcast: true });
    }
}

class FullSpeedAheadBankingDialog {
    static show() {
        if (!game.user?.isGM) return ui.notifications.error("Only the GM can edit shared capital.");

        const capital = Math.floor(TradeHubIntegrationAdapter.capital());
        const playerActors = game.actors.contents
            .filter(actor => actor?.hasPlayerOwner && actor.type !== "vehicle")
            .sort((a, b) => a.name.localeCompare(b.name));
        const playerOptions = playerActors
            .map(actor => `<option value="${actor.id}">${escapeHtml(actor.name)}</option>`)
            .join("");
        const content = `<div class="fsa-shared-capital fsa-banking-dialog">
            <section class="fsa-capital-card">
                <div class="fsa-capital-title">TradeHub Capital</div>
                <div class="fsa-capital-balance">${formatGp(capital)}</div>
            </section>
            <div class="fsa-banking-grid">
                <label for="fsa-bank-value">Enter Value:</label>
                <input type="number" id="fsa-bank-value" name="bank-value" placeholder="+100, -50, etc.">
                <label for="fsa-bank-replace">Replace total:</label>
                <input type="checkbox" id="fsa-bank-replace" name="replace-total">
                <label for="fsa-player-withdrawal">Player withdrawal:</label>
                <input type="checkbox" id="fsa-player-withdrawal" name="player-withdrawal">
                <label for="fsa-player-select">Select Player:</label>
                <select id="fsa-player-select" name="player-select" disabled>${playerOptions}</select>
            </div>
        </div>`;

        renderUniqueFsaDialog("shared-capital-banking", {
            title: "FSA Banking",
            content,
            buttons: {
                save: {
                    label: "Save",
                    callback: html => this.save(html, capital)
                },
                cancel: { label: "Cancel" }
            },
            default: "save",
            render: html => {
                html.find("#fsa-player-withdrawal").on("change", event => {
                    html.find("#fsa-player-select").prop("disabled", !event.currentTarget.checked);
                });
            }
        }, { width: 540 });
    }

    static async save(html, currentCapital) {
        const raw = String(html.find("#fsa-bank-value").val() || "").trim();
        const value = parseInt(raw, 10);
        if (Number.isNaN(value)) return ui.notifications.error("Invalid input. Please enter a valid number.");

        const replace = html.find("#fsa-bank-replace").prop("checked");
        const playerWithdrawal = html.find("#fsa-player-withdrawal").prop("checked");
        const selectedPlayerId = html.find("#fsa-player-select").val();
        const nextCapital = replace ? value : currentCapital + value;
        if (nextCapital < 0) return ui.notifications.error("Shared capital cannot go below 0.");

        await TradeHubIntegrationAdapter.setCapital(nextCapital);

        let messageContent;
        if (replace) {
            messageContent = `<b>${formatGp(nextCapital)} has been set as TradeHub Capital.</b><br>TradeHub Capital: ${formatGp(nextCapital)}`;
        } else {
            const action = value > 0 ? "added to" : "withdrawn from";
            messageContent = `<b>${formatGp(Math.abs(value))} has been ${action} TradeHub Capital.</b><br>TradeHub Capital: ${formatGp(nextCapital)}`;
            if (playerWithdrawal && value < 0 && selectedPlayerId) {
                const playerActor = game.actors.get(selectedPlayerId);
                if (playerActor) {
                    const playerCash = Number(playerActor.system?.currency?.gp || 0) + Math.abs(value);
                    await playerActor.update({ "system.currency.gp": playerCash });
                    messageContent += `<br><b>Withdrew ${formatGp(Math.abs(value))} from TradeHub Capital to ${escapeHtml(playerActor.name)}.</b>`;
                }
            }
        }

        await VehicleChatCardService.create({ speaker: { alias: "Full Speed Ahead Banking" }, content: messageContent });
        ui.notifications.info(`Shared capital updated to ${formatGp(TradeHubIntegrationAdapter.capital())}.`);
        refreshSharedCapitalInterfaces({ broadcast: true });
    }
}

class VehicleSheetButtonsConfig extends FormApplication {
    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "full-speed-ahead-vehicle-sheet-buttons",
            title: "Full Speed Ahead: Vehicle Sheet Buttons",
            template: `modules/${FSA_MODULE_ID}/templates/vehicle-sheet-buttons-settings.hbs`,
            width: 620,
            closeOnSubmit: true,
            submitOnChange: false
        });
    }

    getData() {
        return {
            vehicleSheetToolsEnabled: game.settings.get(FSA_MODULE_ID, "vehicleSheetToolsEnabled")
        };
    }

    async _updateObject(_event, formData) {
        await game.settings.set(FSA_MODULE_ID, "vehicleSheetToolsEnabled", Boolean(formData.vehicleSheetToolsEnabled));
        rerenderOpenVehicleSheets();
    }
}

class FullSpeedAheadFloatingMenu {
    static id = "full-speed-ahead-floating-menu";

    static render() {
        if (document.getElementById(this.id)) return;
        if (!canShowFsaFloatingMenu()) return;

        const showWallet = !isTradeHubMarketsDetected();
        const pos = game.settings.get(FSA_MODULE_ID, "vehicleOpsFloatingMenuPosition") || { left: 14, top: 125 };
        const menu = document.createElement("div");
        menu.id = this.id;
        menu.className = "fsa-floating-menu";
        menu.style.left = `${Number(pos.left || 14)}px`;
        menu.style.top = `${Number(pos.top || 125)}px`;
        menu.innerHTML = `
            <strong class="fsa-floating-menu-title">FSA</strong>
            <div class="fsa-floating-menu-actions">
                <button type="button" data-tab="attack" title="Attack Damage" aria-label="Attack Damage"><i class="fas fa-bomb"></i></button>
                <button type="button" data-tab="scans" title="Scan" aria-label="Scan"><i class="fas fa-satellite-dish"></i></button>
                <button type="button" data-tab="repair" title="Repair" aria-label="Repair"><i class="fas fa-wrench"></i></button>
                <button type="button" data-tab="fuel" title="Fuel Scooping" aria-label="Fuel Scooping"><i class="fas fa-gas-pump"></i></button>
                <button type="button" data-tab="mining" title="Mining" aria-label="Mining"><i class="fas fa-gem"></i></button>
                ${showWallet ? `<button type="button" data-action="banking" title="FSA Banking" aria-label="FSA Banking"><i class="fas fa-wallet"></i></button>` : ""}
                <button type="button" data-action="settings" title="Full Speed Ahead Settings" aria-label="Full Speed Ahead Settings"><i class="fas fa-cog"></i></button>
            </div>`;
        document.body.appendChild(menu);

        menu.querySelectorAll("[data-tab]").forEach(button => {
            button.addEventListener("click", event => {
                event.preventDefault();
                VehicleOperationsApplication.open(event.currentTarget.dataset.tab || "attack");
            });
        });
        menu.querySelector('[data-action="settings"]')?.addEventListener("click", event => {
            event.preventDefault();
            VehicleOperationsApplication.openSettings();
        });
        menu.querySelector('[data-action="banking"]')?.addEventListener("click", event => {
            event.preventDefault();
            FullSpeedAheadBankingDialog.show();
        });

        let dragging = null;
        menu.addEventListener("mousedown", event => {
            if (event.target.closest("button")) return;
            dragging = { x: event.clientX - menu.offsetLeft, y: event.clientY - menu.offsetTop };
            menu.classList.add("dragging");
        });
        window.addEventListener("mousemove", event => {
            if (!dragging) return;
            menu.style.left = `${Math.max(0, event.clientX - dragging.x)}px`;
            menu.style.top = `${Math.max(0, event.clientY - dragging.y)}px`;
        });
        window.addEventListener("mouseup", async () => {
            if (!dragging) return;
            dragging = null;
            menu.classList.remove("dragging");
            await game.settings.set(FSA_MODULE_ID, "vehicleOpsFloatingMenuPosition", { left: menu.offsetLeft, top: menu.offsetTop });
        });
    }

    static close() {
        document.getElementById(this.id)?.remove();
    }
}

function isTradeHubMarketsDetected() {
    return Boolean(game.modules?.get("tradehub-markets"));
}

Hooks.once("init", () => {
    registerVehicleOpsSettings();
});

Hooks.once("ready", () => {
    VehicleOperationsSocketService.init();
    if (game.user.isGM) migrateGlaxonInsuranceFlags().catch(error => console.warn(`${FSA_MODULE_ID} | Glaxon insurance migration failed.`, error));
    if (game.user.isGM) TradeHubIntegrationAdapter.reconcileSharedCapital().catch(error => console.warn(`${FSA_MODULE_ID} | Shared capital reconciliation failed.`, error));
    game.fullSpeedAhead = game.fullSpeedAhead || {};
    game.fullSpeedAhead.vehicleOperations = {
        open: tab => VehicleOperationsApplication.open(tab),
        renderFloatingMenu: () => FullSpeedAheadFloatingMenu.render(),
        closeFloatingMenu: () => FullSpeedAheadFloatingMenu.close()
    };
    game.fullSpeedAhead.getShipUpkeepPercent = () => TradeHubIntegrationAdapter.shipUpkeepPercent();
    game.fullSpeedAhead.setShipUpkeepPercent = value => TradeHubIntegrationAdapter.setShipUpkeepPercent(value);
    game.fullSpeedAhead.calculateShipUpkeep = totalShipValue => TradeHubIntegrationAdapter.calculateShipUpkeepFromPercent(totalShipValue);
    game.fullSpeedAhead.getGlaxonInsurancePremiumPercent = () => TradeHubIntegrationAdapter.glaxonInsurancePremiumPercent();
    game.fullSpeedAhead.setGlaxonInsurancePremiumPercent = value => TradeHubIntegrationAdapter.setGlaxonInsurancePremiumPercent(value);
    game.fullSpeedAhead.calculateGlaxonInsurancePremium = totalRepairValue => TradeHubIntegrationAdapter.calculateGlaxonInsurancePremiumFromPercent(totalRepairValue);
    game.fullSpeedAhead.getShipInsurancePremiumPercent = game.fullSpeedAhead.getGlaxonInsurancePremiumPercent;
    game.fullSpeedAhead.setShipInsurancePremiumPercent = game.fullSpeedAhead.setGlaxonInsurancePremiumPercent;
    game.fullSpeedAhead.calculateShipInsurancePremium = game.fullSpeedAhead.calculateGlaxonInsurancePremium;
    game.fullSpeedAhead.getInsuranceCompanyName = () => TradeHubIntegrationAdapter.insuranceCompanyName();
    game.fullSpeedAhead.setInsuranceCompanyName = name => TradeHubIntegrationAdapter.setInsuranceCompanyName(name);
    game.fullSpeedAhead.isInsuranceConfirmationRequired = () => TradeHubIntegrationAdapter.insuranceConfirmationRequired();
    game.fullSpeedAhead.setInsuranceConfirmationRequired = required => game.settings.set(FSA_MODULE_ID, "vehicleOpsInsuranceCodeRequired", Boolean(required));
    game.fullSpeedAhead.getInsuranceConfirmationCode = () => TradeHubIntegrationAdapter.insuranceConfirmationCode();
    game.fullSpeedAhead.setInsuranceConfirmationCode = code => game.settings.set(FSA_MODULE_ID, "vehicleOpsInsuranceConfirmationCode", String(code || "").trim());
    game.fullSpeedAhead.openVehicleOperations = tab => VehicleOperationsApplication.open(tab);
    game.fullSpeedAhead.openVehicleSheetButtonsSettings = () => renderUniqueFsaApplication("vehicle-sheet-buttons-settings", () => new VehicleSheetButtonsConfig());
    game.fullSpeedAhead.openSharedCapitalSettings = () => renderUniqueFsaApplication("shared-capital-settings", () => new FullSpeedAheadSharedCapitalConfig());
    installTradeHubCapitalRefreshBridge();
    FullSpeedAheadFloatingMenu.render();
});

Hooks.on("canvasReady", () => FullSpeedAheadFloatingMenu.render());
Hooks.on("renderActorSheet", injectFsaVehicleSheetTools);
Hooks.on("renderTidy5eActorSheet", injectFsaVehicleSheetTools);
Hooks.on("renderTidy5eSheet", injectFsaVehicleSheetTools);
Hooks.on("updateSetting", setting => {
    const key = setting?.key || setting?.id || setting?.name || "";
    if (key === "tradehub-markets.data" || key === `${FSA_MODULE_ID}.vehicleOpsFallbackCapital`) {
        refreshSharedCapitalInterfaces({ broadcast: false });
    }
});

Hooks.on("getSceneControlButtons", controls => {
    if (!canShowFsaFloatingMenu()) return;
    const tokenControls = Array.isArray(controls) ? controls.find(control => control.name === "token") : controls?.token;
    const tools = Array.isArray(tokenControls?.tools) ? tokenControls.tools : null;
    if (!tools || tools.some(tool => tool.name === "full-speed-ahead-vehicle-operations")) return;
    tools.push({
        name: "full-speed-ahead-vehicle-operations",
        title: "Full Speed Ahead Vehicle Operations",
        icon: "fas fa-bomb",
        button: true,
        onClick: () => VehicleOperationsApplication.open("attack")
    });
});

Hooks.on("renderChatMessage", (message, html) => {
    html.find(FSA_HEAT_SINK_CARD_SELECTOR).on("click", event => {
        event.preventDefault();
        const button = event.currentTarget;
        VehicleOperationsSocketService.request(button.dataset.fsaHeatSinkNo !== undefined ? "declineHeatSink" : "deployHeatSink", { choiceId: button.dataset.choiceId, messageId: message.id });
    });
});

Hooks.on("createItem", async (item, options, _userId) => {
    if (await maybeHandlePowerCoreCreated(item, options)) return;
    if (shouldScheduleVehicleModuleSync(item, options)) VehicleModuleService.scheduleStructuralSync(item.parent, "Module created");
});
Hooks.on("deleteItem", async (item, options, _userId) => {
    if (await maybeHandlePowerCoreDeleted(item, options)) return;
    if (shouldScheduleVehicleModuleSync(item, options)) VehicleModuleService.scheduleStructuralSync(item.parent, "Module deleted");
});
Hooks.on("updateItem", async (item, changes, options) => {
    if (await maybeHandleManualPowerCoreStateChange(item, changes, options)) return;
    if (!shouldScheduleVehicleModuleSync(item, options)) return;
    const relevant = ["system.equipped", "system.hp", "system.hp.value", "system.hp.max", "system.armor.value", "system.ac.value", "system.price", "system.price.value", "name"].some(path => foundry.utils.hasProperty(changes, path) || Object.prototype.hasOwnProperty.call(changes, path));
    if (relevant) VehicleModuleService.scheduleStructuralSync(item.parent, "Module changed");
});

async function maybeHandlePowerCoreCreated(item, options = {}) {
    if (options?.fullSpeedAheadVehicleOperation) return false;
    if (!game.user?.isGM || item?.parent?.type !== "vehicle") return false;
    if (!VehicleModuleService.isShipModuleItem(item) || !VehicleModuleService.isPowerCore(item)) return false;

    if (VehicleModuleService.hasOnlinePowerCore(item.parent)) {
        await VehicleModuleService.enableModulesForPowerCoreRestore(item.parent);
        ui.notifications.info(`${item.parent.name} Power Core is online. Modules with HP above 0 were equipped.`);
        return true;
    }

    await VehicleModuleService.disableModulesForPowerCoreFailure(item.parent);
    ui.notifications.warn(`${item.parent.name} Power Core is present but offline. All modules were unequipped and vessel HP was held at 1.`);
    return true;
}

async function maybeHandlePowerCoreDeleted(item, options = {}) {
    if (options?.fullSpeedAheadVehicleOperation) return false;
    if (!game.user?.isGM || item?.parent?.type !== "vehicle") return false;
    if (!VehicleModuleService.isShipModuleItem(item) || !VehicleModuleService.isPowerCore(item)) return false;

    if (VehicleModuleService.hasOnlinePowerCore(item.parent)) {
        VehicleModuleService.scheduleStructuralSync(item.parent, "Power Core removed, backup online");
        return true;
    }

    await VehicleModuleService.disableModulesForPowerCoreFailure(item.parent);
    ui.notifications.warn(`${item.parent.name} Power Core was removed. All modules were unequipped and vessel HP was held at 1.`);
    return true;
}

async function maybeHandleManualPowerCoreStateChange(item, changes, options = {}) {
    if (options?.fullSpeedAheadVehicleOperation) return false;
    if (!game.user?.isGM || item?.parent?.type !== "vehicle") return false;
    if (!VehicleModuleService.isShipModuleItem(item) || !VehicleModuleService.isPowerCore(item)) return false;

    const equippedChanged = foundry.utils.hasProperty(changes, "system.equipped") || Object.prototype.hasOwnProperty.call(changes, "system.equipped");
    const hpChanged = foundry.utils.hasProperty(changes, "system.hp.value") || Object.prototype.hasOwnProperty.call(changes, "system.hp.value");
    const explicitlyEquipped = equippedChanged && item.system?.equipped === true;
    const explicitlyUnequipped = equippedChanged && item.system?.equipped !== true;
    const reducedToZero = hpChanged && VehicleModuleService.itemHp(item) <= 0;
    if (explicitlyEquipped && VehicleModuleService.itemHp(item) > 0) {
        await VehicleModuleService.enableModulesForPowerCoreRestore(item.parent);
        ui.notifications.info(`${item.parent.name} Power Core is online. Modules with HP above 0 were equipped.`);
        return true;
    }

    if (!explicitlyUnequipped && !reducedToZero) return false;

    await VehicleModuleService.disableModulesForPowerCoreFailure(item.parent);
    ui.notifications.warn(`${item.parent.name} Power Core is offline. All modules were unequipped and vessel HP was held at 1.`);
    return true;
}

function shouldScheduleVehicleModuleSync(item, options = {}) {
    if (options?.fullSpeedAheadVehicleOperation) return false;
    if (item?.parent?.type !== "vehicle") return false;
    return VehicleModuleService.isShipModuleItem(item) || ["equipment", "weapon"].includes(item.type);
}

function canShowFsaFloatingMenu() {
    if (!game.settings.get(FSA_MODULE_ID, "vehicleOpsEnabled")) return false;
    if (game.user.isGM) return game.settings.get(FSA_MODULE_ID, "vehicleOpsShowFloatingMenuGM");
    return game.settings.get(FSA_MODULE_ID, "vehicleOpsShowFloatingMenuPlayers");
}

function injectFsaVehicleSheetTools(app, html) {
    const actor = app?.actor || app?.document;
    if (!game.settings.get(FSA_MODULE_ID, "vehicleSheetToolsEnabled")) return;
    if (!actor || actor.type !== "vehicle") return;
    if (!vehicleOperationsHasOwnerPermission(actor, game.user)) return;
    const root = html?.jquery ? html : $(html);
    if (!root?.length) return;
    placeFsaVehicleSheetTools(root, actor);
    window.setTimeout(() => placeFsaVehicleSheetTools(root, actor), 100);
    window.setTimeout(() => placeFsaVehicleSheetTools(root, actor), 500);
    window.setTimeout(() => placeFsaVehicleSheetTools(root, actor), 1000);
}

function placeFsaVehicleSheetTools(root, actor) {
    if (root.find(".full-speed-ahead-sheet-tools").length) return;
    const panel = $(VehicleSheetToolService.sheetHtml());
    const target = findFsaVehicleSheetToolInsertion(root);
    if (target?.length) target.after(panel);
    else {
        const fallback = root.find(".traits, .attributes, .sheet-sidebar, .sidebar, .left-pane, .left-column").first();
        if (fallback.length) fallback.append(panel);
        else root.find("form").first().prepend(panel);
    }
    bindFsaVehicleSheetTools(panel, actor);
}

function findFsaVehicleSheetToolInsertion(root) {
    const tradeHubPanel = findTradeHubVehicleSheetTools(root);
    if (tradeHubPanel.length) return tradeHubPanel;
    return findFsaConditionImmunityInsertion(root);
}

function findTradeHubVehicleSheetTools(root) {
    const tradeHubButtons = root.find("button").filter((_index, element) => {
        const text = element.textContent?.replace(/\s+/g, " ").trim() || "";
        return /^(Smollar Markets|TradeHub Markets|View Cargo|Chat Loadout|Print Loadout|Long Rest|Registration|Fuel Release)$/i.test(text);
    });
    if (!tradeHubButtons.length) return $();
    let candidate = tradeHubButtons.first().parent();
    while (candidate.length && !candidate.is(root) && candidate.find("button").filter((_index, element) => tradeHubButtons.toArray().includes(element)).length < tradeHubButtons.length) {
        candidate = candidate.parent();
    }
    if (candidate.length && !candidate.is(root) && !candidate.is("form")) return candidate.first();
    return tradeHubButtons.last();
}

function findFsaConditionImmunityInsertion(root) {
    const conditionLabel = game.i18n.localize("DND5E.ConImm");
    const tidyTrait = root.find('[data-tidy-sheet-part="actor-trait"]').filter((_index, element) => {
        const trait = $(element);
        const icon = trait.find(".trait-icon").first();
        const label = icon.attr("title") || icon.attr("aria-label") || "";
        return label === conditionLabel || /^Condition Immunities\b/i.test(trait.text().trim());
    }).first();
    if (tidyTrait.length) return tidyTrait;

    const regularTrait = root.find(".traits .form-group").filter((_index, element) => {
        const label = $(element).children("label").first().text().trim();
        return label === conditionLabel || /^Condition Immunities\b/i.test(label);
    }).first();
    if (regularTrait.length) return regularTrait;

    const labels = root.find("*").filter((_index, element) => {
        const label = $(element).clone().children().remove().end().text().trim();
        return label === conditionLabel || /^Condition Immunities\b/i.test(label);
    });
    for (const element of labels.toArray().reverse()) {
        const preferred = $(element).closest('[data-tidy-sheet-part="actor-trait"], .trait-form-group, .form-group, .trait, .attribute, .card, li, section');
        if (preferred.length && !preferred.is(root)) return preferred.first();
        const fallback = $(element).closest("div");
        if (fallback.length && !fallback.is(root)) return fallback.first();
    }
    return $();
}

function bindFsaVehicleSheetTools(panel, actor) {
    panel.find("[data-fsa-sheet-tool]").on("click", event => {
        event.preventDefault();
        event.stopPropagation();
        const tool = event.currentTarget.dataset.fsaSheetTool;
        if (tool === "loadout") return VehicleSheetToolService.showLoadout(actor);
        if (tool === "rest") return VehicleSheetToolService.confirmLongRest(actor);
        if (tool === "registration") return VehicleSheetToolService.showRegistration(actor);
        if (tool === "fuel") return VehicleSheetToolService.showFuelRelease(actor);
    });
}

async function migrateGlaxonInsuranceFlags() {
    for (const actor of game.actors ?? []) {
        if (actor.type !== "vehicle") continue;
        if (actor.getFlag(FSA_MODULE_ID, FSA_GLAXON_MIGRATION_FLAG)) continue;
        const legacyInsured = actor.getFlag("tradehub-markets", FSA_GLAXON_FLAG) === true;
        const fsaInsured = actor.getFlag(FSA_MODULE_ID, FSA_GLAXON_FLAG) === true;
        if (legacyInsured || fsaInsured) await TradeHubIntegrationAdapter.setGlaxonInsured(actor, true);
        await actor.setFlag(FSA_MODULE_ID, FSA_GLAXON_MIGRATION_FLAG, true);
    }
}

function refreshVehicleOperationInterfaces(actor = null, { broadcast = true } = {}) {
    for (const app of Object.values(ui.windows ?? {})) {
        if (!app?.rendered) continue;
        const appActor = app.actor || app.document;
        if (!actor || appActor?.id === actor.id || app.id === "full-speed-ahead-vehicle-operations") app.render(false);
    }
    VehicleOperationsApplication.current?.render(false);
    TradeHubIntegrationAdapter.refreshTradeHub();
    if (broadcast) game.socket?.emit?.(FSA_SOCKET, { type: "vehicleOperationsRefresh", actorId: actor?.id || "" });
}

function refreshSharedCapitalInterfaces({ broadcast = true } = {}) {
    clearTimeout(fsaSharedCapitalRefreshTimer);
    fsaSharedCapitalRefreshTimer = window.setTimeout(() => {
        fsaSharedCapitalRefreshTimer = null;
        for (const app of Object.values(ui.windows ?? {})) {
            if (!app?.rendered) continue;
            if (app.id === "full-speed-ahead-vehicle-operations" || app.id === "full-speed-ahead-shared-capital-config") app.render(false);
        }
        VehicleOperationsApplication.current?.render(false);
        if (broadcast && game.user?.isGM) game.socket?.emit?.(FSA_SOCKET, { type: "sharedCapitalRefresh" });
    }, 75);
}

function installTradeHubCapitalRefreshBridge() {
    const tradehub = game.tradehub;
    if (!tradehub || tradehub.__fullSpeedAheadCapitalRefreshBridge) return;
    const originalRefresh = typeof tradehub.refresh === "function" ? tradehub.refresh : null;
    tradehub.refresh = function fullSpeedAheadTradeHubRefreshBridge(...args) {
        const result = originalRefresh?.apply(this, args);
        refreshSharedCapitalInterfaces({ broadcast: game.user?.isGM === true });
        return result;
    };
    tradehub.__fullSpeedAheadCapitalRefreshBridge = true;
}

function refreshFsaFloatingMenu() {
    FullSpeedAheadFloatingMenu.close();
    FullSpeedAheadFloatingMenu.render();
    ui.controls?.render?.(true);
}

function rerenderOpenVehicleSheets() {
    for (const app of Object.values(ui.windows ?? {})) {
        const actor = app?.actor || app?.document;
        if (actor?.type === "vehicle") app.render(false);
    }
}

function registerVehicleOpsSettings() {
    const register = (key, data) => game.settings.register(FSA_MODULE_ID, key, { scope: "world", config: true, ...data });
    game.settings.registerMenu(FSA_MODULE_ID, "vehicleSheetButtonsConfig", {
        name: "Vehicle Sheet Buttons",
        label: "Configure Sheet Buttons",
        hint: "Configure FSA's Long Rest, Registration, Chat Loadout, and Fuel Release buttons on owned vehicle sheets.",
        icon: "fas fa-list-check",
        type: VehicleSheetButtonsConfig,
        restricted: true
    });
    game.settings.registerMenu(FSA_MODULE_ID, "sharedCapitalConfig", {
        name: "Shared Capital",
        label: "Configure Shared Capital",
        hint: "Configure the shared credit ledger used by Full Speed Ahead and TradeHub Markets.",
        icon: "fas fa-coins",
        type: FullSpeedAheadSharedCapitalConfig,
        restricted: true
    });
    register("vehicleOperationsData", { name: "Vehicle Operations Data", type: Object, default: foundry.utils.deepClone(FSA_DEFAULT_DATA), config: false });
    register("vehicleOpsFallbackCapital", { name: "Shared Capital Balance", hint: "Fallback shared capital used when TradeHub Markets is not active. When TradeHub is active, FSA mirrors TradeHub's internal capital here so the ledger remains continuous.", type: Number, default: 0, config: false });
    register("vehicleOpsFallbackCapitalWasUsed", { name: "Shared Capital Fallback Was Used", hint: "Tracks whether FSA should seed TradeHub capital from the local fallback when TradeHub becomes active.", type: Boolean, default: false, config: false });
    register("vehicleOpsEnabled", { name: "Enable Vehicle Operations", hint: "Enable Full Speed Ahead's vehicle operation logic for ship items, damage calculation, fuel scooping, mining damage, scans, repair, heat sinks, and cargo failure tools.", type: Boolean, default: true, config: false, onChange: refreshFsaFloatingMenu });
    register("vehicleSheetToolsEnabled", { name: "Show FSA Vehicle Sheet Tools", hint: "Show Long Rest, Registration, Chat Loadout, and Fuel Release controls on owned vehicle sheets.", type: Boolean, default: true, config: false, onChange: rerenderOpenVehicleSheets });
    register("vehicleOpsShowFloatingMenuGM", { name: "Show GM FSA Floating Menu", hint: "Show the draggable FSA floating operations menu and vehicle operations scene-control button to the GM.", type: Boolean, default: true, config: false, onChange: refreshFsaFloatingMenu });
    register("vehicleOpsShowFloatingMenuPlayers", { name: "Show FSA Floating Menu to Players", hint: "Show the draggable FSA floating operations menu to non-GM users.", type: Boolean, default: false, config: false, onChange: refreshFsaFloatingMenu });
    register("vehicleOpsFloatingMenuPosition", { name: "Vehicle Operations Floating Menu Position", type: Object, default: { left: 14, top: 125 }, config: false });
    register("vehicleOpsScansEnabled", { name: "Enable Vehicle Operation Scans", hint: "Allow Tactical, Manifest, and Wake scans from the vehicle operations window.", type: Boolean, default: true, config: false });
    register("vehicleOpsRepairCostPerHp", { name: "Fallback Repair Cost Per Module HP", hint: "Used when TradeHub is unavailable or does not expose a repair HP cost.", type: Number, default: 100, config: false });
    register("vehicleOpsRepairCostPerShieldPoint", { name: "Fallback Repair Cost Per Shield HP", hint: "Used when TradeHub is unavailable or does not expose a shield repair HP cost.", type: Number, default: 100, config: false });
    register("vehicleOpsShipUpkeepPercent", { name: "Fallback Ship Long Rest Upkeep Percentage", hint: "Used when TradeHub is unavailable or does not expose shipUpkeepPercent/calculateShipUpkeep. Enter 0.2 for 0.2%.", type: Number, default: 0.2, config: false });
    register("vehicleOpsGlaxonPremiumPercent", { name: "Fallback Glaxon Insurance Premium Percentage", hint: "Used when TradeHub is unavailable or does not expose a Glaxon insurance premium setting/calculator. Enter 5 for 5%.", type: Number, default: 5, config: false });
    register("vehicleOpsInsuranceCompanyName", { name: "Insurance Company Name", hint: "Displayed name for vehicle insurance in Full Speed Ahead.", type: String, default: "Glaxxon Insurance", config: false });
    register("vehicleOpsInsuranceCodeRequired", { name: "Require Glaxon Insurance Confirmation Code", hint: "Require a confirmation code before a vehicle can subscribe to Glaxon insurance.", type: Boolean, default: false, config: false });
    register("vehicleOpsInsuranceConfirmationCode", { name: "Glaxon Insurance Confirmation Code", hint: "Code that must be entered when subscribing to Glaxon insurance if confirmation is required.", type: String, default: "", config: false });
    register("vehicleOpsTokenMagicDamage", { name: "Use TokenMagic Damage Bursts", hint: "If TokenMagic FX is installed, show splash damage filters when vehicle modules take damage.", type: Boolean, default: true, config: false });
    register("vehicleOpsItemPilesJettison", { name: "Use Item Piles for Cargo Jettison", hint: "If Item Piles is installed, create cargo piles near the vehicle when Cargo Bay failure jettisons cargo.", type: Boolean, default: true, config: false });
}

function lastAttackAndDamageRolls() {
    const messages = Array.from(game.messages?.contents || []).slice().reverse();
    const rollOf = message => {
        const rolls = message?.rolls || (message?.roll ? [message.roll] : []);
        return rolls[0] || null;
    };
    const textOf = message => stripHtml(`${message?.flavor || ""} ${message?.content || ""}`);
    const attackMessage = messages.find(message => rollOf(message)?.formula?.includes("1d20") && !/constitution saving throw/i.test(textOf(message)));
    const fuelYieldMessage = messages.find(message => {
        const roll = rollOf(message);
        return roll && !roll.formula?.includes("1d20") && /other formula/i.test(textOf(message));
    });
    const damageMessage = messages.find(message => {
        const roll = rollOf(message);
        return roll && !roll.formula?.includes("1d20") && !/other formula|constitution saving throw/i.test(textOf(message));
    });
    return { attack: rollOf(attackMessage)?.total ?? null, damage: rollOf(damageMessage)?.total ?? 0, fuelYield: rollOf(fuelYieldMessage)?.total ?? 0 };
}

function lastRepairChatAction() {
    const messages = Array.from(game.messages?.contents || []).slice().reverse();
    const message = messages.find(entry => /repair module|stabilize module/i.test(stripHtml(`${entry?.flavor || ""} ${entry?.content || ""}`)));
    const text = stripHtml(`${message?.flavor || ""} ${message?.content || ""}`);
    if (/stabilize module/i.test(text)) return "stabilize-module";
    if (/repair module/i.test(text)) return "repair-module";
    return "repair-module";
}

function fromUuidSyncSafe(uuid) {
    try {
        return uuid && globalThis.fromUuidSync ? globalThis.fromUuidSync(uuid) : null;
    } catch (_error) {
        return null;
    }
}

function duplicateDocumentData(doc) {
    return doc?.toObject ? doc.toObject() : foundry.utils.deepClone(doc);
}

function folderMatchesPath(folder, path) {
    if (!folder) return false;
    const names = [];
    let current = folder;
    while (current) {
        names.unshift(current.name);
        current = current.folder;
    }
    return names.join(" / ").toLowerCase() === path || folder.name.toLowerCase() === path;
}

function stripHtml(html) {
    return String(html || "").replace(/<[^>]*>/g, "").trim();
}

function escapeHtml(value) {
    if (globalThis.foundry?.utils?.escapeHTML) return foundry.utils.escapeHTML(String(value ?? ""));
    return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[character]));
}

function parseNumber(value) {
    if (typeof value === "number") return value;
    const match = String(value ?? "").match(/-?\d[\d,]*(\.\d+)?/);
    return match ? Number(match[0].replace(/,/g, "")) : 0;
}

function clampNumber(value, min, max) {
    return Math.min(max, Math.max(min, Number(value || 0)));
}

function formatGp(value) {
    return `${Number(Math.floor(value || 0)).toLocaleString()} GP`;
}

function shuffleArray(values) {
    const copy = [...(values || [])];
    for (let index = copy.length - 1; index > 0; index--) {
        const target = Math.floor(Math.random() * (index + 1));
        [copy[index], copy[target]] = [copy[target], copy[index]];
    }
    return copy;
}

function stringsFromValue(value, depth = 0) {
    if (depth > 4 || value == null) return [];
    if (typeof value === "string" || typeof value === "number") return [String(value)];
    if (Array.isArray(value)) return value.flatMap(entry => stringsFromValue(entry, depth + 1));
    if (typeof value === "object") return Object.values(value).flatMap(entry => stringsFromValue(entry, depth + 1));
    return [];
}

function normalizeDiceFormula(formula) {
    return String(formula || "").replace(/\s+/g, " ").replace(/\s*([+-])\s*/g, " $1 ").trim();
}
