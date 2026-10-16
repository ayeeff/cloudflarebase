#!/usr/bin/env bun
// scripts/update-layer-json-report.mjs
// Updates layer-json-report.json with terrain.json coverage and syncs to R2.

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
  'D:/github/geo/site-pv3/.env',
  'D:/github/geo/site/.env'
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

const ACCOUNT_ID = env.ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID || '5d469620e5b9363beae1cb2e4e290aee';
const accessKey = env.Access_Key_ID || env.R2_DATALAKE_ACCESS_KEY_ID;
const secretKey = env.Secret_Access_Key || env.R2_DATALAKE_SECRET_ACCESS_KEY;

if (!accessKey || !secretKey) {
  console.error('ERROR: No R2 credentials found in .env');
  process.exit(1);
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: accessKey,
    secretAccessKey: secretKey
  },
  maxAttempts: 5
});

async function listAllTerrainKeys() {
  console.log('Discovering all terrain.json keys in R2 globe bucket...');
  const terrainSlugs = new Set();
  let continuationToken;
  let page = 0;

  do {
    page++;
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: 'globe',
      Prefix: 'data/',
      ContinuationToken: continuationToken
    }));

    for (const item of (res.Contents || [])) {
      if (item.Key.endsWith('/terrain.json')) {
        const m = item.Key.match(/^data\/([^/]+)-2d\/terrain\.json$/);
        if (m) terrainSlugs.add(m[1].toLowerCase());
      }
    }

    continuationToken = res.NextContinuationToken;
    if (page % 5 === 0) {
      process.stdout.write(`  [globe] scanned page ${page}, found ${terrainSlugs.size} terrain files...\r`);
    }
  } while (continuationToken);

  console.log(`\nDiscovered ${terrainSlugs.size} terrain.json files in R2.`);
  return terrainSlugs;
}

async function uploadToR2(key, bodyBuffer) {
  for (const bucket of ['globe', 'globe-preview']) {
    try {
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: bodyBuffer,
        ContentType: 'application/json; charset=utf-8',
        CacheControl: 'public, max-age=300, stale-while-revalidate=86400'
      }));
      console.log(`  ✓ Uploaded to s3://${bucket}/${key}`);
    } catch (e) {
      console.warn(`  [Warning] ${bucket}/${key}: ${e.message}`);
    }
  }
}

async function main() {
  const terrainSlugs = await listAllTerrainKeys();

  const reportPath = path.join(DATA_DIR, 'layer-json-report.json');
  if (!fs.existsSync(reportPath)) {
    console.error(`ERROR: Report not found at ${reportPath}`);
    process.exit(1);
  }

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

  let terrainPresent = 0;
  let terrainMissing = 0;
  const TOTAL_LAYERS = 9;

  for (const city of report.cities) {
    const slug = city.slug.toLowerCase();
    const hasTerrain = terrainSlugs.has(slug) ||
      terrainSlugs.has(slug.replace(/-/g, '')) ||
      terrainSlugs.has(slug.replace(/(\w+)-city$/, '$1'));

    city.layers.terrain = { present: hasTerrain };

    if (hasTerrain) {
      terrainPresent++;
    } else {
      terrainMissing++;
    }

    const presentCount = Object.values(city.layers).filter(l => Boolean(l.present)).length;
    city.presentCount = presentCount;
    city.missingCount = TOTAL_LAYERS - presentCount;
    city.isComplete = presentCount === TOTAL_LAYERS;
  }

  report.summary.terrain = {
    present: terrainPresent,
    missing: terrainMissing
  };
  report.generatedAt = new Date().toISOString();

  // Re-sort: complete first, then population descending
  report.cities.sort((a, b) => (b.pop || 0) - (a.pop || 0) || a.name.localeCompare(b.name));

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`✓ Updated ${reportPath}`);
  console.log(`  Terrain layer coverage: ${terrainPresent} present, ${terrainMissing} missing across ${report.cities.length} cities.`);

  const reportBuf = Buffer.from(JSON.stringify(report, null, 2), 'utf8');
  await uploadToR2('registry/layer-json-registry.json', reportBuf);
  await uploadToR2('registry/layer-json-report.json', reportBuf);

  console.log('✓ Successfully synced Layer JSON registry with terrain.json to R2!');
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
