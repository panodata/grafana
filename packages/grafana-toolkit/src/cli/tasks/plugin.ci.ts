import { Task, TaskRunner } from './task';
import { pluginBuildRunner } from './plugin.build';
import { restoreCwd } from '../utils/cwd';
import { S3Client } from '../../plugins/aws';
import { getPluginJson } from '../../config/utils/pluginValidation';
import { getPluginId } from '../../config/utils/getPluginId';
import { PluginMeta } from '@grafana/data';

// @ts-ignore
import execa = require('execa');
import path = require('path');
import fs from 'fs';
import { getPackageDetails, findImagesInFolder, appendPluginHistory, getGrafanaVersions } from '../../plugins/utils';
import {
  job,
  getJobFolder,
  writeJobStats,
  getCiFolder,
  getPluginBuildInfo,
  getBuildNumber,
  getPullRequestNumber,
  getCircleDownloadBaseURL,
} from '../../plugins/env';
import { agregateWorkflowInfo, agregateCoverageInfo, agregateTestInfo } from '../../plugins/workflow';
import {
  PluginPackageDetails,
  PluginBuildReport,
  PluginHistory,
  defaultPluginHistory,
  TestResultsInfo,
  PluginDevInfo,
  PluginDevSummary,
  DevSummary,
} from '../../plugins/types';
import { runEndToEndTests } from '../../plugins/e2e/launcher';
import { getEndToEndSettings } from '../../plugins/index';

export interface PluginCIOptions {
  backend?: boolean;
  full?: boolean;
  upload?: boolean;
}

/**
 * 1. BUILD
 *
 *  when platform exists it is building backend, otherwise frontend
 *
 *  Each build writes data:
 *   ~/ci/jobs/build_xxx/
 *
 *  Anything that should be put into the final zip file should be put in:
 *   ~/ci/jobs/build_xxx/dist
 */
const buildPluginRunner: TaskRunner<PluginCIOptions> = async ({ backend }) => {
  const start = Date.now();
  const workDir = getJobFolder();
  await execa('rimraf', [workDir]);
  fs.mkdirSync(workDir);

  if (backend) {
    const makefile = path.resolve(process.cwd(), 'Makefile');
    if (!fs.existsSync(makefile)) {
      throw new Error(`Missing: ${makefile}. A Makefile is required for backend plugins.`);
    }

    // Run plugin-ci task
    execa('make', ['backend-plugin-ci']).stdout!.pipe(process.stdout);
  } else {
    // Do regular build process with coverage
    await pluginBuildRunner({ coverage: true });
  }

  // Move local folders to the scoped job folder
  for (const name of ['dist', 'coverage']) {
    const dir = path.resolve(process.cwd(), name);
    if (fs.existsSync(dir)) {
      fs.renameSync(dir, path.resolve(workDir, name));
    }
  }
  writeJobStats(start, workDir);
};

export const ciBuildPluginTask = new Task<PluginCIOptions>('Build Plugin', buildPluginRunner);

/**
 * 2. Build Docs
 *
 *  Take /docs/* and format it into /ci/docs/HTML site
 *
 */
const buildPluginDocsRunner: TaskRunner<PluginCIOptions> = async () => {
  const docsSrc = path.resolve(process.cwd(), 'docs');
  if (!fs.existsSync(docsSrc)) {
    console.log('No docs src');
    return;
  }

  const start = Date.now();
  const workDir = getJobFolder();
  await execa('rimraf', [workDir]);
  fs.mkdirSync(workDir);

  const docsDest = path.resolve(process.cwd(), 'ci', 'docs');
  fs.mkdirSync(docsDest);

  const exe = await execa('cp', ['-rv', docsSrc + '/.', docsDest]);
  console.log(exe.stdout);

  fs.writeFile(path.resolve(docsDest, 'index.html'), `TODO... actually build docs`, err => {
    if (err) {
      throw new Error('Unable to docs');
    }
  });

  writeJobStats(start, workDir);
};

export const ciBuildPluginDocsTask = new Task<PluginCIOptions>('Build Plugin Docs', buildPluginDocsRunner);

/**
 * 2. Package
 *
 *  Take everything from `~/ci/job/{any}/dist` and
 *  1. merge it into: `~/ci/dist`
 *  2. zip it into packages in `~/ci/packages`
 *  3. prepare grafana environment in: `~/ci/grafana-test-env`
 */
const packagePluginRunner: TaskRunner<PluginCIOptions> = async () => {
  const start = Date.now();
  const ciDir = getCiFolder();
  const packagesDir = path.resolve(ciDir, 'packages');
  let distDir = path.resolve(ciDir, 'dist');
  const docsDir = path.resolve(ciDir, 'docs');
  const grafanaEnvDir = path.resolve(ciDir, 'grafana-test-env');
  await execa('rimraf', [packagesDir, distDir, grafanaEnvDir]);
  fs.mkdirSync(packagesDir);
  fs.mkdirSync(distDir);

  // Updating the dist dir to have a pluginId named directory in it
  // The zip needs to contain the plugin code wrapped in directory with a pluginId name
  distDir = path.resolve(ciDir, `dist/${getPluginId()}`);
  fs.mkdirSync(grafanaEnvDir);

  console.log('Build Dist Folder');

  // 1. Check for a local 'dist' folder
  const d = path.resolve(process.cwd(), 'dist');
  if (fs.existsSync(d)) {
    await execa('cp', ['-rn', d + '/.', distDir]);
  }

  // 2. Look for any 'dist' folders under ci/job/XXX/dist
  const dirs = fs.readdirSync(path.resolve(ciDir, 'jobs'));
  for (const j of dirs) {
    const contents = path.resolve(ciDir, 'jobs', j, 'dist');
    if (fs.existsSync(contents)) {
      try {
        await execa('cp', ['-rn', contents + '/.', distDir]);
      } catch (er) {
        throw new Error('Duplicate files found in dist folders');
      }
    }
  }

  console.log('Save the source info in plugin.json');
  const pluginJsonFile = path.resolve(distDir, 'plugin.json');
  const pluginInfo = getPluginJson(pluginJsonFile);
  pluginInfo.info.build = await getPluginBuildInfo();
  fs.writeFile(pluginJsonFile, JSON.stringify(pluginInfo, null, 2), err => {
    if (err) {
      throw new Error('Error writing: ' + pluginJsonFile);
    }
  });

  console.log('Building ZIP');
  let zipName = pluginInfo.id + '-' + pluginInfo.info.version + '.zip';
  let zipFile = path.resolve(packagesDir, zipName);
  process.chdir(distDir);
  await execa('zip', ['-r', zipFile, '.']);
  restoreCwd();

  const zipStats = fs.statSync(zipFile);
  if (zipStats.size < 100) {
    throw new Error('Invalid zip file: ' + zipFile);
  }

  const info: PluginPackageDetails = {
    plugin: await getPackageDetails(zipFile, distDir),
  };

  console.log('Setup Grafana Environment');
  let p = path.resolve(grafanaEnvDir, 'plugins', pluginInfo.id);
  fs.mkdirSync(p, { recursive: true });
  await execa('unzip', [zipFile, '-d', p]);

  // If docs exist, zip them into packages
  if (fs.existsSync(docsDir)) {
    console.log('Creating documentation zip');
    zipName = pluginInfo.id + '-' + pluginInfo.info.version + '-docs.zip';
    zipFile = path.resolve(packagesDir, zipName);
    process.chdir(docsDir);
    await execa('zip', ['-r', zipFile, '.']);
    restoreCwd();

    info.docs = await getPackageDetails(zipFile, docsDir);
  }

  p = path.resolve(packagesDir, 'info.json');
  fs.writeFile(p, JSON.stringify(info, null, 2), err => {
    if (err) {
      throw new Error('Error writing package info: ' + p);
    }
  });

  // Write the custom settings
  p = path.resolve(grafanaEnvDir, 'custom.ini');
  const customIniBody =
    `# Autogenerated by @grafana/toolkit \n` +
    `[paths] \n` +
    `plugins = ${path.resolve(grafanaEnvDir, 'plugins')}\n` +
    `\n`; // empty line
  fs.writeFile(p, customIniBody, err => {
    if (err) {
      throw new Error('Unable to write: ' + p);
    }
  });

  writeJobStats(start, getJobFolder());
};

export const ciPackagePluginTask = new Task<PluginCIOptions>('Bundle Plugin', packagePluginRunner);

/**
 * 3. Test (end-to-end)
 *
 *  deploy the zip to a running grafana instance
 *
 */
const testPluginRunner: TaskRunner<PluginCIOptions> = async ({ full }) => {
  const start = Date.now();
  const workDir = getJobFolder();
  const results: TestResultsInfo = { job, passed: 0, failed: 0, screenshots: [] };
  const args = {
    withCredentials: true,
    baseURL: process.env.BASE_URL || 'http://localhost:3000/',
    responseType: 'json',
    auth: {
      username: 'admin',
      password: 'admin',
    },
  };

  const settings = getEndToEndSettings();
  await execa('rimraf', [settings.outputFolder]);
  fs.mkdirSync(settings.outputFolder);

  const tempDir = path.resolve(process.cwd(), 'e2e-temp');
  await execa('rimraf', [tempDir]);
  fs.mkdirSync(tempDir);

  try {
    const axios = require('axios');
    const frontendSettings = await axios.get('api/frontend/settings', args);
    results.grafana = frontendSettings.data.buildInfo;

    console.log('Grafana: ' + JSON.stringify(results.grafana, null, 2));

    const loadedMetaRsp = await axios.get(`api/plugins/${settings.plugin.id}/settings`, args);
    const loadedMeta: PluginMeta = loadedMetaRsp.data;
    console.log('Plugin Info: ' + JSON.stringify(loadedMeta, null, 2));
    if (loadedMeta.info.build) {
      const currentHash = settings.plugin.info.build!.hash;
      console.log('Check version: ', settings.plugin.info.build);
      if (loadedMeta.info.build.hash !== currentHash) {
        console.warn(`Testing wrong plugin version.  Expected: ${currentHash}, found: ${loadedMeta.info.build.hash}`);
        throw new Error('Wrong plugin version');
      }
    }

    if (!fs.existsSync('e2e-temp')) {
      fs.mkdirSync(tempDir);
    }

    await execa('cp', [
      'node_modules/@grafana/toolkit/src/plugins/e2e/commonPluginTests.ts',
      path.resolve(tempDir, 'common.test.ts'),
    ]);

    await runEndToEndTests(settings.outputFolder, results);
  } catch (err) {
    results.error = err;
    console.log('Test Error', err);
  }
  await execa('rimraf', [tempDir]);

  // Now copy everything to work folder
  await execa('cp', ['-rv', settings.outputFolder + '/.', workDir]);
  results.screenshots = findImagesInFolder(workDir);

  const f = path.resolve(workDir, 'results.json');
  fs.writeFile(f, JSON.stringify(results, null, 2), err => {
    if (err) {
      throw new Error('Error saving: ' + f);
    }
  });

  writeJobStats(start, workDir);
};

export const ciTestPluginTask = new Task<PluginCIOptions>('Test Plugin (e2e)', testPluginRunner);

/**
 * 4. Report
 *
 *  Create a report from all the previous steps
 */
const pluginReportRunner: TaskRunner<PluginCIOptions> = async ({ upload }) => {
  const ciDir = path.resolve(process.cwd(), 'ci');
  const packageDir = path.resolve(ciDir, 'packages');
  const packageInfo = require(path.resolve(packageDir, 'info.json')) as PluginPackageDetails;

  const pluginJsonFile = path.resolve(ciDir, 'dist', 'plugin.json');
  console.log('Load info from: ' + pluginJsonFile);

  const pluginMeta = getPluginJson(pluginJsonFile);
  const report: PluginBuildReport = {
    plugin: pluginMeta,
    packages: packageInfo,
    workflow: agregateWorkflowInfo(),
    coverage: agregateCoverageInfo(),
    tests: agregateTestInfo(),
    artifactsBaseURL: await getCircleDownloadBaseURL(),
    grafanaVersion: getGrafanaVersions(),
  };
  const pr = getPullRequestNumber();
  if (pr) {
    report.pullRequest = pr;
  }

  // Save the report to disk
  const file = path.resolve(ciDir, 'report.json');
  fs.writeFile(file, JSON.stringify(report, null, 2), err => {
    if (err) {
      throw new Error('Unable to write: ' + file);
    }
  });

  console.log('Initalizing S3 Client');
  const s3 = new S3Client();

  const build = pluginMeta.info.build;
  if (!build) {
    throw new Error('Metadata missing build info');
  }

  const version = pluginMeta.info.version || 'unknown';
  const branch = build.branch || 'unknown';
  const buildNumber = getBuildNumber();
  const root = `dev/${pluginMeta.id}`;
  const dirKey = pr ? `${root}/pr/${pr}/${buildNumber}` : `${root}/branch/${branch}/${buildNumber}`;

  const jobKey = `${dirKey}/index.json`;
  if (await s3.exists(jobKey)) {
    throw new Error('Job already registered: ' + jobKey);
  }

  console.log('Write Job', jobKey);
  await s3.writeJSON(jobKey, report, {
    Tagging: `version=${version}&type=${pluginMeta.type}`,
  });

  // Upload logo
  const logo = await s3.uploadLogo(report.plugin.info, {
    local: path.resolve(ciDir, 'dist'),
    remote: root,
  });

  const latest: PluginDevInfo = {
    pluginId: pluginMeta.id,
    name: pluginMeta.name,
    logo,
    build: pluginMeta.info.build!,
    version,
  };

  let base = `${root}/branch/${branch}/`;
  latest.build.number = buildNumber;
  if (pr) {
    latest.build.pr = pr;
    base = `${root}/pr/${pr}/`;
  }

  const historyKey = base + `history.json`;
  console.log('Read', historyKey);
  const history: PluginHistory = await s3.readJSON(historyKey, defaultPluginHistory);
  appendPluginHistory(report, latest, history);

  await s3.writeJSON(historyKey, history);
  console.log('wrote history');

  // Private things may want to upload
  if (upload) {
    s3.uploadPackages(packageInfo, {
      local: packageDir,
      remote: dirKey + '/packages',
    });

    s3.uploadTestFiles(report.tests, {
      local: ciDir,
      remote: dirKey,
    });
  }

  console.log('Update Directory Indexes');

  let indexKey = `${root}/index.json`;
  const index: PluginDevSummary = await s3.readJSON(indexKey, { branch: {}, pr: {} });
  if (pr) {
    index.pr[pr] = latest;
  } else {
    index.branch[branch] = latest;
  }
  await s3.writeJSON(indexKey, index);

  indexKey = `dev/index.json`;
  const pluginIndex: DevSummary = await s3.readJSON(indexKey, {});
  pluginIndex[pluginMeta.id] = latest;
  await s3.writeJSON(indexKey, pluginIndex);
  console.log('wrote index');
};

export const ciPluginReportTask = new Task<PluginCIOptions>('Generate Plugin Report', pluginReportRunner);
