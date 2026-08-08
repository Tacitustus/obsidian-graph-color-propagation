# Graph Color Propagation

> **[日本語ドキュメント / Japanese Documentation](README.ja.md)**
> 
> **[Qiita](https://qiita.com/Tacitustus/items/8b97cbf8314fd453d047)**

Propagates graph node colors to uncolored nodes based on their connections.

Define color groups in Obsidian's built-in **Graph view → Groups** panel as usual — this plugin reads those groups and automatically spreads their colors to nearby notes that don't have a group of their own, based on how closely they're linked. No extra configuration files or query syntax to learn.

## Features

- **Automatic color propagation** — notes without a matching group inherit a blended color from linked notes that do, weighted by distance (number of hops) and the number of paths that reach them.
- **Live sync with Graph view groups** — as soon as you add, edit, or remove a color group in the Graph view settings, the plugin detects the change and re-applies colors immediately. No button press needed.
- **Adjustable propagation** — control how far colors spread and how strong the effect is via the decay factor, max hops, and minimum influence settings.
- **Manual controls** — a ribbon icon, a command palette command, and an "Apply now" button in settings are all available if you want to trigger propagation by hand.

## How it works

1. The plugin reads the color groups you've defined in Graph view (**Settings → Graph view → Groups**), matching either `path:` or `tag:` queries.
2. It builds a graph of your notes based on their links (`[[wikilinks]]`).
3. For every note that doesn't match a group, it searches outward (breadth-first) for the nearest colored notes, up to **Max hops** away.
4. Each colored note found contributes to the final color, weighted by `decayFactor ^ hopDistance`. Contributions below **Min influence** are ignored.
5. The weighted average color is applied directly to the nodes in any open Graph view.

## Settings

| Setting | Description | Default |
|---|---|---|
| Auto-apply | Automatically re-apply colors when Graph view opens or its groups change | On |
| Decay factor | How much a color's influence shrinks per hop (0–1). Lower = influence fades faster | 0.6 |
| Max hops | How many hops to search for a colored note | 3 |
| Min influence | Minimum weight required for a color to count; smaller contributions are discarded | 0.05 |

## Commands

- **Apply propagated colors to graph** — manually recompute and apply colors.
- **Debug: Dump node structure to console** — dumps the internal structure of the first graph node to the developer console, useful for troubleshooting if Obsidian's internal Graph renderer changes.

## Requirements

- Desktop only. The plugin relies on internals of the desktop Graph view renderer and is not available on mobile.

## Installation

### From Community Plugins (once published)
1. Open **Settings → Community plugins → Browse**.
2. Search for "Graph Color Propagation".
3. Click **Install**, then **Enable**.

### Manual installation
1. Download `main.js` and `manifest.json` from the [latest release](../../releases).
2. Copy them into `<your-vault>/.obsidian/plugins/graph-color-propagation/`.
3. Reload Obsidian and enable the plugin under **Settings → Community plugins**.

## Notes

- This plugin does not add its own group/query UI — all color groups are managed through Obsidian's native Graph view settings.
- Propagated colors are recalculated live but are not written back into `graph.json`; they only affect the visual rendering of the Graph view.

## License

[MIT](LICENSE)
