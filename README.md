# Full Speed Ahead

**Full Speed Ahead** is a beta Foundry VTT module for running homebrew vehicle and starship play with an **Elite Dangerous-inspired** feel: ships turn, drift, burn, scan, mine, repair, manage shields, and carry crew into combat as more than ordinary vehicle tokens.

This is not a rules-as-written automation module. It is a complete homebrew vehicle layer meant for tables that want ships to feel like active craft on the canvas, with persistent named profiles, shared ship resources, crew roles, module damage, shields, and fast targeting tools.

## Beta Notice

Full Speed Ahead is actively evolving and should be treated as **beta software**. Expect frequent updates, setting changes, and occasional rough edges while the vehicle combat stack is refined. Back up your world before major updates, especially if you are using vehicle combat, shared capital, crew initiative, or per-ship movement profiles.

## Installation

Use the latest manifest URL in Foundry's module installer:

```text
https://github.com/openkyle/full-speed-ahead/releases/latest/download/module.json
```

## Core Idea

Full Speed Ahead turns vehicle actors into named spacecraft profiles. A ship can have its own movement sound, thruster layout, hover behavior, bow orientation, shield visuals, repair costs, shared credit access, and combat handling. Tokens with the same ship profile can inherit the same configuration across scenes.

The module is designed around a top-down space-combat loop:

1. Choose or move a vehicle token.
2. The craft rotates toward its path and moves with configurable sound and exhaust.
3. Shields, module HP, and visual effects reflect the ship's current condition.
4. Vehicle operations handle attacks, scans, repairs, mining, fuel scooping, heat sinks, and cargo failures.
5. Crew can enter initiative instead of the vehicle, making each ship role matter in combat.

## Major Features

- Smooth vehicle rotation toward movement direction, including bow-facing orientation for north/east/south/west ship art.
- Per-profile movement sound, volume, thruster cones, scale, position, width, length, colors, and inversion.
- Multi-cone thruster layouts with a centered Primary Thrust plus optional additional thrust cones.
- Under-token thruster rendering and live tuning from the vehicle HUD gear.
- Optional hover motion for vehicle tokens, with per-ship timing offsets so ships do not float in sync.
- Vehicle shield automation for Shield Generators and Morphogenetic Fields.
- Built-in shield glow visuals, with optional TokenMagic FX support.
- Vehicle Operations floating menu for Attack Damage, Scan, Repair, Fuel Scooping, and Mining.
- Operations window can open even when no vehicle token is selected; choose the vehicle from the scene dropdown.
- Module damage, shield-first damage routing, carryover damage, destroyed/unequipped module handling, and repair/stabilization tools.
- Heat Sink prompts for avoiding thermal carryover or cargo loss.
- Optional Item Piles cargo drops when a cargo bay failure jettisons goods.
- Long Rest, Registration, Chat Loadout, and Fuel Release buttons on vehicle sheets.
- GM-only Make Pristine tool for fully restoring a ship without billing shared capital.
- Glaxon insurance support for discounted repair costs.
- Shared capital ledger for repairs, registration, upkeep, and ship maintenance.
- Vehicle Combat Encounters mode that sends crew members to initiative instead of the vehicle.
- Crew matching by Cargo/Crew entries, with optional placeholder actors when a match cannot be found.
- Custom combat tracker display for crew aboard ships.
- QuickTarget tools for character and vehicle targeting, range labels, helper chat cards, and optional double-right-click replacement.
- Vehicle sheet cosmetic options for labels such as Module Capacity and Ship Functions.

## Vehicle Movement

Movement Effects are configured from the FSA settings hub or the blue gear on a vehicle token HUD.

The main tabs are:

- **General**: ship profile, orientation, and movement sound.
- **Thrusters**: exhaust color, scale, position, cone count, cone dimensions, spacing, and inversion.
- **Rotation**: enable movement rotation, smooth rotation, update interval, finish distance, and rotation offset.
- **Hover**: vehicle hover effect, X/Y offset, speed, and desynced timing.
- **Shields**: shield automation and visual behavior for shield generators and Morphogenetic fields.

Ship profiles let multiple tokens share the same movement and effect behavior. This is useful when the same named craft appears on multiple scenes or is dragged back into the world later.

## Vehicle Operations

The FSA floating menu gives quick access to the vehicle operations stack:

- **Attack Damage**: apply shield-first or deliberately channeled module damage.
- **Scan**: run tactical, manifest, or wake scans.
- **Repair**: apply Repair Module, Stabilize Module, Full Service Repair and Replace, or GM-only Make Pristine.
- **Fuel Scooping**: apply fuel scoop damage and grant Hydrogen Fuel.
- **Mining**: resolve mining damage against ship modules.

The operations panel includes a vehicle dropdown populated from the current scene, with player vehicles sorted first. This means the menu can open even when no token is selected.

## Shared Capital

Full Speed Ahead uses a single shared credit ledger for ship costs. It is intentionally compatible with **TradeHub Markets**:

- If TradeHub Markets is active, FSA reads and writes TradeHub's internal capital.
- If TradeHub Markets is not active, FSA stores the same shared capital locally.
- If FSA was used without TradeHub and TradeHub is later enabled, FSA can seed TradeHub from the fallback balance.
- When TradeHub has an existing capital value, TradeHub wins and FSA mirrors it locally.

The FSA settings hub includes a compact **Shared Capital** panel for Add, Subtract, and Replace actions. This is a smaller version of the banking behavior used by TradeHub, intended for worlds that want FSA vehicle operations without the full market module.

## TradeHub Markets

TradeHub Markets is recommended if you want the larger economy loop around Full Speed Ahead: markets, cargo, banking, docking, shipyards, restock, and related campaign infrastructure.

When TradeHub is installed, FSA integrates with it instead of creating a competing economy:

- TradeHub remains the source of internal capital.
- FSA can bill TradeHub capital for repairs, upkeep, registration, and insurance.
- FSA can read TradeHub market data where relevant, such as Hydrogen Fuel sources and known destinations.
- FSA refreshes TradeHub windows after vehicle operations that affect shared resources.

TradeHub is optional. FSA can run without it, but the broader commerce and market experience belongs in TradeHub.

## QuickTarget

Full Speed Ahead includes bundled QuickTarget behavior for tables that want fast targeting and range feedback:

- Separate enablement for non-vehicle QuickTarget and Vehicle QuickTarget.
- Separate player and GM controls.
- Range labels with actor names and in/out-of-range status.
- Friendly and hostile crosshair behavior.
- Optional helper chat cards with attack buttons.
- Per-player options to hide helper chat cards.
- Escape/click-away behavior to clear targeting overlays.

If a standalone QuickTarget module is active, Full Speed Ahead enters cooperative mode and avoids installing duplicate targeting handlers.

## Vehicle Combat Encounters

FSA can replace a vehicle combatant with its crew in the initiative tracker. It reads the vehicle's Cargo/Crew information, attempts to match crew names to sidebar actors, and can generate placeholder actors for non-matches if configured.

This supports a ship-as-stations style encounter, where the pilot, gunner, engineer, sensor expert, quartermaster, and other roles act in initiative rather than treating the whole ship as a single turn.

## Optional Integrations

Full Speed Ahead works on its own, but can integrate with:

- **TradeHub Markets**: shared capital, destinations, Hydrogen Fuel data, market/campaign economy.
- **TokenMagic FX**: optional shield and damage burst visuals.
- **Item Piles**: optional cargo-drop piles when cargo is jettisoned.
- **Tidy5e Sheet**: supported vehicle sheet placement and cosmetic label changes.
- **Standalone QuickTarget**: FSA detects it and avoids duplicate handlers.

## Requirements

- Foundry VTT v10 minimum.
- Verified against Foundry VTT v11.312.
- A system that supports `vehicle` actor types and D&D5e-style item/module data is expected.

## Module ID

The Foundry module id is:

```text
full-speed-ahead
```

The visible module title is **Full Speed Ahead**.
