---
name: SVG mapmaker
description: >
  Enable to let the Keeper draw simple player-visible SVG handout maps: location maps,
  room hierarchy diagrams, clue-route sketches, and relationship/area structures with labels.
allowed-tools: [draw_svg_map]
metadata:
  scope: room
  content-rating: ""
---

# SVG mapmaker

Use `draw_svg_map` when a compact visual structure would help the table understand space,
routes, room hierarchy, or named locations. Good moments include:

- the party enters a new building, dungeon level, ship deck, town district, or investigation board
- players ask how rooms connect or which places are above/below/inside others
- a module has several named scenes and you need a player-safe overview
- you want a handout that shows only discovered or player-visible location names

Do not include keeper-only secrets, hidden rooms, trap truths, culprit identities, unrevealed clue
solutions, or private NPC motives. A map is a handout; everything drawn on it is player-visible.

Call `draw_svg_map` with:

- `title`: the map title
- `layout`: `"hierarchy"` for nested/flow structures, or `"grid"` for rooms/floor-like layouts
- `areas_json`: a JSON list of area objects

Area objects may contain:

- `id`: short stable id, used by `parent` and `links`
- `name`: label shown on the map
- `parent`: id of the containing/previous area
- `description`: short player-visible subtitle
- `links`: list of ids connected to this area

Example:

```json
[
  {"id":"manse","name":"Blackwood Manse","description":"front hall"},
  {"id":"library","name":"Library","parent":"manse","description":"locked cabinets"},
  {"id":"cellar","name":"Cellar","parent":"manse","description":"cold stone stairs"},
  {"id":"tunnel","name":"Old Tunnel","parent":"cellar","description":"bricked arch", "links":["garden"]}
]
```

After the tool sends the map, briefly orient the players to what is visible on it and continue the
scene. Do not narrate the SVG markup itself.
