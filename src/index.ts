import puppeteer from '@cloudflare/puppeteer';
import type { Fetcher, KVNamespace } from '@cloudflare/workers-types';
import superjson from 'superjson';

interface Env {
	MYBROWSER: puppeteer.BrowserWorker;
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
				// await env.ICON_BG_BROWSER.delete(optionsHashed);
				img = await env.ICON_BG_BROWSER.get(optionsHashed, { type: 'arrayBuffer' });
				if (img === null) {
					const browser = await puppeteer.launch(env.MYBROWSER);
					const page = await browser.newPage();
					const xMax = getNumber(parsedObj['xMax']) || 360;
					const yMax = getNumber(parsedObj['yMax']) || 1600;
					await page.setViewport({ width: xMax, height: yMax });
					await page.goto(url.href);
					img = (await page.screenshot()) as Buffer;
					await env.ICON_BG_BROWSER.put(optionsHashed, img, {
						expirationTtl: 60 * 60 * 24,
					});
					await browser.close();
				}
			} else {
				return new Response('Please add options to your url');
			}
			return new Response(img, {
				headers: {
					'content-type': 'image/jpeg',
				},
			});
		} else {
			return new Response('Please add an ?url=https://example.com/ parameter');
		}
	},
};
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
