# Full Speed Ahead

**Full Speed Ahead** is a beta Foundry VTT module for tables that want starships, vehicles, and crewed craft to feel like a real game layer instead of oversized tokens.

It is a full homebrew vehicle replacement inspired by the feel of **Elite Dangerous**: ships have modules, shields, crew roles, scans, repairs, range bands, fuel, cargo trouble, thruster trails, movement audio, and combat tools built around the idea that a vessel is a living machine on the canvas.

This is not a rules-as-written automation module. Full Speed Ahead is for campaigns where the ship is a character, the crew has stations, damage hits systems, and the GM wants fast tools for running space encounters without opening six sheets and a calculator every turn.

## Beta Notice

Full Speed Ahead is actively evolving and should be treated as **beta software**. Back up your world before major updates, especially if you are using vehicle combat, crew initiative, shared capital, shield automation, or persistent ship profiles.

The module is already doing a lot. That also means it will keep changing as the vehicle stack gets cleaner, stranger, and more powerful.

## Installation

Use this manifest URL in Foundry's module installer:

```text
https://github.com/openkyle/full-speed-ahead/releases/latest/download/module.json
```

The Foundry module id is:

```text
full-speed-ahead
```

## What This Module Is

Full Speed Ahead turns Foundry vehicle actors into configurable spacecraft profiles.

A ship profile can define:

- Movement sound and volume.
- Thruster colors, cones, width, length, spacing, scale, and position.
- Bow orientation for ship art that faces north, east, south, or west.
- Smooth rotation behavior when the ship moves.
- Hover drift so ships feel suspended in space.
- Shield visuals and shield automation.
- Per-scene thruster scale adjustments for wildly different map/grid sizes.
- Vehicle combat behavior, crew initiative, and operation tools.

Tokens using the same ship profile can share behavior across scenes. If the ship leaves the world and later returns with the same profile, the configuration is still there.

## The Fantasy

Full Speed Ahead is built around a top-down ship-combat loop:

1. A craft moves across the starfield.
2. Its bow rotates toward the new vector.
3. Engines flare from the rear of the token with configurable exhaust cones.
4. Movement sound plays as the ship burns.
5. Shields glow while generators or Morphogenetic Fields still have HP.
6. Attacks strike shields first, then carry through into vulnerable modules.
7. Crew members act from their stations instead of the ship being one bland initiative entry.
8. The GM repairs, scans, mines, scoops fuel, burns heat sinks, jettisons cargo, and makes ships pristine from a purpose-built vehicle menu.

It is meant to make ship scenes feel like ship scenes.

## Major Systems

### Movement Effects

Full Speed Ahead can automate vehicle movement presentation:

- Smoothly rotate vehicles toward their movement destination.
- Treat the top of the token as the default bow, with configurable orientation offsets.
- Play per-profile movement audio.
- Draw faded thruster cones under moving ships.
- Support one to three thrust cones, each with independent width, length, color, and inversion.
- Keep the Primary Thrust centered while additional cones sit beside it.
- Tune thrusters live from the token HUD or settings panel.
- Store per-scene scale so ships can look right on maps with very different grids.

### Ship Profiles

Profiles are the heart of FSA.

Instead of configuring every token one by one, you configure a named ship profile. Multiple tokens can use that same profile, and profiles can be reused when ships return later.

Profiles control movement sound, thrusters, rotation, hover, and shield visuals. This lets one frigate roar with huge green exhaust while another glides with tiny blue maneuvering jets.

### Shields

FSA can automatically manage vehicle shields:

- Shield Generators create shield visuals while equipped and above 0 HP.
- Morphogenetic Fields create purple shield visuals.
- When shield HP hits 0, the shield effect drops.
- When the ship is repaired or healed, shield visuals can return.
- Damage is shield-first by default, with carryover into modules.
- The GM can still deliberately channel damage into a module when the story or ruling calls for it.

The built-in shield effect is designed to be a glow around the ship, with optional TokenMagic FX support for tables that use it.

### Vehicle Operations

FSA includes a floating vehicle operations menu for running ship encounters quickly.

Current operation areas include:

- **Attack Damage**: apply attack rolls, shield-first damage, and module damage.
- **Scan**: tactical, manifest, and wake scans.
- **Repair**: Repair Module, Stabilize Module, Full Service Repair and Replace, and GM-only Make Pristine.
- **Fuel Scooping**: resolve fuel scooping and Hydrogen Fuel handling.
- **Mining**: apply mining damage and related vehicle consequences.

The operations window has a vehicle dropdown, so the GM can open it even when no token is selected and choose the relevant ship from the current scene.

### Module Damage

Full Speed Ahead assumes ships are made of parts.

Equipment modules can have AC, HP, uses, and condition. Damage can strike vulnerable modules, destroy systems, create repair problems, and force crew decisions. Stabilizing a destroyed module restores it to 1 HP and equips it; repairing adds HP without automatically equipping a destroyed module.

This supports a more interesting damage model than "the vehicle has 143 HP, good luck."

### Crew Combat

Vehicle Combat Encounters can send crew to initiative instead of the vehicle.

FSA reads the ship's Cargo/Crew entries, attempts to match named crew to actors in the sidebar, and can generate placeholder actors for crew who have names but no actor yet.

Crew matching modes:

- **Match + Generate Actors**: match sidebar actors and generate placeholder actors for named crew without matches.
- **Match Actors Only**: match sidebar actors and omit anyone who does not have an actor.

Combat order display can show ship and crew imagery together, making it clear which ship a crew member is acting from.

### QuickTarget

Full Speed Ahead bundles QuickTarget behavior for fast range and target handling:

- Separate toggles for non-vehicle QuickTarget and Vehicle QuickTarget.
- Separate player and GM enablement.
- Optional replacement for Foundry's double-right-click targeting.
- Range labels with actor names and in/out-of-range status.
- Friendly and hostile crosshair behavior.
- Helper chat cards so players can attack without opening their sheets.
- Per-player hiding controls for character and vehicle helper cards.
- Escape and click-away clearing behavior.

If a standalone QuickTarget module is active, FSA is designed to avoid duplicate handlers.

### Vehicle Sheet Buttons

FSA can add ship tools directly onto supported vehicle sheets:

- TradeHub Markets access when TradeHub is installed and relevant.
- View Cargo.
- Long Rest.
- Registration.
- Chat Loadout.
- Fuel Release.

These buttons are configurable in FSA settings so you can decide how much of the vehicle stack belongs on the sheet.

### Shared Capital

Ship repair and maintenance can draw from a shared credit pool.

FSA can run this itself, but it is also designed to share the same capital resource with **TradeHub Markets** when TradeHub is installed.

That means repairs, upkeep, registration, and related vehicle costs do not need to live in two separate ledgers.

## TradeHub Markets

**TradeHub Markets** is recommended if you want the larger economy around Full Speed Ahead: markets, cargo, docking, shipyards, trade, banking, and campaign logistics.

When TradeHub is installed:

- TradeHub remains the primary market/economy module.
- FSA reads and writes the shared capital system.
- FSA can use TradeHub data where relevant, such as fuel and market resources.
- FSA avoids trying to become a second market module.

TradeHub is optional. Full Speed Ahead can still run vehicle movement, targeting, shields, operations, and fallback capital without it.

## Optional Integrations

Full Speed Ahead can integrate with:

- **TradeHub Markets** for shared capital, markets, cargo, fuel, and economy.
- **TokenMagic FX** for optional shield and damage visuals.
- **Item Piles** for optional cargo jettison piles.
- **Tidy5e Sheet** for supported vehicle sheet placement and cosmetic labels.
- **Standalone QuickTarget** for campaigns that separate targeting from FSA.

## Requirements

- Foundry VTT v10 minimum.
- Verified against Foundry VTT v11.312.
- A game system with vehicle actors and D&D5e-style item/module data is expected.

## Status

Full Speed Ahead is a large, opinionated homebrew module in active beta.

It is best for GMs who want starship encounters to be loud, visual, mechanical, and a little dangerous: shields flickering, modules breaking, crew scrambling, engines burning, scanners pinging, and the ship itself feeling like a thing worth fighting for.
