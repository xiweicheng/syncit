<script lang="ts">
	import { onMount, onDestroy, tick } from 'svelte';
	import { Replayer, EventType, pack } from 'rrweb';
	import type { customEvent, eventWithTime } from '@rrweb/types';
	import { quintOut } from 'svelte/easing';
	import { scale } from 'svelte/transition';
	import { TransporterEvents, type Transporter, type TransportSendRecordEvent } from '@syncit/core';
	import {
		MirrorBuffer,
		CustomEventTags,
		formatBytes,
		isIgnoredOnRmoteControl,
		createAppService,
		createAppControlService,
		type Chunk
	} from '@syncit/core';
	import Panel from './components/Panel.svelte';
	import LineChart from './components/LineChart.svelte';
	import Icon from './components/Icon.svelte';
	import Canvas from './components/Canvas.svelte';
	import PDF from './components/PDF.svelte';
	import { t, setCurrentLanguage} from '../locales';
	import type { PaintingConfig } from './types';

	let uid = '';

	export let createTransporter: ({ role, uid }: { role: string; uid: string }) => Transporter;
	export let lang: string | undefined = undefined;
	export let bufferMs: number;

	let transporter: Transporter;
	let login: undefined | Promise<void>;

	let playerDom: HTMLElement;
	let replayer: Replayer;
	const buffer = new MirrorBuffer<eventWithTime>({
		bufferMs,
		onChunk({ data }) {
			if (!controlCurrent.matches('controlling') || !isIgnoredOnRmoteControl(data)) {
				replayer.addEvent(data);
			}
		}
	});
	let latencies: Array<{ x: number; y: number }> = [];
	let sizes: Array<{ x: number; y: number }> = [];

	const service = createAppService(() => {
		replayer.pause();
		playerDom.innerHTML = '';
		buffer.reset();
		latencies = [];
		sizes = [];
	});
	let current = service.getSnapshot();

	let controlService: ReturnType<typeof createAppControlService>;
	let controlCurrent: ReturnType<typeof createAppControlService>['state'];

	let open = false;

	let painting = false;
	let paintingConfig = {
		stroke: '#df4b26',
		strokeWidth: 5,
		mode: 'brush'
	};
	let canvasEl: Canvas;

	let sharingPDF = false;
	let pdfEl: PDF;

	function init() {
		transporter = createTransporter({
			role: 'app',
			uid
		});

		transporter.on(TransporterEvents.SourceReady, () => {
			service.send('SOURCE_READY');
			replayer = new Replayer([], {
				root: playerDom,
				loadTimeout: 100,
				liveMode: true,
				insertStyleRules: [
					'.syncit-embed, #syncit-canvas, #syncit-pdf { display: none !important }'
				],
				showWarning: true,
				showDebug: true,
				mouseTail: false
			});

			replayer.on('custom-event', (event) => {
				switch ((event as customEvent).data.tag) {
					case CustomEventTags.StartPaint:
						painting = true;
						break;
					case CustomEventTags.EndPaint:
						painting = false;
						break;
					case CustomEventTags.SetPaintingConfig:
						paintingConfig = (event as customEvent<{ config: PaintingConfig }>).data.payload.config;
						break;
					case CustomEventTags.StartLine:
						canvasEl && canvasEl.startLine();
						break;
					case CustomEventTags.EndLine:
						canvasEl && canvasEl.endLine();
						break;
					case CustomEventTags.DrawLine:
						canvasEl &&
							canvasEl.setPoints((event as customEvent<{ points: number }>).data.payload.points);
						break;
					case CustomEventTags.Highlight:
						canvasEl &&
							canvasEl.highlight(
								(event as customEvent<{ top: number; left: number }>).data.payload.left,
								(event as customEvent<{ top: number; left: number }>).data.payload.top
							);
						break;
					default:
				}
			});

			controlService = createAppControlService({
				transporter,
				replayer
			});
			controlCurrent = controlService.state;

			controlService.start();
			controlService.subscribe((state) => {
				controlCurrent = state;
			});

			transporter.sendStart();
		});

		transporter.on(TransporterEvents.SendRecord, (data) => {
			const { id, data: event, t } = (data as TransportSendRecordEvent).payload;
			if (!current.matches('connected')) {
				replayer.startLive(event.timestamp - buffer.bufferMs);
				service.send('FIRST_RECORD');
			}
			if (event.type === EventType.Custom) {
				switch (event.data.tag) {
					case CustomEventTags.Ping:
						latencies = latencies.concat({ x: t, y: Date.now() - t });
						break;
					case CustomEventTags.MouseSize:
						mouseSize = `syncit-mouse-s${
							(event as customEvent<{ level: number }>).data.payload.level
						}`;
						break;
					case CustomEventTags.AcceptRemoteControl:
						controlService.send({
							type: 'ACCEPTED',
							payload: { replayer }
						});
						break;
					case CustomEventTags.StopRemoteControl:
						controlService.send('STOP_CONTROL');
						break;
					case CustomEventTags.OpenPDF:
						sharingPDF = true;
						tick().then(() => {
							pdfEl.renderPDF({
								dataURI: (event as customEvent<{ dataURI: string | ArrayBuffer | null }>).data
									.payload.dataURI
							});
						});
						break;
					case CustomEventTags.ClosePDF:
						sharingPDF = false;
						break;
					default:
						break;
				}
			}
			Promise.resolve().then(() => collectSize(t, JSON.stringify(event)));
			const chunk: Chunk<eventWithTime> = { id, data: event, t: event.timestamp };
			buffer.addWithCheck(chunk);
			transporter.ackRecord(id);
		});
		transporter.on(TransporterEvents.Stop, () => {
			service.send('STOP');
		});

		login = (async () => {
			await transporter.login();
			await transporter.sendMirrorReady();
		})();
	}

	function reset() {
		service.send('RESET');
		login = undefined;
		uid = '';
	}

	function normalizePoints(points: { x: number; y: number }[]) {
		if (points.length > 20) {
			points = points.slice(points.length - 20, points.length);
		} else {
			points = new Array(20 - points.length)
				.fill(null)
				.map((_, idx) => ({
					x: points[0] ? points[0].x - 1000 * (21 - points.length - idx) : 0,
					y: 0
				}))
				.concat(points);
		}
		return points;
	}
	$: _latencies = normalizePoints(latencies);
	$: _sizes = normalizePoints(sizes);
	$: {
		if (latencies.length > 20) {
			latencies = latencies.slice(latencies.length - 20, latencies.length);
		}
		if (sizes.length > 20) {
			sizes = sizes.slice(sizes.length - 20, sizes.length);
		}
	}
	$: lastSize = formatBytes(_sizes[_sizes.length - 1].y);
	function getSizeOfString(str: string) {
		return encodeURI(str).split(/%(?:u[0-9A-F]{2})?[0-9A-F]{2}|./).length - 1;
	}
	function collectSize(timestamp: number, str: string) {
		if (sizes.length === 0) {
			sizes.push({ x: Date.now(), y: 0 });
		}
		const lastSize = sizes[sizes.length - 1];
		const size = getSizeOfString(str);
		if (timestamp - lastSize.x < 1000) {
			lastSize.y += size;
		} else {
			sizes.push({ x: Date.now(), y: size });
		}
		sizes = sizes;
	}

	let mouseSize = 'syncit-mouse-s2';

	onMount(() => {

		if (lang) {
			setCurrentLanguage(lang);
		}

		service.start();
		service.subscribe((state) => {
			current = state;
		});
	});
	onDestroy(() => {
		service.stop();
		controlService.stop();
	});
</script>

<div class="syncit-app {mouseSize}">
	<div bind:this={playerDom} />
	{#if current.matches('idle')}
		<!---->
		{#if !login}
			<div class="syncit-center">
				<div class="syncit-load-text syncit-hint align-center">
					<label>
						{t('app.remoteUid')}
						<input
							type="text"
							bind:value={uid}
							on:keydown={(e) => e.code === 'Enter' && uid && init()}
						/>
					</label>
					<button class="syncit-btn" on:click={init} disabled={!uid}>
						{t('app.connect')}
					</button>
				</div>
			</div>
		{:else}
			<!---->
			{#await login}
				<div class="syncit-load-text syncit-center">
					{t('app.initializing')}...
				</div>
			{:then}
				<!---->
			{:catch error}
				<div class="syncit-error syncit-center">{error.message}</div>
			{/await}
			<!---->
		{/if}
		<!---->
	{/if}
	<!---->
	{#if current.matches('waiting_first_record')}
		<div class="syncit-load-text syncit-center">{t('app.ready')}</div>
	{:else if current.matches('connected')}
		<div class="syncit-app-control">
			{#if open}
				<div
					transition:scale={{ duration: 500, opacity: 0.5, easing: quintOut }}
					style="transform-origin: right bottom;"
				>
					<Panel>
						<div class="syncit-metric">
							<div class="syncit-chart-title">
								{t('app.latency')}
								<span style="color: #41efc5;">
									{_latencies.length ? _latencies[_latencies.length - 1].y : '-'}
									ms
								</span>
							</div>
							<div class="syncit-metric-line">
								<LineChart points={_latencies} />
							</div>
						</div>
						<div class="syncit-metric">
							<div class="syncit-chart-title">
								{t('app.bandwidth')}
								<span style="color: #8c83ed;">
									{lastSize.value}
									{lastSize.unit}
								</span>
							</div>
							<div class="syncit-metric-line">
								<LineChart points={_sizes} color="#8C83ED" />
							</div>
						</div>
						<div>
							<p>{t('app.remoteControl')}</p>
							{#if controlCurrent.matches('not_control')}
								<button class="syncit-btn ordinary" on:click={() => controlService.send('REQUEST')}>
									{t('app.requestToControl')}
								</button>
							{:else if controlCurrent.matches('requested')}
								<button class="syncit-btn ordinary" disabled>
									{t('app.requested')}
								</button>
							{:else if controlCurrent.matches('controlling')}
								<button
									class="syncit-btn ordinary"
									on:click={() => controlService.send('STOP_CONTROL')}
								>
									{t('app.stopControl')}
								</button>
							{/if}
						</div>
					</Panel>
				</div>
			{/if}
			<!---->
			<button class="syncit-toggle syncit-btn" on:click={() => (open = !open)}>
				<Icon name={open ? 'close' : 'team'} />
			</button>
		</div>
	{:else if current.matches('stopped')}
		<div class="syncit-center">
			<div class="syncit-load-text syncit-hint">
				<div>{t('app.aborted')}</div>
				<button class="syncit-btn" on:click={reset} style="display: block; margin: 0.5em auto;">
					{t('app.reset')}
				</button>
			</div>
		</div>
	{/if}
</div>

{#if painting}
	<Canvas role="slave" bind:this={canvasEl} {...paintingConfig} />
{/if}

{#if sharingPDF}
	<PDF bind:this={pdfEl} />
{/if}

<style>
	:global(body) {
		margin: 0;
		padding: 0;
		font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
	}
	:global(iframe) {
		border: none;
	}
	:global(p) {
		margin-top: 0;
		margin-bottom: 8px;
	}
	:global(.replayer-wrapper) {
		position: relative;
	}
	:global(.replayer-mouse) {
		position: absolute;
		width: 20px;
		height: 20px;
		transition: 0.05s linear;
		background-size: contain;
		background-position: center center;
		background-repeat: no-repeat;
		background-image: url('data:image/svg+xml;base64,PHN2ZyBoZWlnaHQ9JzMwMHB4JyB3aWR0aD0nMzAwcHgnICBmaWxsPSIjMDAwMDAwIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIGRhdGEtbmFtZT0iTGF5ZXIgMSIgdmlld0JveD0iMCAwIDUwIDUwIiB4PSIwcHgiIHk9IjBweCI+PHRpdGxlPkRlc2lnbl90bnA8L3RpdGxlPjxwYXRoIGQ9Ik00OC43MSw0Mi45MUwzNC4wOCwyOC4yOSw0NC4zMywxOEExLDEsMCwwLDAsNDQsMTYuMzlMMi4zNSwxLjA2QTEsMSwwLDAsMCwxLjA2LDIuMzVMMTYuMzksNDRhMSwxLDAsMCwwLDEuNjUuMzZMMjguMjksMzQuMDgsNDIuOTEsNDguNzFhMSwxLDAsMCwwLDEuNDEsMGw0LjM4LTQuMzhBMSwxLDAsMCwwLDQ4LjcxLDQyLjkxWm0tNS4wOSwzLjY3TDI5LDMyYTEsMSwwLDAsMC0xLjQxLDBsLTkuODUsOS44NUwzLjY5LDMuNjlsMzguMTIsMTRMMzIsMjcuNThBMSwxLDAsMCwwLDMyLDI5TDQ2LjU5LDQzLjYyWiI+PC9wYXRoPjwvc3ZnPg==');
	}
	.syncit-mouse-s1 :global(.replayer-mouse) {
		width: 10px;
		height: 10px;
	}
	.syncit-mouse-s2 :global(.replayer-mouse) {
		width: 20px;
		height: 20px;
	}
	.syncit-mouse-s3 :global(.replayer-mouse) {
		width: 30px;
		height: 30px;
	}
	:global(.replayer-mouse::after) {
		content: '';
		display: inline-block;
		width: 20px;
		height: 20px;
		border-radius: 10px;
		background: #e75a3a;
		transform: translate(-10px, -10px);
		opacity: 0.3;
	}
	:global(.replayer-mouse.active::after) {
		animation: click 0.2s ease-in-out 1;
	}

	@keyframes click {
		0% {
			opacity: 0.3;
			width: 20px;
			height: 20px;
			border-radius: 10px;
			transform: translate(-10px, -10px);
		}
		50% {
			opacity: 0.5;
			width: 10px;
			height: 10px;
			border-radius: 5px;
			transform: translate(-5px, -5px);
		}
	}

	.syncit-app {
		width: 100%;
		height: 100%;
	}

	button {
		outline: none;
	}
	.syncit-btn:hover {
		background: #3399ff;
	}

	.syncit-btn,
	.syncit-btn:active {
		cursor: pointer;
		background: #0078f0;
		border: 1px solid rgba(62, 70, 82, 0.18);
		box-shadow: 0px 1px 2px rgba(184, 192, 204, 0.6);
		color: #fff;
		padding: 8px 16px;
		border-radius: 4px;
		font-size: 14px;
		line-height: 22px;
		margin-bottom: 0.5em;
	}

	.syncit-btn.ordinary {
		background: #fff;
		color: #3e4652;
		border: 1px solid rgba(129, 138, 153, 0.6);
	}
	.syncit-btn.ordinary:hover {
		background: #f5f7fa;
	}
	.syncit-btn.ordinary:active {
		background: #dfe4eb;
	}

	.syncit-btn:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}

	.syncit-center {
		width: 100%;
		height: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-direction: column;
	}

	.syncit-load-text {
		font-size: 14px;
		line-height: 22px;
		color: #3e4652;
	}

	/* .syncit-load-text h3 {
		margin: 8px 0;
	} */

	.syncit-error {
		color: #e75a3a;
	}

	.syncit-hint {
		background: rgba(245, 247, 250);
		border-radius: 4px;
		padding: 8px;
		min-width: 150px;
	}

	.syncit-toggle,
	.syncit-toggle:active {
		width: 40px;
		height: 40px;
		line-height: 40px;
		border-radius: 20px;
		padding: 0;
		align-self: flex-end;
	}

	.syncit-app-control {
		position: absolute;
		right: 1em;
		bottom: 1em;
		display: flex;
		flex-direction: column;
	}

	.syncit-metric {
		display: flex;
		align-items: center;
		margin-bottom: 8px;
	}

	.syncit-chart-title {
		font-size: 13px;
		line-height: 20px;
		color: #3e4652;
		width: 150px;
		margin-right: 8px;
	}

	.syncit-metric-line {
		flex: 1;
	}

	.align-center {
		text-align: center;
	}
</style>
