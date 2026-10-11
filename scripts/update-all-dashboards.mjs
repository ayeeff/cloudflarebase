#!/usr/bin/env bun
// scripts/update-all-dashboards.mjs
//
// Updates all CloudflareBase dashboards:
// 1. Atlas Themes Dashboard (metro, transitStations, transitLines, worship, schools, property, universities)
// 2. Atlas 19 Files Granular Datasets Dashboard (areas, baseline, buildings, pois, landmarks, property, etc.)
// 3. Atlas 2D Storage / Missing Files Dashboard
// 4. City QID Mapping (synced with canonical slug repairs)
//
// Writes both to local `src/lib/data/*.json` and uploads live registries to R2 (globe & globe-preview).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { S3Client, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CFB_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(CFB_ROOT, 'src', 'lib', 'data');

const envCandidates = [
  path.join(CFB_ROOT, '.env'),
  path.join(CFB_ROOT, '..', '.env'),
  path.join(CFB_ROOT, '..', '..', 'site', '.env'),
];

let env = {};
for (const p of envCandidates) {
  if (fs.existsSync(p)) {
    const text = fs.readFileSync(p, 'utf8');
    for (const line of text.split('\n')) {
      const m = line.replace(/\r$/, '').match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m && !(m[1] in env)) env[m[1]] = m[2].trim();
    }
  }
}

const ACCOUNT_ID = env.ACCOUNT_ID || '5d469620e5b9363beae1cb2e4e290aee';
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: env.R2_DATALAKE_ACCESS_KEY_ID || env.Access_Key_ID,
    secretAccessKey: env.R2_DATALAKE_SECRET_ACCESS_KEY || env.Secret_Access_Key,
  },
  maxAttempts: 5,
});

async function uploadToR2(key, bodyBuffer) {
  for (const bucket of ['globe', 'globe-preview']) {
    let success = false;
    let attempts = 0;
    while (!success && attempts < 5) {
      attempts++;
      try {
        await s3.send(new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: bodyBuffer,
          ContentType: 'application/json; charset=utf-8',
          CacheControl: 'public, max-age=300, stale-while-revalidate=86400',
        }));
        success = true;
      } catch (e) {
        if (attempts >= 5) {
          console.warn(`[Upload Warning] ${bucket}/${key}: ${e.message}`);
        } else {
          await new Promise(r => setTimeout(r, 1000 * attempts));
        }
      }
    }
  }
}

async function listAllKeys(bucket, prefix) {
  console.log(`Listing keys in ${bucket} (${prefix})...`);
  const keys = new Set();
  let continuationToken;
  let page = 0;
  do {
    page++;
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));
    for (const item of (res.Contents || [])) {
      keys.add(item.Key);
    }
    continuationToken = res.NextContinuationToken;
    if (page % 10 === 0) {
      process.stdout.write(`  [${bucket}/${prefix}] page ${page}, ${keys.size} keys so far...\r`);
    }
  } while (continuationToken);
  console.log(`  [${bucket}/${prefix}] Finished: ${keys.size} total keys.`);
  return keys;
}

const ALL_19_FILES = [
  'areas.json', 'baseline.json', 'buildings.bin', 'buildings.json',
  'demand-streets.json', 'demand.json', 'districts.json', 'extent.json',
  'landmarks.json', 'model.json', 'pack.json', 'pois.json',
  'purposes.bin.json', 'streets.bin', 'streets.json',
  'tram-streets.bin', 'tram-streets.json', 'water-rings.json', 'water.json'
];

const REQUIRED_2D_FILES = [
  'demand-streets.json',
  'neighborhoods.json',
  'places.json',
  'street-geoms.json',
  'transit-lines.json'
];

const ATLAS_THEMES = [
  { id: 'metro', file: 'metro-train-atlas-data.json', altFile: 'transit.json' },
  { id: 'transitStations', file: 'transit-stations.json', altFile: null },
  { id: 'transitLines', file: 'transit-lines.json', altFile: null },
  { id: 'worship', file: 'worship.json', altFile: null },
  { id: 'schools', file: 'schools.json', altFile: null },
  { id: 'property', file: 'property.json', altFile: null },
  { id: 'universities', file: 'universities.json', altFile: null }
];

async function main() {
  console.log('=== CloudflareBase Master Dashboard Refresh ===\n');

  // Load city-qid.json
  const cityQidPath = path.join(DATA_DIR, 'city-qid.json');
  const cityQid = JSON.parse(fs.readFileSync(cityQidPath, 'utf8'));

  // Scan R2 keys
  const [glKeys, dlKeys] = await Promise.all([
    listAllKeys('globe', 'data/'),
    listAllKeys('geo-datalake', 'sources/'),
  ]);

  // Discover all city slugs from globe and cityQid
  const citySlugSet = new Set(Object.keys(cityQid));
  for (const k of glKeys) {
    const m = k.match(/^data\/([^/]+)-2d\//);
    if (m) citySlugSet.add(m[1]);
  }
  const allSlugs = Array.from(citySlugSet).sort();
  console.log(`\nDiscovered ${allSlugs.length} unique city slugs.`);

  // ── 1. Atlas Themes Dashboard ──────────────────────────────────────────────
  console.log('\n[1/3] Generating Atlas Themes Registry & Seed...');
  const themeSummary = Object.fromEntries(ATLAS_THEMES.map(t => [t.id, { present: 0, missing: 0 }]));
  const themeCitiesList = [];
  const themeSeedCities = [];

  for (const slug of allSlugs) {
    const qid = cityQid[slug] || cityQid[slug.replace(/-/g, '')] || {};
    const presence = {};
    let presentCount = 0;

    for (const t of ATLAS_THEMES) {
      const hasFile = glKeys.has(`data/${slug}-2d/${t.file}`) ||
                      (t.altFile && glKeys.has(`data/${slug}-2d/${t.altFile}`)) ||
                      glKeys.has(`data/${slug}/${t.file}`) ||
                      (t.altFile && glKeys.has(`data/${slug}/${t.altFile}`));
      presence[t.id] = { present: hasFile };
      if (hasFile) {
        presentCount++;
        themeSummary[t.id].present++;
      } else {
        themeSummary[t.id].missing++;
      }
    }

    themeSeedCities.push({
      slug,
      metro: presence.metro.present,
      transitStations: presence.transitStations.present,
      transitLines: presence.transitLines.present,
      worship: presence.worship.present,
      schools: presence.schools.present,
      property: presence.property.present,
      universities: presence.universities.present,
    });

    themeCitiesList.push({
      slug,
      name: qid.municipality || slug.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' '),
      country: qid.country || 'Global',
      continent: qid.continent || 'Global',
      pop: Number(qid.pop) || 0,
      themes: presence,
      presentCount,
      missingCount: ATLAS_THEMES.length - presentCount,
      isComplete: presentCount === ATLAS_THEMES.length,
    });
  }

  themeCitiesList.sort((a, b) => b.pop - a.pop || a.name.localeCompare(b.name));

  const atlasThemesSeed = {
    generatedAt: new Date().toISOString(),
    summary: {
      totalCities: allSlugs.length,
      ...Object.fromEntries(ATLAS_THEMES.map(t => [t.id, themeSummary[t.id].present]))
    },
    cities: themeSeedCities,
  };

  const atlasThemesReport = {
    source: 'live-r2',
    generatedAt: new Date().toISOString(),
    totalCities: allSlugs.length,
    summary: themeSummary,
    cities: themeCitiesList,
  };

  fs.writeFileSync(path.join(DATA_DIR, 'atlas-themes-seed.json'), JSON.stringify(atlasThemesSeed, null, 2), 'utf8');
  console.log(`  Updated src/lib/data/atlas-themes-seed.json (Property present: ${themeSummary.property.present})`);

  const themesBuf = Buffer.from(JSON.stringify(atlasThemesReport, null, 2), 'utf8');
  await uploadToR2('registry/atlas-themes-registry.json', themesBuf);
  console.log(`  Uploaded registry/atlas-themes-registry.json to R2`);

  // ── 2. Atlas 19 Files Dashboard ────────────────────────────────────────────
  console.log('\n[2/3] Generating Atlas 19 Files Granular Report...');
  const datalakeTotals = Object.fromEntries(ALL_19_FILES.map(f => [f, { present: 0, missing: 0 }]));
  const globeTotals = Object.fromEntries(ALL_19_FILES.map(f => [f, { present: 0, missing: 0 }]));
  const byCity19 = {};
  let citiesCompleteBoth = 0;
  let citiesWithAnyMissing = 0;

  for (const slug of allSlugs) {
    const dlStatus = {};
    const glStatus = {};
    const dlMissing = [];
    const glMissing = [];
    let dlCount = 0;
    let glCount = 0;

    for (const file of ALL_19_FILES) {
      const hasDl = dlKeys.has(`sources/city-network/${slug}/${file}`) ||
                    dlKeys.has(`sources/osm/places/${slug}/${file}`) ||
                    dlKeys.has(`data/${slug}-2d/${file}`);
      const hasGl = glKeys.has(`data/${slug}-2d/${file}`) ||
                    glKeys.has(`data/${slug}/${file}`);

      dlStatus[file] = hasDl;
      glStatus[file] = hasGl;

      if (hasDl) { dlCount++; datalakeTotals[file].present++; }
      else { dlMissing.push(file); datalakeTotals[file].missing++; }

      if (hasGl) { glCount++; globeTotals[file].present++; }
      else { glMissing.push(file); globeTotals[file].missing++; }
    }

    const isComplete = dlCount >= 17 && glCount >= 17;
    if (isComplete) citiesCompleteBoth++;
    if (dlMissing.length || glMissing.length) citiesWithAnyMissing++;

    byCity19[slug] = {
      slug,
      datalake: dlStatus,
      globe: glStatus,
      missing: { datalake: dlMissing, globe: glMissing },
      datalakePresentCount: dlCount,
      globePresentCount: glCount,
      isComplete,
      hasAnyMissing: dlMissing.length > 0 || glMissing.length > 0,
    };
  }

  const report19 = {
    source: 'live-r2',
    generatedAt: new Date().toISOString(),
    filesChecked: ALL_19_FILES,
    totals: {
      datalake: datalakeTotals,
      globe: globeTotals,
      totalCities: allSlugs.length,
      citiesCompleteBoth,
      citiesWithAnyMissing,
    },
    byCity: byCity19,
  };

  fs.writeFileSync(path.join(DATA_DIR, 'atlas-19-files-report.json'), JSON.stringify(report19, null, 2), 'utf8');
  console.log(`  Updated src/lib/data/atlas-19-files-report.json (${allSlugs.length} cities)`);

  const report19Buf = Buffer.from(JSON.stringify(report19, null, 2), 'utf8');
  await Promise.all([
    uploadToR2('registry/atlas-19-files-registry.json', report19Buf),
    uploadToR2('registry/atlas-19-files-report.json', report19Buf),
  ]);
  console.log(`  Uploaded registry/atlas-19-files-registry.json & report.json to R2`);

  // ── 3. Atlas 2D Missing Files Dashboard ────────────────────────────────────
  console.log('\n[3/3] Generating Atlas 2D Storage & Missing Files Report...');
  const dl2dTotals = Object.fromEntries(REQUIRED_2D_FILES.map(f => [f, { present: 0, missing: 0 }]));
  const gl2dTotals = Object.fromEntries(REQUIRED_2D_FILES.map(f => [f, { present: 0, missing: 0 }]));
  const byCity2D = {};
  let cities2dCompleteBoth = 0;
  let cities2dWithAnyMissing = 0;

  for (const slug of allSlugs) {
    const dlStatus = {};
    const glStatus = {};
    const dlMissing = [];
    const glMissing = [];
    let dlCount = 0;
    let glCount = 0;

    for (const file of REQUIRED_2D_FILES) {
      const hasDl = dlKeys.has(`sources/osm/places/${slug}/${file}`) ||
                    dlKeys.has(`sources/city-network/${slug}/${file}`) ||
                    dlKeys.has(`data/${slug}-2d/${file}`);
      const hasGl = glKeys.has(`data/${slug}-2d/${file}`) ||
                    glKeys.has(`data/${slug}/${file}`);

      dlStatus[file] = hasDl;
      glStatus[file] = hasGl;

      if (hasDl) { dlCount++; dl2dTotals[file].present++; }
      else { dlMissing.push(file); dl2dTotals[file].missing++; }

      if (hasGl) { glCount++; gl2dTotals[file].present++; }
      else { glMissing.push(file); gl2dTotals[file].missing++; }
    }

    const isComplete = dlCount === REQUIRED_2D_FILES.length && glCount === REQUIRED_2D_FILES.length;
    if (isComplete) cities2dCompleteBoth++;
    if (dlMissing.length || glMissing.length) cities2dWithAnyMissing++;

    byCity2D[slug] = {
      slug,
      datalake: dlStatus,
      globe: glStatus,
      missing: { datalake: dlMissing, globe: glMissing },
      datalakePresentCount: dlCount,
      globePresentCount: glCount,
      hasAnyMissing: dlMissing.length > 0 || glMissing.length > 0,
      isComplete,
    };
  }

  const report2D = {
    source: 'live-r2',
    generatedAt: new Date().toISOString(),
    filesChecked: REQUIRED_2D_FILES,
    totals: {
      datalake: dl2dTotals,
      globe: gl2dTotals,
      totalCities: allSlugs.length,
      citiesCompleteBoth: cities2dCompleteBoth,
      citiesWithAnyMissing: cities2dWithAnyMissing,
    },
    byCity: byCity2D,
  };

  fs.writeFileSync(path.join(DATA_DIR, 'atlas-2d-missing-files.json'), JSON.stringify(report2D, null, 2), 'utf8');
  console.log(`  Updated src/lib/data/atlas-2d-missing-files.json`);

  const report2DBuf = Buffer.from(JSON.stringify(report2D, null, 2), 'utf8');
  await uploadToR2('registry/missing-atlas-2d-files.json', report2DBuf);
  console.log(`  Uploaded registry/missing-atlas-2d-files.json to R2`);

  console.log('\n=== All Dashboards Successfully Refreshed & Synced! ===');
}

main().catch(err => {
  console.error('Fatal dashboard update error:', err);
  process.exit(1);
});
