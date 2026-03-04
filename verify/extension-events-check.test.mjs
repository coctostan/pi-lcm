import { readFileSync } from 'fs';

const src = readFileSync('src/index.ts', 'utf8');
const required = [
  'context',
  'session_start',
  'agent_end',
  'tool_result',
  'session_before_compact',
  'session_tree',
  'session_shutdown',
];

const hasRegistration = (eventName) =>
  src.includes(`pi.on('${eventName}'`) || src.includes(`pi.on("${eventName}"`);

const missing = required.filter((eventName) => !hasRegistration(eventName));
if (missing.length) {
  console.error('Missing pi.on() registrations:', missing);
  process.exit(1);
}

console.log('All 7 event handlers registered.');
