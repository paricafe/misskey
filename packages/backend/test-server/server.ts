import { portToPid } from 'pid-port';
import fkill from 'fkill';
import Fastify from 'fastify';
import { NestFactory } from '@nestjs/core';
import { MainModule } from '@/MainModule.js';
import { ServerService } from '@/server/ServerService.js';
import { loadConfig } from '@/config.js';
import { NestLogger } from '@/NestLogger.js';
import { INestApplicationContext } from '@nestjs/common';
import type { FastifyInstance } from 'fastify';

const config = loadConfig();
const originEnv = JSON.stringify(process.env);

process.env.NODE_ENV = 'test';

let app: INestApplicationContext;
let serverService: ServerService;
let controller: FastifyInstance | undefined;

export async function setup() {
	await killTestServer();

	console.log('starting application...');

	app = await NestFactory.createApplicationContext(MainModule, {
		logger: new NestLogger(),
	});
	serverService = app.get(ServerService);
	await serverService.launch();

	await startControllerEndpoints();

	console.log('application initialized.');
}

export async function teardown() {
	await controller?.close();
	controller = undefined;

	await serverService.dispose();
	await app.close();
	await killTestServer();
}

async function killTestServer() {
	try {
		const pid = await portToPid(config.port);
		if (pid) {
			await fkill(pid, { force: true });
		}
	} catch {
	}
}

async function startControllerEndpoints(port = config.port + 1000) {
	const fastify = Fastify();
	controller = fastify;

	fastify.post<{ Body: { key?: string, value?: string } }>('/env', async (req, res) => {
		console.log(req.body);
		const key = req.body['key'];
		if (!key) {
			res.code(400).send({ success: false });
			return;
		}

		process.env[key] = req.body['value'];

		res.code(200).send({ success: true });
	});

	fastify.post<{ Body: { key?: string, value?: string } }>('/env-reset', async (req, res) => {
		process.env = JSON.parse(originEnv);

		await serverService.dispose();
		await app.close();

		await killTestServer();

		console.log('starting application...');

		app = await NestFactory.createApplicationContext(MainModule, {
			logger: new NestLogger(),
		});
		serverService = app.get(ServerService);
		await serverService.launch();

		res.code(200).send({ success: true });
	});

	await fastify.listen({ port: port, host: 'localhost' });
}
