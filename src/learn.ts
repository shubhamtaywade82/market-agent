import { loadConfig } from './config';
import { runLearnStep } from './learn/step';
import { jsonLogger as log } from './types';

try {
  process.loadEnvFile?.();
} catch {
  // .env is optional; configuration may come directly from the process environment
}

runLearnStep(loadConfig(), log).catch((err) => {
  log('error', 'learn_fatal', { error: String(err) });
  process.exit(1);
});
