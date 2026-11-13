import { loadConfig } from './config';
import { runLearnStep } from './learn/step';
import { jsonLogger as log } from './types';

runLearnStep(loadConfig(), log).catch((err) => {
  log('error', 'learn_fatal', { error: String(err) });
  process.exit(1);
});
