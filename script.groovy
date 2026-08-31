def buildApp() {
    echo 'Using the configured Node.js toolchain...'
    runCommand('node --version')
    runCommand('pnpm --version')

    echo 'Installing application dependencies...'
    runCommand('pnpm install --frozen-lockfile')
}

def testApp() {
    echo 'Running application checks...'
    runCommand('pnpm check')
}

def deployApp() {
    echo 'Deployment server is not configured; skipping deployment.'

    // Enable this after a deployment server and command are configured.
    // runCommand('./scripts/deploy.sh')
}

def runCommand(String command) {
    if (isUnix()) {
        sh command
    } else {
        bat command
    }
}

return this
