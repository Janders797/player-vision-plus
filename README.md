# Player Vision Plus

Player Vision Plus is a Foundry VTT module for player-facing secondary token vision.

It is inspired by the token-highlighting behavior of **GM Vision**, but aimed at players: when a player has access to multiple tokens, or when party sharing is enabled, tokens visible to eligible secondary player-owned tokens can still be shown with a GM-Vision-style detection filter.

Player Vision Plus is intentionally **token-only**. It keeps Foundry's normal Fog of War intact and does **not** reveal additional map areas.

## Features

- Shows tokens visible to other eligible player-owned tokens.
- Supports a player's own additional tokens, such as familiars or companions.
- Optional party/shared vision between player-owned tokens.
- Keeps Fog of War and map visibility unchanged.
- Uses Foundry-style line of sight checks for secondary visibility.
- Respects darkness, Darkvision and illumination for hostile tokens.
- Checks light obstruction by walls.
- GM/world setting acts as a maximum permission.
- Player-side personal opt-in menu.
- German and English localization.

## How it works

The module does not expand a player's visible map area. Instead, it checks whether a token would be visible to eligible secondary player-owned vision sources. If yes, that token is displayed with a detection-filter style.

A player only receives Player Vision Plus if both conditions are true:

1. The GM/world setting allows Player Vision Plus.
2. The player has enabled their personal opt-in.

## Settings

### GM / World settings

- **Enable Player Vision Plus for players**  
  World-level maximum. If disabled, Player Vision Plus is inactive for all players.

- **Share greyed vision between players**  
  If enabled, tokens owned by other non-GM players can also act as eligible secondary vision sources. If disabled, only the current player's own tokens count.

### Player setting

Players have a dedicated **Player Vision Plus** settings menu with their personal opt-in.

The effective behavior is:

```text
World enabled && Player enabled
```

## Debug helpers

When debug logging is enabled, these console helpers are available:

```js
PlayerVisionPlusDebug()
PlayerVisionPlusTraceTarget("The Enemy")
PlayerVisionPlusTraceLights("The Enemy")
```

These are useful for testing line of sight, illumination and secondary vision decisions.

## Known limitations

- Tokens that physically clip into walls, or walls and tokens that are not grid-aligned, can produce edge cases that differ slightly from Foundry's native visibility behavior.
- The module is token-only; it does not reveal or share explored Fog of War areas.
- The module currently targets Foundry VTT v13+ and has been tested on Foundry VTT v14.

## Installation

### Manual installation

1. Download the latest `player-vision-plus.zip` from the GitHub releases page.
2. Extract it into your Foundry VTT `Data/modules/` directory.
3. Ensure the folder name is exactly:

```text
player-vision-plus
```

4. Restart Foundry VTT.
5. Enable **Player Vision Plus** in your world.

### Manifest installation

After the first GitHub release is published, use this manifest URL in Foundry's module installer:

```text
https://raw.githubusercontent.com/Janders797/player-vision-plus/main/module.json
```

## License

MIT License. See [LICENSE](LICENSE).

## Credits

Conceptually inspired by **GM Vision** by dev7355608.
