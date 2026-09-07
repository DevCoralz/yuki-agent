#!/usr/bin/env node
/**
 * pre-deploy-check.js — ESM version
 * Run this before `fly deploy` to ensure the persistent volume exists.
 * Usage: node scripts/pre-deploy-check.js [app-name] [region]
 */
import { execSync } from 'node:child_process';

const appName = process.argv[2] || 'yuki-agent-bot';
const region = process.argv[3] || 'iad';

console.log(`=== Checking Fly volume for ${appName} ===`);

try {
  const output = execSync(`fly volumes list --app ${appName} --json`, { encoding: 'utf8' }).trim();
  const volumes = JSON.parse(output);
  const sessionVol = volumes.find(v => v.name === 'session_data');

  if (sessionVol) {
    console.log(`✅ Volume 'session_data' exists (region: ${sessionVol.region}, size: ${sessionVol.size_gb}GB)`);
  } else {
    console.log('❌ Volume not found. Creating...');
    execSync(`fly volumes create session_data --size 3 --region ${region} --app ${appName}`, { stdio: 'inherit' });
    console.log('✅ Volume created successfully');
  }
} catch (err) {
  console.log('❌ Could not list volumes. Creating...');
  execSync(`fly volumes create session_data --size 3 --region ${region} --app ${appName}`, { stdio: 'inherit' });
  console.log('✅ Volume created successfully');
}

console.log('\n=== Ready to deploy ===');
console.log('Run: fly deploy');
