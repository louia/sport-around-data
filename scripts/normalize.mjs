#!/usr/bin/env node
/**
 * normalize.mjs
 * Lit un fichier GeoJSON produit par osmium export (une feature par ligne),
 * convertit les polygones/lignes en points (centroïde),
 * ajoute la propriété `sport_around_type`, et ne conserve que `name`.
 *
 * Usage: node scripts/normalize.mjs <input.geojson> <output.geojson>
 */

import { createReadStream, createWriteStream } from "node:fs";

function parseOsmId(rawId) {
    if (!rawId) return {};
    const match = String(rawId).match(/^([nwr])(\d+)$/);
    if (!match) return {};
    const typeMap = { n: 'node', w: 'way', r: 'relation' };
    return { osm_id: parseInt(match[2], 10), osm_type: typeMap[match[1]] };
}
import { createInterface } from "node:readline";
import { argv, exit } from "node:process";

const [, , inputFile, outputFile] = argv;
if (!inputFile || !outputFile) {
    console.error(
        "Usage: node scripts/normalize.mjs <input.geojson> <output.geojson>",
    );
    exit(1);
}

// ---------------------------------------------------------------------------
// MATCHERS — ordre important : le premier qui matche gagne
// Doit rester synchronisé avec app/utils/overpassQueryData.ts
// ---------------------------------------------------------------------------
const MATCHERS = [
    {
        match: (p) => p.leisure === "pitch" && p.sport === "soccer",
        type: "football",
    },
    {
        match: (p) => p.leisure === "pitch" && p.sport === "basketball",
        type: "basketball",
    },
    {
        match: (p) => p.leisure === "pitch" && p.sport === "boules",
        type: "boules",
    },
    {
        match: (p) => p.leisure === "pitch" && p.sport === "skateboard",
        type: "skatepark",
    },
    {
        match: (p) => p.leisure === "pitch" && p.sport === "table_tennis",
        type: "ping_pong",
    },
    {
        match: (p) => p.leisure === "pitch" && p.sport === "multi",
        type: "city_stade",
    },
    {
        match: (p) => p.leisure === "track" && p.cycling === "pump_track",
        type: "pumptrack",
    },
    {
        match: (p) => p.leisure === "track" && p.sport === "bmx",
        type: "pumptrack",
    },
    { match: (p) => p.amenity === "drinking_water", type: "drinking_water" },
    {
        match: (p) => p.amenity === "fountain" && p.drinking_water === "yes",
        type: "drinking_water",
    },
    {
        match: (p) =>
            p.amenity === "toilets" &&
            (!p.access || ["yes", "public", "permissive"].includes(p.access)),
        type: "toilets",
    },
    { match: (p) => p.tourism === "picnic_site", type: "picnic_site" },
    { match: (p) => p.leisure === "picnic_table", type: "picnic_site" },
    { match: (p) => p.tourism === "viewpoint", type: "viewpoint" },
    { match: (p) => p.tourism === "alpine_hut", type: "alpine_hut" },
    { match: (p) => p.tourism === "wilderness_hut", type: "wilderness_hut" },
    { match: (p) => p.sport === "climbing", type: "climbing" },
    { match: (p) => p.route === "via_ferrata", type: "via_ferrata" },
];

// ---------------------------------------------------------------------------
// Calcul du centroïde (sans dépendance externe)
// ---------------------------------------------------------------------------
function computeCentroid(geometry) {
    if (!geometry) return null;

    switch (geometry.type) {
        case "Point":
            return geometry.coordinates;

        case "LineString":
            return averageCoords(geometry.coordinates);

        case "MultiLineString":
            return averageCoords(geometry.coordinates.flat());

        case "Polygon":
            // Utilise l'anneau extérieur (index 0) sans le dernier point (==premier)
            return averageCoords(geometry.coordinates[0]);

        case "MultiPolygon":
            // Anneau extérieur du premier polygone
            return averageCoords(geometry.coordinates[0][0]);

        case "GeometryCollection": {
            const first = geometry.geometries?.[0];
            return first ? computeCentroid(first) : null;
        }

        default:
            return null;
    }
}

function averageCoords(coords) {
    if (!coords || coords.length === 0) return null;
    const lon = coords.reduce((s, c) => s + c[0], 0) / coords.length;
    const lat = coords.reduce((s, c) => s + c[1], 0) / coords.length;
    return [lon, lat];
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------
function classifyFeature(props) {
    for (const { match, type } of MATCHERS) {
        if (match(props)) return type;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Main — lecture ligne par ligne pour gérer des fichiers de taille arbitraire
// Supporte :
//   - GeoJSON FeatureCollection (osmium export par défaut : 1 feature/ligne)
//   - GeoJSONSeq (préfixe \x1e, osmium export -f geojsonseq)
// ---------------------------------------------------------------------------
async function main() {
    const rl = createInterface({
        input: createReadStream(inputFile),
        crlfDelay: Infinity,
    });

    const outStream = createWriteStream(outputFile);
    outStream.write('{"type":"FeatureCollection","features":[\n');

    let firstFeature = true;
    let total = 0;
    let kept = 0;

    for await (const rawLine of rl) {
        // Supprime le caractère RS du format GeoJSONSeq si présent
        const line = rawLine.startsWith("\x1e")
            ? rawLine.slice(1).trim()
            : rawLine.trim();

        // Ignore les lignes structurelles du FeatureCollection
        if (!line || !line.startsWith('{"type":"Feature"')) continue;

        // Supprime la virgule de fin si présente (intérieur d'un tableau JSON)
        const json = line.endsWith(",") ? line.slice(0, -1) : line;

        let feature;
        try {
            feature = JSON.parse(json);
        } catch {
            continue;
        }

        if (!feature?.geometry || !feature?.properties) continue;

        total++;

        const props = feature.properties;
        const sportType = classifyFeature(props);
        if (!sportType) continue;

        const coords = computeCentroid(feature.geometry);
        if (!coords) continue;

        const outputFeature = {
            type: "Feature",
            geometry: { type: "Point", coordinates: coords },
            properties: {
                sport_around_type: sportType,
                ...(props.name ? { name: props.name } : {}),
                ...parseOsmId(props['@id']),
            },
        };

        if (!firstFeature) outStream.write(",\n");
        outStream.write(JSON.stringify(outputFeature));
        firstFeature = false;
        kept++;
    }

    outStream.write("\n]}\n");

    await new Promise((resolve, reject) => {
        outStream.on("finish", resolve);
        outStream.on("error", reject);
        outStream.end();
    });

    console.log(
        `Done — total OSM features parsed: ${total}, kept after classification: ${kept}`,
    );
}

main().catch((err) => {
    console.error(err);
    exit(1);
});
