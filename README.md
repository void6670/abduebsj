# Places → 3D

Turn Google Maps places into a real 3D map. Paste Google Maps links, coordinates or place names, or import your saved places. Each one appears as a pin on a 3D map with tilted terrain and extruded buildings. You can fly between them, orbit a place, or run a tour of all of them.

## Run it

It's a static site with no build step and no dependencies.

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

Any static host works too.

### GitHub Pages

The site is published from the `gh-pages` branch, which holds `index.html`, `style.css`, `parse.js`, `app.js` and an empty `.nojekyll` file. To update it, copy the changed files onto that branch and push. It is served at `https://<owner>.github.io/<repo>/`.

## What it understands

| Input | Example |
|---|---|
| Place links (uses the exact pin) | `https://www.google.com/maps/place/Eiffel+Tower/@48.85,2.29,17z/data=…!3d48.8583!4d2.2944` |
| Map, satellite and Earth views (keeps heading, tilt and distance) | `https://www.google.com/maps/@40.748,-73.985,600a,900d,35y,200h,65t` |
| Street View links (close, tilted camera) | `https://www.google.com/maps/@51.50,-0.12,3a,75y,90h,95t` |
| Search and query links | `?q=35.65,139.74`, `?q=Sydney+Opera+House`, `?api=1&query=…`, `?ll=…` |
| Directions (every stop is added) | `https://www.google.com/maps/dir/Colosseum/Pantheon/…` |
| Dropped pins (DMS) | `48°51'30.0"N 2°17'40.0"E` |
| Coordinates, with an optional label | `40.6892, -74.0445` · `Base camp: -13.16, -72.54` |
| Place names (found with OpenStreetMap Nominatim) | `Machu Picchu` |
| A label before a link | `Hotel https://www.google.com/maps/…` |
| `geo:` URIs | `geo:37.78,-122.39?q=Moscone` |

**Files** (use *Import file…* or drop them onto the map):
- Google Takeout **Saved Places.json** (Takeout → Maps (your places))
- Google Takeout saved lists as **.csv** (Takeout → Saved). These have no coordinates, so place names are geocoded.
- Google **My Maps** / Earth **.kml**
- Any **GeoJSON**, or a **CSV** with `name,lat,lng` columns

Short links (`maps.app.goo.gl/…`) can't be expanded from a browser because of CORS. Open the link, then paste the full URL from the address bar.

## Two 3D modes

**Free 3D** (the default, no key needed) uses [MapLibre GL](https://maplibre.org). It has two looks:
- **Realistic** (default): Esri satellite imagery draped over [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) elevation with hillshading. Ground, forest, water, snow and rock show their real colours. Buildings from [OpenFreeMap](https://openfreemap.org) are extruded with procedurally generated facade textures (brick, stone, plaster, concrete, sandstone, and glass for towers), coloured roofs and sun lighting. Main roads and street and place labels sit on top.
- **Map**: the OpenFreeMap Liberty street map with the same textured buildings, hillshading and terrain.

Terrain exaggeration, a sky and atmosphere, and the 3D buildings and terrain toggles work in both.

**Photorealistic** uses Google's [Photorealistic 3D Tiles](https://developers.google.com/maps/documentation/tile/3d-tiles)
(the same 3D mesh as Google Earth), rendered with [CesiumJS](https://cesium.com/platform/cesiumjs/).
You need a Google Maps Platform API key with the **Map Tiles API** enabled. The key is kept only in your browser's localStorage.
Google bills Map Tiles API usage beyond its free tier.

## Other features

- **Walk in 3D**: builds a real 3D model of the selected area, or a 700 m square around the selected place or the map centre (up to 3 km). The model combines terrain from elevation data, the satellite photo as ground texture, and every building with its real footprint and height, textured walls and coloured roofs. You then walk around in it first-person:
  - **W A S D** or arrows to move, mouse to look, **Shift** to run, **Space** to jump
  - **F** to fly (Space up, C down)
  - on phones, a joystick and drag-to-look

  You can't walk through walls, and you can land on roofs.
- **Download 3D file (.glb)**: saves the same model as a standard glTF binary, in metres with Y up and centred on the area, with the satellite and facade textures embedded. It opens in Windows 3D Viewer, Blender, Unity, Unreal, Godot, Sketchfab and other 3D tools, and passes the Khronos glTF validator.
- **Pick place**: click anywhere on the map, or on the photorealistic 3D surface, to drop a pin. Its name is looked up automatically.
- **Select area**: drag a box on the map (hold Shift for an exact square). The 3D view frames that square with a glowing wall around it and dims everything outside. Areas show in the list with their size and are kept in share links.
- **Tour** flies to each place in turn and orbits it.
- **Orbit** rotates slowly around the selected place.
- **Copy share link** encodes all places in the URL hash, so you can send someone the same 3D map.
- Places are saved in localStorage between visits.
- Pasting a Maps link anywhere on the page (outside the text box) adds it right away.

## Development

```sh
node --test test/*.test.js   # parser tests
```

- `parse.js`: turns links, text and files into place specs. It has no dependencies and runs in the browser and in Node.
- `app.js`: UI, geocoding, MapLibre and Cesium rendering.
- `walk.js`: builds the 3D model with three.js from elevation, imagery and vector tiles, runs the first-person viewer and exports .glb.
- `index.html`, `style.css`: layout.
