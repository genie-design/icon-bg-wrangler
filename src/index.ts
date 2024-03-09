import puppeteer from '@cloudflare/puppeteer';
import type { Fetcher, KVNamespace } from '@cloudflare/workers-types';
import superjson from 'superjson';

interface Env {
	MYBROWSER: puppeteer.BrowserWorker;
	BROWSER: DurableObjectNamespace;
	ICON_BG_BROWSER: KVNamespace;
}
const log = (...text: Parameters<typeof console.log>) => {
	text = text.map((t) => {
		if (typeof t === 'object') {
			try {
				return JSON.stringify(t, null, 2);
			} catch {
				return t.toString();
			}
		}
		return t;
	});
	console.log(...text);
	console.log('-----------------------------------------------');
};

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		let id = env.BROWSER.idFromName('browser');
		let obj = env.BROWSER.get(id);

		// Send a request to the Durable Object, then await its response.
		let resp = await obj.fetch(request.url);

		return resp;
	},
};

const KEEP_BROWSER_ALIVE_IN_SECONDS = 60;

export class Browser {
	state: DurableObjectState;
	env: Env;
	storage: DurableObjectStorage;
	keptAliveInSeconds: number;
	browser: puppeteer.Browser | null;
	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
		this.keptAliveInSeconds = 0;
		this.storage = this.state.storage;
		this.browser = null;
	}

	async fetch(request: Request, env: Env): Promise<Response> {
		if (request.url.includes('/favicon.ico')) {
			return new Response();
		}
		const { searchParams } = new URL(request.url);
		const urlStr = searchParams.get('url');

		let img: ArrayBuffer | null;
		if (urlStr) {
			const url = new URL(urlStr);

			const parsed = parseSearchParams(url.search);

			const parsedOptions = parsed.options;
			if (parsed && parsedOptions && typeof parsedOptions === 'string') {
				const parsedObj = superjson.parse(parsedOptions) as Record<string, unknown>;
				const optionsStr = superjson.stringify(parsedObj);
				url.searchParams.set('options', optionsStr);
				const optionsHashed = await hashString(optionsStr);

				if (!this.browser || !this.browser.isConnected()) {
					console.log(`Browser DO: Starting new instance`);
					try {
						this.browser = await puppeteer.launch(this.env.MYBROWSER);
					} catch (e) {
						console.log(`Browser DO: Could not start browser instance. Error: ${e}`);
					}
				}

				img = await this.env.ICON_BG_BROWSER.get(optionsHashed, { type: 'arrayBuffer' });

				if (img === null && this.browser) {
					// Reset keptAlive after each call to the DO
					this.keptAliveInSeconds = 0;
					const page = await this.browser.newPage();
					const xMax = getNumber(parsedObj['xMax']) || 360;
					const yMax = getNumber(parsedObj['yMax']) || 1600;
					await page.setViewport({ width: xMax, height: yMax });
					await page.goto(url.href);
					img = (await page.screenshot()) as Buffer;
					await this.env.ICON_BG_BROWSER.put(optionsHashed, img, {
						expirationTtl: 60 * 60 * 24,
					});
					await page.close();
					// Reset keptAlive after performing tasks to the DO.
					this.keptAliveInSeconds = 0;
				}
			} else {
				return new Response('Please add options to your url');
			}
			// set the first alarm to keep DO alive
			let currentAlarm = await this.storage.getAlarm();
			if (currentAlarm == null) {
				console.log(`Browser DO: setting alarm`);
				const TEN_SECONDS = 10 * 1000;
				await this.storage.setAlarm(Date.now() + TEN_SECONDS);
			}

			return new Response(img, {
				headers: {
					'content-type': 'image/jpeg',
				},
			});
		} else {
			return new Response('Please add an ?url=https://example.com/ parameter');
		}
	}
	async alarm() {
		this.keptAliveInSeconds += 10;

		// Extend browser DO life
		if (this.keptAliveInSeconds < KEEP_BROWSER_ALIVE_IN_SECONDS) {
			console.log(`Browser DO: has been kept alive for ${this.keptAliveInSeconds} seconds. Extending lifespan.`);
			await this.storage.setAlarm(Date.now() + 10 * 1000);
			// You could ensure the ws connection is kept alive by requesting something
			// or just let it close automatically when there  is no work to be done
			// for example, `await this.browser.version()`
		} else {
			console.log(`Browser DO: exceeded life of ${KEEP_BROWSER_ALIVE_IN_SECONDS}s.`);
			if (this.browser) {
				console.log(`Closing browser.`);
				await this.browser.close();
			}
		}
	}
}
async function hashString(inputStr: string) {
	const encoder = new TextEncoder();
	const data = encoder.encode(inputStr);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	const hashedStr = hashArray.map((byte) => byte.toString(16).padStart(2, '0')).join('');
	return hashedStr;
}
type ParsedParams = {
	[key: string]: string | string[] | undefined;
};

function getNumber(value: unknown): number | undefined {
	let number: Number | undefined = typeof value === 'number' ? value : undefined;
	if (Number.isNaN(number) || typeof number !== 'number') {
		try {
			number = typeof value === 'string' ? parseInt(value) : undefined;
		} catch (e) {
			number = undefined;
		}
	}
	if (Number.isNaN(number) || typeof number !== 'number') {
		number = undefined;
	}
	return number;
}

function parseSearchParams(queryString: string): ParsedParams {
	const params: ParsedParams = {};
	const searchParams = queryString.slice(1).split('&');
	for (let i = 0; i < searchParams.length; i++) {
		const pair = searchParams[i].split('=');
		const key = decodeURIComponent(pair[0]);
		const value = decodeURIComponent(pair[1] || '');
		if (key) {
			if (params[key]) {
				if (Array.isArray(params[key])) {
					(params[key] as string[]).push(value);
				} else {
					params[key] = [params[key] as string, value];
				}
			} else {
				params[key] = value;
			}
		}
	}
	return params;
}
