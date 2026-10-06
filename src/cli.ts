/**
 * NEXUS command line.
 *
 *   node src/cli.ts run <task.json> [--headed] [--screenshots=on-failure|every-step|off]
 *                                   [--out=<dir>] [--timeout=<ms>] [--json]
 *
 * Exit codes: 0 task passed, 1 task failed, 2 usage error or invalid task.
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import { TaskValidationError } from './errors.ts';
import { loadTask, runTask, type ScreenshotPolicy, type StepResult } from './task/runner.ts';

const USAGE = `Usage: nexus run <task.json> [options]

Options:
  --headed                 Show the browser window
  --screenshots=<policy>   on-failure (default) | every-step | off
  --out=<dir>              Artifacts directory (default: artifacts/runs/<task>-<timestamp>)
  --timeout=<ms>           Default per-step timeout (default: 10000)
  --json                   Print the result as JSON instead of a summary`;

const POLICIES: ScreenshotPolicy[] = ['on-failure', 'every-step', 'off'];

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        headed: { type: 'boolean', default: false },
        screenshots: { type: 'string', default: 'on-failure' },
        out: { type: 'string' },
        timeout: { type: 'string' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const [command, file, ...extra] = positionals;
  if (command !== 'run' || !file || extra.length > 0) {
    console.error(USAGE);
    return 2;
  }
  const screenshots = values.screenshots as ScreenshotPolicy;
  if (!POLICIES.includes(screenshots)) {
    console.error(`--screenshots must be one of: ${POLICIES.join(', ')}`);
    return 2;
  }
  const timeout = values.timeout === undefined ? undefined : Number(values.timeout);
  if (timeout !== undefined && !(Number.isFinite(timeout) && timeout > 0)) {
    console.error('--timeout must be a positive number of milliseconds');
    return 2;
  }

  let loaded;
  try {
    loaded = await loadTask(file);
  } catch (error) {
    if (error instanceof TaskValidationError || error instanceof SyntaxError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }
  const { task, baseDir } = loaded;
  const artifactsDir = values.out ?? path.join('artifacts', 'runs', `${slug(task.name)}-${timestamp()}`);

  if (!values.json) console.log(`▶ ${task.name}  (${task.steps.length} steps)`);
  const result = await runTask(task, {
    baseDir,
    artifactsDir,
    screenshots,
    defaultTimeoutMs: timeout,
    launch: { headless: !values.headed },
    onStepEnd: values.json ? undefined : printStep,
  });

  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const passed = result.steps.filter((step) => step.status === 'passed').length;
    const icon = result.status === 'passed' ? '✔' : '✖';
    console.log(`${icon} ${result.status.toUpperCase()}  ${passed}/${result.steps.length} steps in ${result.durationMs}ms`);
    console.log(`  artifacts: ${path.relative(process.cwd(), result.artifactsDir) || '.'}`);
  }
  return result.status === 'passed' ? 0 : 1;
}

function printStep(step: StepResult): void {
  const icon = { passed: '✔', failed: '✖', skipped: '○' }[step.status];
  const timing = step.status === 'skipped' ? '' : `  (${step.durationMs}ms)`;
  console.log(`  ${icon} ${step.index + 1}. ${step.description}${timing}`);
  if (step.error) console.log(`      ${step.error.type}: ${step.error.message.split('\n').join('\n      ')}`);
  if (step.screenshot && step.action !== 'screenshot') console.log(`      screenshot: ${step.screenshot}`);
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'task';
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
}

process.exitCode = await main(process.argv.slice(2));
