import 'dotenv/config';
import { createProvider, loadConfig } from '../src/core/llm/index.js';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const provider = createProvider(loadConfig(), {
  provider: flag('--provider'),
  model: flag('--model'),
});
const started = Date.now();
const res = await provider.complete({
  system: 'You are a terse JSON-only assistant.',
  prompt: 'Reply with {"ok":true}',
});
console.log(`provider: ${provider.id} (${Date.now() - started}ms)`);
console.log(`text: ${res.text}`);
console.log(`usage: ${JSON.stringify(res.usage ?? {})}`);
