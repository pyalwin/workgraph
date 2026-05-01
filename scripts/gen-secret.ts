#!/usr/bin/env tsx
import { randomBytes } from 'crypto';

const key = randomBytes(32);
const hex = key.toString('hex');

console.log('# Add this line to your .env.local:');
console.log(`WORKGRAPH_SECRET_KEY=${hex}`);
console.log('');
console.log('# Once set, encrypted fields (OAuth tokens) will round-trip cleanly.');
console.log('# DO NOT commit this key. Rotating it makes all encrypted rows unreadable.');
