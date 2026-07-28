# Full Speed Ahead

Vehicle movement helpers for Foundry VTT.

Full Speed Ahead rotates vehicle tokens toward their movement destination, can sequence rotation before movement, plays movement sound effects, adds configurable thruster trails, and bundles QuickTarget for fast combat targeting.

## Features

- Automatically rotates actor tokens with type `vehicle`.
- Smooth shortest-path rotation during the first few grid spaces of movement.
- Configurable rotation update interval, finish distance, and bow-facing orientation for different ship art directions.
- Movement sound effect with configurable path and volume.
- Under-token PIXI thruster cone rendered in the scene below the ship art with configurable color, length, and width.
- Profile-wide thrust shapes keep matching ship names consistent across scenes, with Primary Thrust always centered.
- Movement effects settings menu with an audio browse button and thruster color picker.
- Blue vehicle Token HUD gear for opening the Movement Effects menu from the right-click overlay.
- Name-keyed ship profiles for exhaust color overrides shared by every vehicle with the same name.
- Vehicle Sheet Cosmetics panel with optional Creature Capacity to Module Capacity and Features to Ship Functions label changes.
- Global Vehicle Hover Effect panel for X offset, Y offset, and speed, with per-vehicle desynced hover timing.
- Vehicle Combat Settings panel with an optional mode that sends vehicle crew to combat instead of the vehicle combatant.
- Optional vehicle shield automation reads Shield Generator equipment HP and keeps TokenMagic shield glow online/offline.
- Movement sounds are broadcast once by the movement initiator to avoid doubled playback.
- Independent character/non-vehicle and vehicle QuickTarget controls for players and GMs.
- Token-control QuickTarget button for GMs and players.
- QuickTarget settings gear for GM/player enablement, timeout, double-right-click replacement, and per-player helper chat-card visibility.
- Cooperative mode: if a standalone QuickTarget module is active, Full Speed Ahead leaves its bundled QuickTarget handlers idle to avoid duplicate targeting events.

## Install

Use the manifest URL from the latest release:

```text
https://github.com/openkyle/full-speed-ahead/releases/latest/download/module.json
```

## Notes

The Foundry module id remains `full-speed-ahead` because module ids should stay lowercase and URL-safe. The visible module title is **Full Speed Ahead**.
