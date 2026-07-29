// vehicle-operations.js: Full Speed Ahead vehicle damage, scans, repairs, and heat-sink operations.

const FSA_MODULE_ID = "full-speed-ahead";
const FSA_SOCKET = `module.${FSA_MODULE_ID}`;
const FSA_DESTROYED_FLAG = "destroyedUnequipped";
const FSA_HEAT_SINK_CARD_SELECTOR = "[data-fsa-heat-sink], [data-fsa-heat-sink-no]";
const FSA_STRUCTURAL_SYNC_DELAY_MS = 500;
const FSA_DEFAULT_DATA = { pendingCarryover: {} };
const FSA_REPAIR_ACTIONS = new Set(["heal", "full-service", "pristine"]);
const FSA_DAMAGE_CONTEXTS = new Set(["attack", "fuel", "mining"]);
const fsaVehicleSyncTimers = new Map();

class TradeHubIntegrationAdapter {
    static isAvailable() {
        return Boolean(game.modules?.get("tradehub-markets")?.active);
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

    static capitalAvailable() {
        return this.isAvailable() && typeof this.data().capital !== "undefined";
    }

    static capital() {
        return Number(this.data().capital || 0);
    }

    static async setCapital(value) {
        if (!this.capitalAvailable()) throw new Error("TradeHub billing is unavailable.");
        const data = this.data();
        data.capital = Math.max(0, Number(value || 0));
        await game.settings.set("tradehub-markets", "data", data);
    }

    static repairCostPerHp() {
        return Number(this.setting("repairCostPerHp", game.settings.get(FSA_MODULE_ID, "vehicleOpsRepairCostPerHp")) || 0);
    }

    static repairCostPerShieldPoint() {
        return Number(this.setting("repairCostPerShieldPoint", game.settings.get(FSA_MODULE_ID, "vehicleOpsRepairCostPerShieldPoint")) || 0);
    }

    static isGlaxonInsured(actor) {
        return actor?.getFlag?.("tradehub-markets", "glaxonInsured") === true || actor?.getFlag?.(FSA_MODULE_ID, "glaxonInsured") === true;
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
    static current() {
        if (!game.settings.get(FSA_MODULE_ID, "vehicleOpsEnabled")) {
            ui.notifications.warn("Full Speed Ahead vehicle operations are disabled.");
            return null;
        }
        const targeted = Array.from(game.user?.targets ?? []).find(token => token?.actor?.type === "vehicle");
        const controlled = canvas?.tokens?.controlled?.find(token => token?.actor?.type === "vehicle");
        const token = targeted || controlled;
        if (!token?.actor || token.actor.type !== "vehicle") {
            ui.notifications.warn("Target or select a vehicle token first.");
            return null;
        }
        const modules = VehicleModuleService.damageableModules(token.actor);
        if (!modules.length) {
            ui.notifications.warn(`${token.actor.name} has no equipped, HP-bearing vehicle modules.`);
            return null;
        }
        return this.packToken(token);
    }

    static packToken(token) {
        return {
            actorId: token.actor?.id || token.document?.actorId || "",
            actorUuid: token.actor?.uuid || "",
            sceneId: token.scene?.id || canvas?.scene?.id || "",
            tokenId: token.document?.id || "",
            tokenUuid: token.document?.uuid || "",
            name: token.name || token.actor?.name || ""
        };
    }

    static resolve(payload = {}) {
        const scene = payload.sceneId ? game.scenes.get(payload.sceneId) : null;
        const tokenDocument = payload.tokenId && scene ? scene.tokens.get(payload.tokenId) : null;
        const actor = tokenDocument?.actor || (payload.actorUuid ? fromUuidSyncSafe(payload.actorUuid) : null) || game.actors.get(payload.actorId);
        return { scene, tokenDocument, actor };
    }
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

    static findModule(actor, pattern) {
        return Array.from(actor?.items ?? []).find(item => this.isEquippedShipModule(item) && pattern.test(item.name || "") && this.itemMaxHp(item) > 0);
    }

    static firstHealthyHull(actor) {
        return this.damageableModules(actor).find(item => /hull reinforcements?/i.test(item.name || "") && this.itemHp(item) > 0);
    }

    static heatSink(actor) {
        return Array.from(actor?.items ?? []).find(item => /heat sink/i.test(item.name || "") && Number(item.system?.quantity ?? 1) > 0);
    }

    static async consumeHeatSink(actor) {
        const heatSink = this.heatSink(actor);
        if (!heatSink) return false;
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

    static currentModuleHpTotal(actor) {
        return this.damageableModules(actor).reduce((sum, item) => sum + Math.max(0, Math.min(this.itemHp(item), this.itemMaxHp(item))), 0);
    }

    static async syncVehicleHpFromModules(actor) {
        const modules = this.damageableModules(actor);
        const total = modules.reduce((sum, item) => sum + this.itemHp(item), 0);
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
        const items = Array.from(actor?.items ?? []).filter(item => ["consumable", "loot"].includes(item.type));
        const current = items.reduce((total, item) => total + Number(item.system?.weight || 0) * Number(item.system?.quantity || 0), 0);
        return { max: base, current, remaining: base - current };
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
            const fuelScoop = actor.items.get(payload.targetModule) || VehicleModuleService.findModule(actor, /fuel scoop/i);
            if (!fuelScoop) throw new Error("No Fuel Scoop module found for fuel scooping damage.");
            remaining = await this.applyToModule(state, fuelScoop, remaining);
            if (remaining > 0) await this.applyCarryover(state, remaining, fuelScoop.name);
        } else if (context === "mining") {
            const shield = VehicleModuleService.findModule(actor, /shield generator|shield/i);
            const hull = VehicleModuleService.firstHealthyHull(actor);
            const selected = payload.targetModule && payload.targetModule !== "evenly" ? actor.items.get(payload.targetModule) : null;
            const target = selected || VehicleModuleService.findModule(actor, /refinery/i) || (VehicleModuleService.itemHp(shield) > 0 ? shield : null) || hull;
            if (target) {
                remaining = await this.applyToModule(state, target, remaining);
                if (remaining > 0) await this.applyCarryover(state, remaining, target.name);
            } else {
                await this.applyCarryover(state, remaining, "asteroid debris impact");
            }
        } else {
            const shield = VehicleModuleService.findModule(actor, /shield generator|shield/i);
            if (VehicleModuleService.itemHp(shield) > 0) {
                const before = VehicleModuleService.itemHp(shield);
                const dealt = Math.min(before, remaining);
                await VehicleModuleService.updateModuleHp(shield, before - dealt);
                state.details.push(`${escapeHtml(shield.name)} hit for ${dealt} HP`);
                remaining -= dealt;
                if (VehicleModuleService.itemHp(shield) <= 0) state.details.push(`<b>${escapeHtml(shield.name)} is depleted! Shields are down!</b>`);
                if (remaining > 0) await this.applyCarryover(state, remaining, shield.name);
            } else {
                const selected = payload.targetModule && payload.targetModule !== "evenly" ? actor.items.get(payload.targetModule) : null;
                const hull = VehicleModuleService.firstHealthyHull(actor);
                const target = selected || hull;
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
        const label = damageType === "thermal" ? "Thermal" : "Hull";
        await VehicleChatCardService.create({
            user: userId,
            speaker: { alias: "Full Speed Ahead Combat Damage" },
            content: `<b style="color:red;">${escapeHtml(actor.name)} suffers ${damage} ${label} Damage!</b><br><b>Attack was AC: ${attack || "N/A"}</b><br>${state.details.concat(state.destroyed.length ? ["", ...state.destroyed] : []).join("<br>")}${state.prompts.length ? `<br><br>${state.prompts.join("<br>")}` : ""}`
        });
        TradeHubIntegrationAdapter.refreshTradeHub();
    }

    static async applyToModule(state, module, amount) {
        if (!module || amount <= 0 || VehicleModuleService.itemHp(module) <= 0) return amount;
        const before = VehicleModuleService.itemHp(module);
        const dealt = Math.min(before, amount);
        const after = before - dealt;
        await VehicleModuleService.updateModuleHp(module, after);
        const line = after <= 0 ? `<b>${escapeHtml(module.name)} hit for ${dealt} HP and is destroyed!</b>` : `${escapeHtml(module.name)} hit for ${dealt} HP`;
        (after <= 0 ? state.destroyed : state.details).push(line);
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
            if (before > 0 && after <= 0 && /cargo bay/i.test(module.name || "")) await this.handleCargoFailure(state, module.name, dealt);
        }
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
        const action = FSA_REPAIR_ACTIONS.has(payload.action) ? payload.action : "heal";
        if (action === "pristine") {
            await VehicleModuleService.syncVehicleStatsFromModules(actor, { restore: true, chat: true, reason: "Manual GM repair tab refresh", userId });
        } else if (action === "full-service") {
            await this.fullService(actor, { billCapital: payload.billCapital !== false, userId });
        } else {
            await this.ability(actor, payload.targetModule, payload.hp, userId);
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

    static async ability(actor, targetModule, hpToAdd, userId) {
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
                const add = Math.min(remaining, Math.max(0, VehicleModuleService.itemMaxHp(item) - VehicleModuleService.itemHp(item)));
                if (add > 0) {
                    await VehicleModuleService.restoreModuleHp(item, VehicleModuleService.itemHp(item) + add);
                    addDetail(item, add);
                    remaining -= add;
                }
            }
        } else {
            let pool = VehicleModuleService.repairableModules(actor).filter(item => !VehicleModuleService.isShield(item) && VehicleModuleService.itemHp(item) < VehicleModuleService.itemMaxHp(item));
            while (remaining > 0 && pool.length) {
                for (const item of [...pool]) {
                    if (remaining <= 0) break;
                    const add = Math.min(1, VehicleModuleService.itemMaxHp(item) - VehicleModuleService.itemHp(item));
                    if (add > 0) {
                        await VehicleModuleService.restoreModuleHp(item, VehicleModuleService.itemHp(item) + add);
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
}

class VehicleScanService {
    static async scan(payload, userId) {
        if (!game.settings.get(FSA_MODULE_ID, "vehicleOpsScansEnabled")) throw new Error("Vehicle scans are disabled.");
        const { actor } = VehicleTargetResolver.resolve(payload);
        if (!actor || actor.type !== "vehicle") throw new Error("Selected vehicle not found.");
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
        const candidates = [item.system?.source?.custom, item.system?.details?.source?.custom, item.system?.formula, item.system?.description?.value, item.system?.description?.chat, ...stringsFromValue(item.system)];
        for (const text of candidates) {
            const plain = stripHtml(text);
            const match = plain.match(/(\d+d\d+(?:\s*[+-]\s*\d+)?)\s*(?:LY|light\s*years?)/i) || plain.match(/^\s*(\d+d\d+(?:\s*[+-]\s*\d+)?)\s*$/i);
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
    }

    static async handle(message) {
        if (message?.type !== "vehicleOperationsRequest" || !game.user.isGM) return;
        await this.process(message);
    }

    static async process(message) {
        try {
            if (!game.settings.get(FSA_MODULE_ID, "vehicleOpsEnabled")) throw new Error("Full Speed Ahead vehicle operations are disabled.");
            if (message.action === "applyVehicleDamage") return VehicleDamageService.apply(message.payload, message.userId);
            if (message.action === "performVehicleScan") return VehicleScanService.scan(message.payload, message.userId);
            if (message.action === "repairVehicle") return VehicleRepairService.repair(message.payload, message.userId);
            if (message.action === "grantHydrogenFuel") return VehicleFuelService.grant(message.payload, message.userId);
            if (message.action === "deployHeatSink") return VehicleHeatSinkService.resolve(message.payload.choiceId, true, message.userId, message.payload.messageId);
            if (message.action === "declineHeatSink") return VehicleHeatSinkService.resolve(message.payload.choiceId, false, message.userId, message.payload.messageId);
        } catch (error) {
            console.error(`${FSA_MODULE_ID} | Vehicle operation failed.`, error);
            ui.notifications.error(error.message || "Vehicle operation failed.");
        }
    }
}

class VehicleOperationsApplication extends FormApplication {
    static current = null;

    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "full-speed-ahead-vehicle-operations",
            title: "Full Speed Ahead: Vehicle Operations",
            template: `modules/${FSA_MODULE_ID}/templates/vehicle-operations.hbs`,
            width: 560,
            height: "auto",
            closeOnSubmit: false,
            submitOnChange: false,
            tabs: [{ navSelector: ".fsa-vehicle-ops-tabs", contentSelector: ".fsa-vehicle-ops-body", initial: "attack" }]
        });
    }

    static open() {
        const target = VehicleTargetResolver.current();
        if (!target) return null;
        if (this.current) this.current.close();
        this.current = new this(target);
        this.current.render(true);
        return this.current;
    }

    get target() {
        return this.object;
    }

    get actor() {
        return VehicleTargetResolver.resolve(this.target).actor;
    }

    getData() {
        const actor = this.actor;
        const rolls = lastAttackAndDamageRolls();
        const shield = VehicleModuleService.findModule(actor, /shield generator|shield/i);
        const shieldsUp = VehicleModuleService.itemHp(shield) > 0;
        const hull = VehicleModuleService.firstHealthyHull(actor);
        const fuelScoop = VehicleModuleService.findModule(actor, /fuel scoop/i);
        const refinery = VehicleModuleService.findModule(actor, /refinery/i);
        const modules = VehicleModuleService.damageableModules(actor).sort((a, b) => VehicleModuleService.itemAc(a) - VehicleModuleService.itemAc(b) || a.name.localeCompare(b.name));
        const options = this.moduleOptions(modules, hull, shieldsUp, shield, fuelScoop, refinery);
        const repairPreview = VehicleRepairService.preview(actor);
        return {
            target: this.target,
            targetName: actor.name,
            shieldsUp,
            shieldStatus: shieldsUp ? "Shields Up" : "Shields Down",
            shieldText: shieldsUp ? `${actor.name} is being attacked. Shields are up, so damage will hit shields first.` : `${actor.name} is being attacked. No shields are active, so damage will go to hull protection before vulnerable modules.`,
            attack: rolls.attack ?? "",
            damage: rolls.damage ?? 0,
            fuelYield: rolls.fuelYield ?? 0,
            destinations: TradeHubIntegrationAdapter.locations().map(name => ({ name })),
            tradeHubCapital: TradeHubIntegrationAdapter.capitalAvailable() ? formatGp(TradeHubIntegrationAdapter.capital()) : "Unavailable",
            repairEstimate: formatGp(repairPreview.total),
            repairRawEstimate: formatGp(repairPreview.rawTotal),
            repairAfter: TradeHubIntegrationAdapter.capitalAvailable() ? formatGp(TradeHubIntegrationAdapter.capital() - repairPreview.total) : "Unavailable",
            insured: repairPreview.insured,
            savings: formatGp(repairPreview.rawTotal - repairPreview.total),
            ...options
        };
    }

    moduleOptions(modules, hull, shieldsUp, shield, fuelScoop, refinery) {
        const base = modules.map(item => ({ id: item.id, label: `AC ${VehicleModuleService.itemAc(item)} - ${item.name}` }));
        const evenly = { id: "evenly", label: "Evenly Among Vulnerable Modules", selected: !hull };
        return {
            attackModules: shieldsUp && shield
                ? modules.map(item => ({ id: item.id, label: `AC ${VehicleModuleService.itemAc(item)} - ${item.name}${item.id === shield?.id ? " (Shields absorb first)" : ""}`, selected: item.id === shield?.id }))
                : [evenly].concat(base.map(option => ({ ...option, selected: option.id === hull?.id }))),
            fuelModules: base.map(option => ({ ...option, selected: option.id === fuelScoop?.id })),
            miningModules: [{ id: "evenly", label: "Evenly Among Vulnerable Modules", selected: !refinery && !shieldsUp && !hull }].concat(base.map(option => ({ ...option, selected: option.id === (refinery || (shieldsUp ? shield : null) || hull)?.id }))),
            repairModules: [{ id: "evenly", label: "Distribute Across Damaged Modules", selected: true }].concat(base)
        };
    }

    activateListeners(html) {
        super.activateListeners(html);
        html.find("[data-action]").on("click", event => {
            event.preventDefault();
            const action = event.currentTarget.dataset.action;
            if (action === "apply-damage") return this.submitDamage(html, "attack");
            if (action === "apply-fuel-damage") return this.submitDamage(html, "fuel");
            if (action === "apply-mining-damage") return this.submitDamage(html, "mining");
            if (action === "scan") return this.submitScan(html);
            if (action === "repair") return this.submitRepair(html);
            if (action === "grant-fuel") return this.submitFuel(html);
        });
        html.find('[name="repairAction"]').on("change", () => this.updateRepairMode(html));
        html.find('[name="scanType"]').on("change", () => this.updateScanMode(html));
        this.updateRepairMode(html);
        this.updateScanMode(html);
    }

    submitDamage(html, context) {
        const prefix = context === "attack" ? "" : `${context}-`;
        VehicleOperationsSocketService.request("applyVehicleDamage", { ...this.target, context, damageType: html.find(`[name="${prefix}damageType"]`).val(), attack: Number(html.find(`[name="${prefix}attack"]`).val() || 0), damage: Math.max(0, Number(html.find(`[name="${prefix}damage"]`).val() || 0)), targetModule: html.find(`[name="${prefix}targetModule"]`).val() || "evenly" });
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
        const full = html.find('[name="repairAction"]').val() === "full-service";
        html.find("[data-repair-hp-row]").toggle(!full);
        html.find("[data-repair-bill-row]").toggle(full);
    }

    updateScanMode(html) {
        html.find("[data-scan-destination]").toggle(html.find('[name="scanType"]').val() === "wake");
    }

    async close(options) {
        if (VehicleOperationsApplication.current === this) VehicleOperationsApplication.current = null;
        return super.close(options);
    }

    async _updateObject() {}
}

Hooks.once("init", () => {
    registerVehicleOpsSettings();
});

Hooks.once("ready", () => {
    VehicleOperationsSocketService.init();
    game.fullSpeedAhead = game.fullSpeedAhead || {};
    game.fullSpeedAhead.vehicleOperations = { open: () => VehicleOperationsApplication.open() };
    game.fullSpeedAhead.openVehicleOperations = () => VehicleOperationsApplication.open();
});

Hooks.on("getSceneControlButtons", controls => {
    if (!game.user.isGM && !game.settings.get(FSA_MODULE_ID, "vehicleOpsPlayersCanOpen")) return;
    const tokenControls = Array.isArray(controls) ? controls.find(control => control.name === "token") : controls?.token;
    const tools = Array.isArray(tokenControls?.tools) ? tokenControls.tools : null;
    if (!tools || tools.some(tool => tool.name === "full-speed-ahead-vehicle-operations")) return;
    tools.push({
        name: "full-speed-ahead-vehicle-operations",
        title: "Full Speed Ahead Vehicle Operations",
        icon: "fas fa-bomb",
        button: true,
        onClick: () => VehicleOperationsApplication.open()
    });
});

Hooks.on("renderChatMessage", (message, html) => {
    html.find(FSA_HEAT_SINK_CARD_SELECTOR).on("click", event => {
        event.preventDefault();
        const button = event.currentTarget;
        VehicleOperationsSocketService.request(button.dataset.fsaHeatSinkNo !== undefined ? "declineHeatSink" : "deployHeatSink", { choiceId: button.dataset.choiceId, messageId: message.id });
    });
});

Hooks.on("createItem", (item, options, _userId) => {
    if (shouldScheduleVehicleModuleSync(item, options)) VehicleModuleService.scheduleStructuralSync(item.parent, "Module created");
});
Hooks.on("deleteItem", (item, options, _userId) => {
    if (shouldScheduleVehicleModuleSync(item, options)) VehicleModuleService.scheduleStructuralSync(item.parent, "Module deleted");
});
Hooks.on("updateItem", (item, changes, options) => {
    if (!shouldScheduleVehicleModuleSync(item, options)) return;
    const relevant = ["system.equipped", "system.hp.max", "system.armor.value", "system.ac.value", "system.price", "system.price.value", "name"].some(path => foundry.utils.hasProperty(changes, path) || Object.prototype.hasOwnProperty.call(changes, path));
    if (relevant) VehicleModuleService.scheduleStructuralSync(item.parent, "Module changed");
});

function shouldScheduleVehicleModuleSync(item, options = {}) {
    if (options?.fullSpeedAheadVehicleOperation) return false;
    if (item?.parent?.type !== "vehicle") return false;
    return VehicleModuleService.isShipModuleItem(item) || ["equipment", "weapon"].includes(item.type);
}

function registerVehicleOpsSettings() {
    const register = (key, data) => game.settings.register(FSA_MODULE_ID, key, { scope: "world", config: true, ...data });
    register("vehicleOperationsData", { name: "Vehicle Operations Data", type: Object, default: foundry.utils.deepClone(FSA_DEFAULT_DATA), config: false });
    register("vehicleOpsEnabled", { name: "Enable Vehicle Operations", hint: "Enable Full Speed Ahead's Apply Damage, Fuel Scooping, Mining Damage, Scans, Repair Ship, Heat Sink, and cargo failure tools.", type: Boolean, default: true });
    register("vehicleOpsPlayersCanOpen", { name: "Players Can Open Vehicle Operations", hint: "Allow non-GM users to open the vehicle operations window. Mutations still execute through the GM.", type: Boolean, default: true });
    register("vehicleOpsScansEnabled", { name: "Enable Vehicle Operation Scans", hint: "Allow Tactical, Manifest, and Wake scans from the vehicle operations window.", type: Boolean, default: true });
    register("vehicleOpsRepairCostPerHp", { name: "Fallback Repair Cost Per Module HP", hint: "Used when TradeHub is unavailable or does not expose a repair HP cost.", type: Number, default: 100 });
    register("vehicleOpsRepairCostPerShieldPoint", { name: "Fallback Repair Cost Per Shield HP", hint: "Used when TradeHub is unavailable or does not expose a shield repair HP cost.", type: Number, default: 100 });
    register("vehicleOpsTokenMagicDamage", { name: "Use TokenMagic Damage Bursts", hint: "If TokenMagic FX is installed, show splash damage filters when vehicle modules take damage.", type: Boolean, default: true });
    register("vehicleOpsItemPilesJettison", { name: "Use Item Piles for Cargo Jettison", hint: "If Item Piles is installed, create cargo piles near the vehicle when Cargo Bay failure jettisons cargo.", type: Boolean, default: true });
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
