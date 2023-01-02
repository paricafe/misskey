<template>
<div ref="rootEl">
	<MkLoading v-if="fetching"/>
	<div v-else>
		<canvas ref="chartEl"></canvas>
	</div>
</div>
</template>

<script lang="ts" setup>
import { markRaw, version as vueVersion, onMounted, onBeforeUnmount, nextTick, watch } from 'vue';
import {
	Chart,
	ArcElement,
	LineElement,
	BarElement,
	PointElement,
	BarController,
	LineController,
	CategoryScale,
	LinearScale,
	TimeScale,
	Legend,
	Title,
	Tooltip,
	SubTitle,
	Filler,
} from 'chart.js';
import { enUS } from 'date-fns/locale';
import tinycolor from 'tinycolor2';
import * as os from '@/os';
import 'chartjs-adapter-date-fns';
import { defaultStore } from '@/store';
import { useChartTooltip } from '@/scripts/use-chart-tooltip';
import { MatrixController, MatrixElement } from 'chartjs-chart-matrix';
import { chartVLine } from '@/scripts/chart-vline';
import { alpha } from '@/scripts/color';

Chart.register(
	ArcElement,
	LineElement,
	BarElement,
	PointElement,
	BarController,
	LineController,
	CategoryScale,
	LinearScale,
	TimeScale,
	Legend,
	Title,
	Tooltip,
	SubTitle,
	Filler,
	MatrixController, MatrixElement,
);

const props = defineProps<{
	src: string;
}>();

const rootEl = $ref<HTMLDivElement>(null);
const chartEl = $ref<HTMLCanvasElement>(null);
const now = new Date();
let chartInstance: Chart = null;
let fetching = $ref(true);

const { handler: externalTooltipHandler } = useChartTooltip({
	position: 'middle',
});

async function renderChart() {
	if (chartInstance) {
		chartInstance.destroy();
	}

	const wide = rootEl.offsetWidth > 700;
	const narrow = rootEl.offsetWidth < 400;

	const weeks = wide ? 50 : narrow ? 10 : 25;
	const chartLimit = 7 * weeks;

	const getDate = (ago: number) => {
		const y = now.getFullYear();
		const m = now.getMonth();
		const d = now.getDate();

		return new Date(y, m, d - ago);
	};

	const format = (arr) => {
		return arr.map((v, i) => {
			const dt = getDate(i);
			const iso = `${dt.getFullYear()}-${(dt.getMonth() + 1).toString().padStart(2, '0')}-${dt.getDate().toString().padStart(2, '0')}`;
			return {
				x: iso,
				y: dt.getDay(),
				d: iso,
				v,
			};
		});
	};

	let values;

	if (props.src === 'active-users') {
		const raw = await os.api('charts/active-users', { limit: chartLimit, span: 'day' });
		values = raw.readWrite;
	} else if (props.src === 'notes') {
		const raw = await os.api('charts/notes', { limit: chartLimit, span: 'day' });
		values = raw.local.inc;
	} else if (props.src === 'ap-requests-inbox-received') {
		const raw = await os.api('charts/ap-request', { limit: chartLimit, span: 'day' });
		values = raw.inboxReceived;
	} else if (props.src === 'ap-requests-deliver-succeeded') {
		const raw = await os.api('charts/ap-request', { limit: chartLimit, span: 'day' });
		values = raw.deliverSucceeded;
	} else if (props.src === 'ap-requests-deliver-failed') {
		const raw = await os.api('charts/ap-request', { limit: chartLimit, span: 'day' });
		values = raw.deliverFailed;
	}

	fetching = false;

	await nextTick();

	const gridColor = defaultStore.state.darkMode ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)';

	// フォントカラー
	Chart.defaults.color = getComputedStyle(document.documentElement).getPropertyValue('--fg');

	const color = defaultStore.state.darkMode ? '#b4e900' : '#86b300';

	// 視覚上の分かりやすさのため上から最も大きい3つの値の平均を最大値とする
	const max = values.slice().sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0) / 3;

	const min = Math.max(0, Math.min(...values) - 1);

	const marginEachCell = 4;

	chartInstance = new Chart(chartEl, {
		type: 'matrix',
		data: {
			datasets: [{
				label: 'Read & Write',
				data: format(values),
				pointRadius: 0,
				borderWidth: 0,
				borderJoinStyle: 'round',
				borderRadius: 3,
				backgroundColor(c) {
					const value = c.dataset.data[c.dataIndex].v;
					let a = (value - min) / max;
					if (value !== 0) { // 0でない限りは完全に不可視にはしない
						a = Math.max(a, 0.05);
					}
					return alpha(color, a);
				},
				fill: true,
				width(c) {
					const a = c.chart.chartArea ?? {};
					return (a.right - a.left) / weeks - marginEachCell;
				},
				height(c) {
					const a = c.chart.chartArea ?? {};
					return (a.bottom - a.top) / 7 - marginEachCell;
				},
			}],
		},
		options: {
			aspectRatio: wide ? 6 : narrow ? 1.8 : 3.2,
			layout: {
				padding: {
					left: 8,
					right: 0,
					top: 0,
					bottom: 0,
				},
			},
			scales: {
				x: {
					type: 'time',
					offset: true,
					position: 'bottom',
					time: {
						unit: 'week',
						round: 'week',
						isoWeekday: 0,
						displayFormats: {
							week: 'MMM dd',
						},
					},
					grid: {
						display: false,
						color: gridColor,
						borderColor: 'rgb(0, 0, 0, 0)',
					},
					ticks: {
						display: true,
						maxRotation: 0,
						autoSkipPadding: 8,
					},
				},
				y: {
					offset: true,
					reverse: true,
					position: 'right',
					grid: {
						display: false,
						color: gridColor,
						borderColor: 'rgb(0, 0, 0, 0)',
					},
					ticks: {
						maxRotation: 0,
						autoSkip: true,
						padding: 1,
						font: {
							size: 9,
						},
						callback: (value, index, values) => ['', 'Mon', '', 'Wed', '', 'Fri', ''][value],
					},
				},
			},
			animation: false,
			plugins: {
				legend: {
					display: false,
				},
				tooltip: {
					enabled: false,
					callbacks: {
						title(context) {
							const v = context[0].dataset.data[context[0].dataIndex];
							return v.d;
						},
						label(context) {
							const v = context.dataset.data[context.dataIndex];
							return ['Active: ' + v.v];
						},
					},
					//mode: 'index',
					animation: {
						duration: 0,
					},
					external: externalTooltipHandler,
				},
			},
		},
	});
}

watch(() => props.src, () => {
	fetching = true;
	renderChart();
});

onMounted(async () => {
	renderChart();
});
</script>