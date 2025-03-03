module.exports = npm;

const debug = require('debug')('snyk');
const exec = require('child_process').exec;

function npm(method, packages, live, cwd, flags) {
  flags = flags || [];
  if (!packages) {
    packages = [];
  }

  if (!Array.isArray(packages)) {
    packages = [packages];
  }

  // only if we have packages, then always save, otherwise the command might
  // be something like `npm shrinkwrap'
  if (packages.length && !flags.length) {
    flags.push('--save');
  }

  method += ' ' + flags.join(' ');

  return new Promise(((resolve, reject) => {
    const cmd = 'npm ' + method + ' ' + packages.join(' ');
    if (!cwd) {
      cwd = process.cwd();
    }
    debug('%s$ %s', cwd, cmd);

    if (!live) {
      debug('[skipping - dry run]');
      return resolve();
    }

    exec(cmd, {
      cwd: cwd,
    }, (error, stdout, stderr) => {
      if (error) {
        return reject(error);
      }

      if (stderr.indexOf('ERR!') !== -1) {
        console.error(stderr.trim());
        const e = new Error('npm update issues: ' + stderr.trim());
        e.code = 'FAIL_UPDATE';
        return reject(e);
      }

      debug('npm %s complete', method);

      resolve();
    });
  }));
}

npm.getVersion = function () {
  return new Promise(((resolve, reject) => {
    exec('npm --version', {
      cwd: process.cwd(),
    }, (error, stdout) => {
      if (error) {
        return reject(error);
      }
      return resolve(stdout);
    });
  }));
};
