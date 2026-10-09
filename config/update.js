// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck
const path = require('path');
const { execSync } = require('child_process');
const { askQuestion, isDockerRunning, deleteNodeModules, silentExit } = require('./helpers');

const config = {
  bun: process.argv.includes('-b'),
  local: process.argv.includes('-l'),
  docker: process.argv.includes('-d'),
  singleCompose: process.argv.includes('-s'),
  useSudo: process.argv.includes('--sudo'),
  skipGit: process.argv.includes('-g'),
};

// Set the directories
const rootDir = path.resolve(__dirname, '..');
const directories = [
  rootDir,
  path.resolve(rootDir, 'packages', 'data-provider'),
  path.resolve(rootDir, 'packages', 'data-schemas'),
  path.resolve(rootDir, 'packages', 'client'),
  path.resolve(rootDir, 'packages', 'api'),
  path.resolve(rootDir, 'client'),
  path.resolve(rootDir, 'api'),
];

async function updateConfigWithWizard() {
  if (!config.docker && !config.singleCompose) {
    config.docker = (await askQuestion('Are you using Docker? (y/n): '))
      .toLowerCase()
      .startsWith('y');
  }

  if (config.docker && !config.singleCompose) {
    config.singleCompose = !(
      await askQuestion('Are you using the default docker-compose file? (y/n): ')
    )
      .toLowerCase()
      .startsWith('y');
  }
}

async function validateDockerRunning() {
  if (!config.docker && config.singleCompose) {
    config.docker = true;
  }

  if (config.docker && !isDockerRunning()) {
    console.red(
      'Error: Docker is not running. You will need to start Docker Desktop or if using linux/mac, run `sudo systemctl start docker`',
    );
    silentExit(1);
  }
}

(async () => {
  const showWizard = !config.local && !config.docker && !config.singleCompose;

  if (showWizard) {
    await updateConfigWithWizard();
  }

  console.green(
    'Starting update script, this may take a minute or two depending on your system and network.',
  );

  await validateDockerRunning();
  const { docker, singleCompose, useSudo, skipGit, bun } = config;
  const sudo = useSudo ? 'sudo ' : '';
  if (!skipGit) {
    // Fetch latest repo
    console.purple('Fetching the latest repo...');
    execSync('git fetch origin', { stdio: 'inherit' });

    // Switch to main branch
    console.purple('Switching to main branch...');
    execSync('git checkout main', { stdio: 'inherit' });

    // Git pull origin main
    console.purple('Pulling the latest code from main...');
    execSync('git pull origin main', { stdio: 'inherit' });
  }

  if (docker) {
    console.purple('Removing previously made Docker container...');
    const downCommand = `${sudo}docker compose ${
      singleCompose ? '-f ./docs/dev/single-compose.yml ' : ''
    }down`;
    console.orange(downCommand);
    execSync(downCommand, { stdio: 'inherit' });
    console.purple('Pruning all LibreChat Docker images...');

    const imageName = singleCompose ? 'librechat_single' : 'librechat';
    try {
      execSync(`${sudo}docker rmi ${imageName}:latest`, { stdio: 'inherit' });
    } catch (_error) {
      console.purple('Failed to remove Docker image librechat:latest. It might not exist.');
    }
    console.purple('Removing all unused dangling Docker images...');
    execSync(`${sudo}docker image prune -f`, { stdio: 'inherit' });
    console.purple('Building new LibreChat image...');
    const buildCommand = `${sudo}docker compose ${
      singleCompose ? '-f ./docs/dev/single-compose.yml ' : ''
    }build --no-cache`;
    console.orange(buildCommand);
    execSync(buildCommand, { stdio: 'inherit' });
  } else {
    // Delete all node_modules
    directories.forEach(deleteNodeModules);

    // Run npm cache clean --force
    console.purple('Cleaning npm cache...');
    execSync('npm cache clean --force', { stdio: 'inherit' });

    // Install dependencies
    console.purple('Installing dependencies...');
    execSync('npm ci', { stdio: 'inherit' });

    // Build client-side code
    console.purple('Building frontend...');
    execSync(bun ? 'bun b:client' : 'npm run frontend', { stdio: 'inherit' });
  }

  let startCommand = 'npm run backend';
  if (docker) {
    startCommand = `${sudo}docker compose ${
      singleCompose ? '-f ./docs/dev/single-compose.yml ' : ''
    }up`;
  }
  console.green('Your LibreChat app is now up to date! Start the app with the following command:');
  console.purple(startCommand);
  console.orange(
    "Note: it's also recommended to clear your browser cookies and localStorage for LibreChat to assure a fully clean installation.",
  );
  console.orange("Also: Don't worry, your data is safe :)");
})();
