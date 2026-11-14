import { execa, execaNode } from 'execa';
import fkill from 'fkill';
import type { ResultPromise } from 'execa';
import type { Plugin } from 'rolldown';

export function backendDevServerPlugin(): Plugin {
	let backendProcess: ResultPromise | null = null;
	let backendShutdownPromise: Promise<void> | null = null;

	async function runBuildAssets() {
		await execa('pnpm', ['run', 'build-assets'], {
			cwd: '../../',
			stdout: process.stdout,
			stderr: process.stderr,
		});
	}

	async function killBackendProcess() {
		if (backendShutdownPromise) return backendShutdownPromise;
		if (!backendProcess) return;

		const processToKill = backendProcess;
		backendProcess = null;
		processToKill.catch(() => {});

		backendShutdownPromise = (async () => {
			if (process.platform === 'win32' && processToKill.pid != null) {
				await fkill(processToKill.pid, {
					force: true,
					tree: true,
					silent: true,
					waitForExit: 5000,
				});
			} else {
				processToKill.kill();
			}

			await processToKill.catch(() => {});
		})().finally(() => {
			backendShutdownPromise = null;
		});

		return backendShutdownPromise;
	}

	return {
		name: 'backend-dev-server',
		async closeBundle() {
			await runBuildAssets();
			if (backendProcess) {
				await killBackendProcess();
			}
			backendProcess = execaNode('./built/entry.js', [], {
				stdout: process.stdout,
				stderr: process.stderr,
				env: {
					NODE_ENV: 'development',
				},
			});
		},
		async watchChange() {
			if (backendProcess) {
				await killBackendProcess();
				await runBuildAssets();
			}
		},
		async closeWatcher() {
			await killBackendProcess();
		},
	};
}
