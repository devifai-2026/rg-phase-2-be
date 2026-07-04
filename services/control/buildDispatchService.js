const axios = require('axios');
const env = require('../../config/env');
const logger = require('../../utils/logger');

/**
 * Dispatch a tenant Android build to GitHub Actions (the app repos have Flutter +
 * Android SDK + enough RAM; the API VM does not). On a new BuildJob we fire a
 * `workflow_dispatch` on the matching app repo's tenant-build workflow, passing
 * the tenant flavor inputs + the job id. The workflow builds + signs + uploads to
 * GCS, then calls back POST /platform/builds/:id/callback to mark the job done.
 *
 * Config (env, github block): GH token with `actions:write` on the app repos.
 * When unconfigured, dispatch is a no-op (jobs stay queued) + logs a warning.
 */
function configured() {
  return !!(env.github && env.github.token);
}

function repoFor(app) {
  const r = env.github || {};
  return app === 'astrologer' ? (r.astroRepo || 'devifai-2026/rg-phase-astrologer')
    : (r.userRepo || 'devifai-2026/rg-phase-2-user');
}

/**
 * Trigger the tenant build workflow for a BuildJob. Returns true if dispatched.
 * Best-effort: never throws into the request path (caller logs).
 */
async function dispatch(job) {
  if (!configured()) {
    logger.warn('build dispatch skipped — GITHUB_TOKEN not set; job stays queued', { job: String(job._id) });
    return false;
  }
  const repo = repoFor(job.app);
  const workflow = (env.github.buildWorkflow || 'tenant-build.yml');
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`;
  const inputs = {
    job_id: String(job._id),
    tenant: job.tenantSlug,
    artifact: job.artifact,
    application_id: job.applicationId || '',
    app_label: job.appLabel || job.tenantSlug,
    version_name: job.versionName || '1.0.0',
    version_code: String(job.versionCode || 1),
    api_base: job.apiBase || '',
    callback_base: env.github.callbackBase || `https://${env.saas.rootDomain}`,
  };
  try {
    await axios.post(url, { ref: env.github.ref || 'main', inputs }, {
      headers: {
        Authorization: `Bearer ${env.github.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      timeout: 15000,
    });
    logger.info('build dispatched to GitHub Actions', { job: String(job._id), repo, app: job.app });
    return true;
  } catch (e) {
    logger.error('build dispatch failed', { job: String(job._id), repo, error: e.response?.data?.message || e.message });
    return false;
  }
}

module.exports = { dispatch, configured };
