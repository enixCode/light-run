/*
 * The periodic maintenance sweep (runMaintenance) is light-run's time-based
 * safety net: per-run resources are freed the instant a run ends, but crashed
 * states, orphan containers/volumes/networks, expired cache images and
 * dangling image layers need a sweep to be reclaimed over time.
 *
 * The individual reclaimers are tested in light-runner; here we prove the
 * wiring: a crashed `running` state (its container does not exist) is
 * reconciled to `failed`, and the report comes back with every numeric field.
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runMaintenance } from '../../src/runner.js';

const dockerAvailable = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
const maybe = dockerAvailable ? describe : describe.skip;

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'light-run-maint-'));
process.env.LIGHT_RUNNER_STATE_DIR = stateDir;
process.env.LIGHT_RUN_ARTIFACTS_DIR = path.join(stateDir, 'artifacts');

maybe('light-run maintenance sweep', () => {
  after(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('reconciles a crashed running state to failed and returns a numeric report', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const zombie = {
      id,
      container: `light-runner-nonexistent-${Date.now().toString(36)}`,
      volume: 'light-runner-nonexistent-vol',
      image: 'alpine:3.19',
      workdir: '/app',
      startedAt: new Date().toISOString(),
      status: 'running',
    };
    fs.writeFileSync(path.join(stateDir, `${id}.json`), JSON.stringify(zombie, null, 2));

    const report = await runMaintenance();

    // A 'running' state whose container does not exist is reconciled to 'failed'.
    const updated = JSON.parse(
      fs.readFileSync(path.join(stateDir, `${id}.json`), 'utf8'),
    ) as { status: string; finishedAt?: string };
    assert.equal(updated.status, 'failed');
    assert.ok(updated.finishedAt, 'finishedAt is stamped on reconcile');
    assert.ok(report.reconciled >= 1, `expected >=1 reconciled, got ${report.reconciled}`);

    // Every reclaimer reported a non-negative count (proves the full wiring ran).
    const fields = [
      'reconciled', 'statesEvicted', 'containers', 'volumes',
      'cacheImages', 'networks', 'danglingImages',
    ] as const;
    for (const k of fields) {
      assert.equal(typeof report[k], 'number');
      assert.ok(report[k] >= 0);
    }
  });
});
