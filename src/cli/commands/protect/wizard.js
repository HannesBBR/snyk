module.exports = wizard;

// used for testing
module.exports.processAnswers = processAnswers;
module.exports.inquire = inquire;
module.exports.interactive = interactive;
const debug = require('debug')('snyk');

const path = require('path');
const inquirer = require('inquirer');
const fs = require('then-fs');
const tryRequire = require('snyk-try-require');
const chalk = require('chalk');
const url = require('url');
const _ = require('lodash');
const exec = require('child_process').exec;
const {apiTokenExists} = require ('../../../lib/api-token');
const auth = require('../auth/is-authed');
const getVersion = require('../version');
const allPrompts = require('./prompts');
const answersToTasks = require('./tasks');
const snyk = require('../../../lib/');
const snykMonitor = require('../../../lib/monitor').monitor;
const isCI = require('../../../lib/is-ci').isCI;
const protect = require('../../../lib/protect');
const authorization = require('../../../lib/authorization');
const config = require('../../../lib/config');
const spinner = require('../../../lib/spinner');
const analytics = require('../../../lib/analytics');
const alerts = require('../../../lib/alerts');
const npm = require('../../../lib/npm');
const cwd = process.cwd();
const detect = require('../../../lib/detect');
const plugins = require('../../../lib/plugins');
const moduleInfo = require('../../../lib/module-info').ModuleInfo;
const {MisconfiguredAuthInCI} = require('../../../lib/errors/misconfigured-auth-in-ci-error');
const {MissingTargetFileError} = require('../../../lib/errors/missing-targetfile-error');
const pm = require('../../../lib/package-managers');

function wizard(options = {}) {
  options.org = options.org || config.org || null;

  return processPackageManager(options)
    .then(processWizardFlow)
    .catch((error) => Promise.reject(error));
}

async function processPackageManager(options) {
  const packageManager = detect.detectPackageManager(cwd, options);

  const supportsWizard = pm.WIZARD_SUPPORTED_PACKAGE_MANAGERS
    .includes(packageManager);
  if (!supportsWizard) {
    return Promise.reject(
      `Snyk wizard for ${pm.SUPPORTED_PACKAGE_MANAGER_NAME[packageManager]} projects is not currently supported`);
  }

  return fs.exists(path.join('.', 'node_modules'))
    .then((nodeModulesExist) => {
      if (!nodeModulesExist) {
        // throw a custom error
        throw new Error(
          'Missing node_modules folder: we can\'t patch without having installed packages.' +
          `\nPlease run '${packageManager} install' first.`);
      }
      return options;
    });
}

function processWizardFlow(options) {
  spinner.sticky();
  const message = options['dry-run'] ? '*** dry run ****' : '~~~~ LIVE RUN ~~~~';
  debug(message);

  return snyk.policy.load(options['policy-path'], options)
    .catch((error) => {
    // if we land in the catch, but we're in interactive mode, then it means
    // the file hasn't been created yet, and that's fine, so we'll resolve
    // with an empty object
      if (error.code === 'ENOENT') {
        options.newPolicy = true;
        return snyk.policy.create();
      }

      throw error;
    })
    .then((cliPolicy) => {
      return auth.isAuthed().then((authed) => {
        analytics.add('inline-auth', !authed);
        if (!authed) {
          if (isCI()) {
            throw MisconfiguredAuthInCI();
          }
        }
        apiTokenExists();
      })
        .then(() => authorization.actionAllowed('cliIgnore', options))
        .then((cliIgnoreAuthorization) => {
          options.ignoreDisabled = cliIgnoreAuthorization.allowed ?
            false : cliIgnoreAuthorization;
          if (options.ignoreDisabled) {
            debug('ignore disabled');
          }
          const intro = __dirname + '/../../../../help/wizard.txt';
          return fs.readFile(intro, 'utf8').then((str) => {
            if (!isCI()) {
              console.log(str);
            }
          })
            .then(() => {
              return new Promise((resolve) => {
                if (options.newPolicy) {
                  return resolve(); // don't prompt to start over
                }
                inquirer.prompt(allPrompts.startOver()).then((answers) => {
                  analytics.add('start-over', answers['misc-start-over']);
                  if (answers['misc-start-over']) {
                    options['ignore-policy'] = true;
                  }
                  resolve();
                });
              });
            })
            .then(() => {
              // We need to have modules information for remediation. See Payload.modules
              options.traverseNodeModules = true;

              return snyk.test(cwd, options).then((res) => {
                if (alerts.hasAlert('tests-reached') && res.isPrivate) {
                  return;
                }
                const packageFile = path.resolve(cwd, 'package.json');
                if (!res.ok) {
                  const vulns = res.vulnerabilities;
                  const paths = vulns.length === 1 ? 'path' : 'paths';
                  const ies = vulns.length === 1 ? 'y' : 'ies';
                  // echo out the deps + vulns found
                  console.log('Tested %s dependencies for known vulnerabilities, %s',
                    res.dependencyCount,
                    chalk.bold.red('found ' +
                    res.uniqueCount +
                    ' vulnerabilit' + ies +
                    ', ' + vulns.length +
                    ' vulnerable ' +
                    paths + '.'));
                } else {
                  console.log(chalk.green('✓ Tested %s dependencies for known ' +
                  'vulnerabilities, no vulnerable paths found.'),
                  res.dependencyCount);
                }

                return snyk.policy.loadFromText(res.policy)
                  .then((combinedPolicy) => {
                    return tryRequire(packageFile).then((pkg) => {
                      options.packageLeading = pkg.prefix;
                      options.packageTrailing = pkg.suffix;
                      return interactive(res, pkg, combinedPolicy, options)
                        .then((answers) => processAnswers(answers, cliPolicy, options));
                    });
                  });
              });
            });
        });
    });
}

function interactive(test, pkg, policy, options) {
  const vulns = test.vulnerabilities;
  if (!policy) {
    policy = {};
  }

  if (!pkg) { // only really happening in tests
    pkg = {};
  }

  return new Promise(((resolve) => {
    debug('starting questions');
    const prompts = allPrompts.getUpdatePrompts(vulns, policy, options);
    resolve(inquire(prompts, {}));
  })).then((answers) => {
    const prompts = allPrompts.getPatchPrompts(vulns, policy, options);
    return inquire(prompts, answers);
  }).then((answers) => {
    const prompts = allPrompts.getIgnorePrompts(vulns, policy, options);
    return inquire(prompts, answers);
  }).then((answers) => {
    const prompts = allPrompts.nextSteps(pkg, test.ok ? false : answers);
    return inquire(prompts, answers);
  }).then((answers) => {
    if (pkg.shrinkwrap) {
      answers['misc-build-shrinkwrap'] = true;
    }
    return answers;
  });
}

function inquire(prompts, answers) {
  if (prompts.length === 0) {
    return Promise.resolve(answers);
  }
  // inquirer will handle dots in name as path in hash (CSUP-272)
  prompts.forEach((prompt) => {
    prompt.name = prompt.name.replace(/\./g, '--DOT--');
  });
  return new Promise(((resolve) => {
    inquirer.prompt(prompts).then((theseAnswers) => {
      _.extend(answers, theseAnswers);
      Object.keys(answers).forEach((answerName) => {
        if (answerName.indexOf('--DOT--') > -1) {
          const newName = answerName.replace(/--DOT--/g, '.');
          answers[newName] = answers[answerName];
          delete answers[answerName];
        }
      });
      resolve(answers);
    });
  }));
}

function getNewScriptContent(scriptContent, cmd) {
  if (scriptContent) {
    // only add the command if it's not already in the script
    if (scriptContent.indexOf(cmd) === -1) {
      return cmd + '; ' + scriptContent;
    }
    return scriptContent;
  }
  return cmd;
}

function addProtectScripts(existingScripts, npmVersion, options) {
  console.log('addProtect', npmVersion);
  const scripts = existingScripts ? _.cloneDeep(existingScripts) : {};
  scripts['snyk-protect'] = 'snyk protect';

  let cmd = 'npm run snyk-protect';

  // legacy check for `postinstall`, if `npm run snyk-protect` is in there
  // we'll replace it with `true` so it can be cleanly swapped out
  const postinstall = scripts.postinstall;
  if (postinstall && postinstall.indexOf(cmd) !== -1) {
    scripts.postinstall = postinstall.replace(cmd, 'true');
  }

  if (options.packageManager === 'yarn') {
    cmd = 'yarn run snyk-protect';
    scripts.prepare = getNewScriptContent(scripts.prepare, cmd);
    return scripts;
  }

  const npmVersionMajor = parseInt(npmVersion.split('.')[0]);
  if (npmVersionMajor >= 5) {
    scripts.prepare = getNewScriptContent(scripts.prepare, cmd);

    return scripts;
  }

  scripts.prepublish = getNewScriptContent(scripts.prepublish, cmd);

  return scripts;
}

function processAnswers(answers, policy, options) {
  if (!options) {
    options = {};
  }
  options.packageLeading = options.packageLeading || '';
  options.packageTrailing = options.packageTrailing || '';
  // allow us to capture the answers the users gave so we can combine this
  // the scenario running
  if (options.json) {
    return Promise.resolve(JSON.stringify(answers, '', 2));
  }
  const cwd = process.cwd();
  const packageFile = path.resolve(cwd, 'package.json');
  const packageManager = detect.detectPackageManager(cwd, options);
  const targetFile = options.file || detect.detectPackageFile(cwd);
  if (!targetFile) {
    throw MissingTargetFileError(cwd);
  }
  const isLockFileBased = targetFile.endsWith('package-lock.json') || targetFile.endsWith('yarn.lock');

  let pkg = {};

  analytics.add('answers', Object.keys(answers).map((key) => {
    // if we're looking at a reason, skip it
    if (key.indexOf('-reason') !== -1) {
      return;
    }

    // ignore misc questions, like "add snyk test to package?"
    if (key.indexOf('misc-') === 0) {
      return;
    }

    const answer = answers[key];
    const res = {
      vulnId: answer.vuln.id,
      choice: answer.choice,
      from: answer.vuln.from.slice(1),
    };

    if (answer.vuln.grouped) {
      res.batchMain = !!answer.vuln.grouped.main;
      res.batch = true;
    }

    return res;
  }).filter(Boolean));

  const tasks = answersToTasks(answers);
  debug(tasks);

  const live = !options['dry-run'];
  let snykVersion = '*';

  const res = protect.generatePolicy(policy, tasks, live, options.packageManager)
    .then((policy) => {
      if (!live) {
      // if this was a dry run, we'll throw an error to bail out of the
      // promise chain, then in the catch, check the error.code and if
      // it matches `DRYRUN` we'll return the text and not an error
      // (which avoids the exit code 1).
        const e = new Error('This was a dry run: nothing changed');
        e.code = 'DRYRUN';
        throw e;
      }

      return policy.save(cwd, spinner).then(() => {
      // don't do this during testing
        if (isCI() || process.env.TAP) {
          return Promise.resolve();
        }

        return new Promise(((resolve) => {
          exec('git add .snyk', {
            cwd: cwd,
          }, (error, stdout, stderr) => {
            if (error) {
              debug('error adding .snyk to git', error);
            }

            if (stderr) {
              debug('stderr adding .snyk to git', stderr.trim());
            }

            // resolve either way
            resolve();
          });
        }));
      });
    })
    .then(() => {
    // re-read the package.json - because the generatePolicy can apply
    // an `npm install` which will change the deps
      return fs.readFile(packageFile, 'utf8')
        .then(JSON.parse)
        .then((updatedPkg) => {
          pkg = updatedPkg;
        });
    })
    .then(getVersion)
    .then((v) => {
      debug('snyk version: %s', v);
      // little hack to circumvent local testing where the version will
      // be the git branch + commit
      if (v.match(/^\d+\./) === null) {
        v = '*';
      } else {
        v = '^' + v;
      }
      snykVersion = v;
    })
    .then(() => {
      analytics.add('add-snyk-test', answers['misc-add-test']);
      if (!answers['misc-add-test']) {
        return;
      }

      debug('adding `snyk test` to package');

      if (!pkg.scripts) {
        pkg.scripts = {};
      }

      const test = pkg.scripts.test;
      const cmd = 'snyk test';
      if (test && test !== 'echo "Error: no test specified" && exit 1') {
      // only add the test if it's not already in the test
        if (test.indexOf(cmd) === -1) {
          pkg.scripts.test = cmd + ' && ' + test;
        }
      } else {
        pkg.scripts.test = cmd;
      }
    })
    .then(() => {
      return npm.getVersion();
    })
    .then((npmVersion) => {
      analytics.add('add-snyk-protect', answers['misc-add-protect']);
      if (!answers['misc-add-protect']) {
        return;
      }

      debug('adding `snyk protect` to package');

      if (!pkg.scripts) {
        pkg.scripts = {};
      }

      pkg.scripts = addProtectScripts(pkg.scripts, npmVersion, options);

      pkg.snyk = true;
    })
    .then(() => {
      let lbl = 'Updating package.json...';
      const addSnykToDependencies = answers['misc-add-test'] || answers['misc-add-protect'];
      let updateSnykFunc = () => protect.install(packageManager, ['snyk'], live);

      if (addSnykToDependencies) {
        debug('updating %s', packageFile);

        if (_.get(pkg, 'dependencies.snyk') ||
          _.get(pkg, 'peerDependencies.snyk') ||
          _.get(pkg, 'optionalDependencies.snyk')) {
        // nothing to do as the user already has Snyk
        // TODO decide whether we should update the version being used
        // and how do we reconcile if the global install is older
        // than the local version?
        } else {
          const addSnykToProdDeps = answers['misc-add-protect'];
          const snykIsInDevDeps = _.get(pkg, 'devDependencies.snyk');

          if (addSnykToProdDeps) {
            if (!pkg.dependencies) {
              pkg.dependencies = {};
            }
            pkg.dependencies.snyk = snykVersion;
            lbl = 'Adding Snyk to production dependencies ' +
                '(used by snyk protect)';

            // but also check if we should remove it from devDependencies
            if (snykIsInDevDeps) {
              delete pkg.devDependencies.snyk;
            }
          } else if (!snykIsInDevDeps) {
            if (!pkg.devDependencies) {
              pkg.devDependencies = {};
            }
            lbl = 'Adding Snyk to devDependencies (used by npm test)';
            pkg.devDependencies.snyk = snykVersion;
            updateSnykFunc = () => protect.installDev(packageManager, ['snyk'], live);

          }
        }
      }

      if (addSnykToDependencies ||
          tasks.update.length) {
        const packageString = options.packageLeading + JSON.stringify(pkg, '', 2) +
                          options.packageTrailing;
        return spinner(lbl)
          .then(fs.writeFile(packageFile, packageString))
          .then(() => {
            if (isLockFileBased) {
              // we need to trigger a lockfile update after adding snyk
              // as a dep
              return updateSnykFunc();
            }
          })
          // clear spinner in case of success or failure
          .then(spinner.clear(lbl))
          .catch((error) => {
            spinner.clear(lbl)();
            throw error;
          });
      }
    })
    .then(() => {
      if (answers['misc-build-shrinkwrap'] && tasks.update.length) {
        debug('updating shrinkwrap');

        const lbl = 'Updating npm-shrinkwrap.json...';
        return spinner(lbl)
          .then(npm.bind(null, 'shrinkwrap', null, live, cwd, null))
          // clear spinner in case of success or failure
          .then(spinner.clear(lbl))
          .catch((error) => {
            spinner.clear(lbl)();
            throw error;
          });
      }
    })
    .then(() => {
      if (answers['misc-test-no-monitor']) { // allows us to automate tests
        return {
          id: 'test',
        };
      }

      debug('running monitor');
      const lbl = 'Remembering current dependencies for future ' +
      'notifications...';
      const meta = {method: 'wizard', packageManager};
      const plugin = plugins.loadPlugin(packageManager);
      const info = moduleInfo(plugin, options.policy);

      if (isLockFileBased) {
        // TODO: fix this by providing better patch support for yarn
        // yarn hoists packages up a tree so we can't assume their location
        // on disk without traversing node_modules
        // currently the npm@2 nd npm@3 plugin resolve-deps can do this
        // but not the latest node-lockfile-parser
        // HACK: for yarn set traverseNodeModules option to true
        // bypass lockfile test for wizard, but set this back
        // before we monitor
        options.traverseNodeModules = false;
      }

      return info.inspect(cwd, targetFile, options)
        .then(spinner(lbl))
        .then(snykMonitor.bind(null, cwd, meta))
        // clear spinner in case of success or failure
        .then(spinner.clear(lbl))
        .catch((error) => {
          spinner.clear(lbl)();
          throw error;
        });
    })
    .then((monitorRes) => {
      const endpoint = url.parse(config.API);
      let leader = '';
      if (monitorRes.org) {
        leader = '/org/' + monitorRes.org;
      }
      endpoint.pathname = leader + '/monitor/' + monitorRes.id;
      const monitorUrl = url.format(endpoint);
      endpoint.pathname = leader + '/manage';
      const manageUrl = url.format(endpoint);

      return (options.newPolicy ?
      // if it's a newly created file
        '\nYour policy file has been created with the actions you\'ve ' +
        'selected, add it to your source control (`git add .snyk`).' :
      // otherwise we updated it
        '\nYour .snyk policy file has been successfully updated.') +
      '\nTo review your policy, run `snyk policy`.\n\n' +
      'You can see a snapshot of your dependencies here:\n' +
      monitorUrl + '\n\n' +
      (monitorRes.isMonitored ?
        'We\'ll notify you when relevant new vulnerabilities are ' +
      'disclosed.\n\n' :
        chalk.bold.red('Project is inactive, so notifications are turned off.\n' +
      'Activate this project here: ' + manageUrl + '\n')) +
      (monitorRes.trialStarted ?
        chalk.yellow('You\'re over the free plan usage limit, \n' +
      'and are now on a free 14-day premium trial.\n' +
      'View plans here: ' + manageUrl + '\n\n') :
        '');
    })
    .catch((error) => {
    // if it's a dry run - exit with 0 status
      if (error.code === 'DRYRUN') {
        return error.message;
      }

      throw error;
    });

  return res;
}
